import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { extractMailboxCandidateEmails, record, type DeliveryStatusBounce } from "./classify.js";
import { sanitizeStoredStrings } from "./sanitize.js";
import { writeInboundEvent } from "./write-reply.js";

export type InboundEvent = {
  provider: "composio" | "imap";
  eventId: string;
  logId?: string;
  payloadHash: string;
  payload: unknown;
  data: Record<string, unknown>;
  eventType?: string;
  triggerSlug?: string;
  accountId?: string;
  timestamp?: string;
  bounce?: DeliveryStatusBounce[];
};

export type IngestOptions = {
  onAccountExpired?: (accountId: string) => void | Promise<void>;
  // Built from core's applySuppression so a reply opt-out goes through the exact
  // same path as the one-click footer link: suppression row, contact suppressed,
  // every live enrollment across all campaigns stopped, pending messages cancelled.
  // It resolves with the suppression it wrote, and must throw (or resolve
  // null/undefined) when nothing was suppressed: the reply writer then stops the
  // sequence itself instead of trusting a cascade that never ran.
  applySuppression?: (input: { workspaceId: string; normalizedEmail: string; email: string; reason: string; source: string; contactId?: string }) => Promise<unknown>;
  logger?: {
    error: (context: Record<string, unknown>, message: string) => void;
    info: (context: Record<string, unknown>, message: string) => void;
  };
};

export async function ingestInboundEvent(
  db: InboxJoyDb,
  input: InboundEvent,
  options: IngestOptions = {},
): Promise<{ received: true; duplicate: boolean }> {
  // Sanitized once, up front, so the stored webhook row and every reply, bounce
  // and suppression written from this event see the same storable strings. One
  // message that Postgres refuses would otherwise fail on every IMAP poll and
  // hold that mailbox's cursor behind it forever.
  const event: InboundEvent = {
    ...input,
    payload: sanitizeStoredStrings(input.payload),
    data: sanitizeStoredStrings(input.data),
    bounce: sanitizeStoredStrings(input.bounce),
  };
  const { eventId, logId, accountId, timestamp } = event;
  const payload = record(event.payload);
  const data = event.data;

  const account = accountId ? (await db.select().from(schema.emailAccounts).where(event.provider === "imap"
    ? and(eq(schema.emailAccounts.id, accountId), eq(schema.emailAccounts.provider, "smtp"))
    : eq(schema.emailAccounts.composioConnectedAccountId, accountId)))[0] : undefined;
  const fallbackAccount = !account && event.provider !== "imap" ? await (async () => {
    const mailboxEmails = extractMailboxCandidateEmails(data);
    if (!mailboxEmails.length) return undefined;
    const matches = await db.select().from(schema.emailAccounts).where(inArray(schema.emailAccounts.normalizedEmail, mailboxEmails)).limit(2);
    return matches.length === 1 ? matches[0] : undefined;
  })() : undefined;
  const webhookAccount = account ?? fallbackAccount;
  const [created] = await db.insert(schema.providerWebhookEvents).values({
    id: randomUUID(),
    workspaceId: webhookAccount?.workspaceId,
    provider: event.provider,
    eventId,
    logId,
    signatureTimestamp: timestamp ? new Date(Number(timestamp) * 1000) : undefined,
    payloadHash: event.payloadHash,
    status: "received",
    payload,
  }).onConflictDoNothing().returning();

  if (!created) {
    const existing = (await db.select().from(schema.providerWebhookEvents).where(
      and(eq(schema.providerWebhookEvents.provider, event.provider), or(eq(schema.providerWebhookEvents.eventId, eventId), ...(logId ? [eq(schema.providerWebhookEvents.logId, logId)] : []))),
    ))[0];
    if (existing?.status === "processed" || existing?.status === "ignored") return { received: true, duplicate: true };
  }

  try {
    await writeInboundEvent(db, event, webhookAccount, options);
    await db.update(schema.providerWebhookEvents).set({ status: "processed", processedAt: new Date(), workspaceId: webhookAccount?.workspaceId }).where(and(eq(schema.providerWebhookEvents.provider, event.provider), eq(schema.providerWebhookEvents.eventId, eventId)));
    return { received: true, duplicate: !created };
  } catch (error) {
    await db.update(schema.providerWebhookEvents).set({ status: "failed", errorClass: error instanceof Error ? error.name : "WebhookProcessingError" }).where(and(eq(schema.providerWebhookEvents.provider, event.provider), eq(schema.providerWebhookEvents.eventId, eventId)));
    throw error;
  }
}
