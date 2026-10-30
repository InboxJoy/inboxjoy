import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { UNHEALTHY_MAILBOX_STATES, type MailboxHealthState } from "./delivery/can-send.js";

export const sequenceMailboxIdsSchema = z.preprocess(
  (value) => Array.isArray(value) ? [...new Set(value)] : value,
  z.array(z.string().uuid()).max(50),
);

export async function readSequenceMailboxIds(db: Pick<InboxJoyDb, "select">, workspaceId: string, sequenceId: string): Promise<string[]> {
  const rows = await db.select({ emailAccountId: schema.sequenceEmailAccounts.emailAccountId })
    .from(schema.sequenceEmailAccounts)
    .where(and(eq(schema.sequenceEmailAccounts.workspaceId, workspaceId), eq(schema.sequenceEmailAccounts.sequenceId, sequenceId)))
    .orderBy(schema.sequenceEmailAccounts.emailAccountId);
  return rows.map((row) => row.emailAccountId);
}

export function isSendableSequenceMailbox(mailbox: { status: string; email: string | null; healthState: string | null }): boolean {
  return mailbox.status === "active" && mailbox.email !== null
    && (!mailbox.healthState || !UNHEALTHY_MAILBOX_STATES.has(mailbox.healthState as MailboxHealthState));
}
