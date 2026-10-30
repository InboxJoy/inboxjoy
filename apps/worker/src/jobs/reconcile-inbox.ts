import { createComposioClient, type ComposioClient } from "@inboxjoy/composio";
import { createDb } from "@inboxjoy/db";
import { assertComposioProvider, reconcileCampaignStatus, type MailboxProvider } from "@inboxjoy/core";
import type { ReconcileInboxJob } from "@inboxjoy/queue";
import type { Pool } from "pg";

import { logger } from "../logger.js";
import { createMailClientResolver, type MailClientFor } from "../mail-client.js";
import { completeAcceptedBookkeeping, recordAccepted } from "./send-message.js";

type Dependencies = { pool: Pool; composioApiKey?: string; toolkitVersion?: string; apiBaseUrl?: string; authSecret?: string; composio?: ComposioClient; mailClientFor?: MailClientFor; mailboxCredentialsKeys?: Map<number, Buffer> };
type UnknownMessage = {
  id: string; workspace_id: string; enrollment_id: string; sequence_step_id: string; email_account_id: string; contact_id: string;
  recipient_email: string; normalized_recipient_email: string; subject: string; idempotency_key: string; metadata: Record<string, unknown> | null;
  provider_message_id: string | null; provider_thread_id: string | null; provider: MailboxProvider; composio_connected_account_id: string;
  daily_limit: number; hourly_limit: number; ramp_started_on: string | null; ramp_paused_days: number; workspace_daily_cap: number; status: string;
  postal_address: string | null; mailbox_email: string | null; campaign_id: string | null;
};

export async function reconcileInbox(payload: ReconcileInboxJob, deps?: Dependencies): Promise<void> {
  if (!deps?.apiBaseUrl || !deps.authSecret) return;
  const composio = deps.composio ?? createComposioClient(deps.composioApiKey, undefined, deps.toolkitVersion);
  const mailClientFor = deps.mailClientFor ?? createMailClientResolver({ db: createDb(deps.pool), keys: deps.mailboxCredentialsKeys, composio }).getMailClientFor;
  const result = await deps.pool.query<UnknownMessage>(`SELECT m.id,m.workspace_id,m.enrollment_id,m.sequence_step_id,m.email_account_id,m.contact_id,
      m.recipient_email,m.normalized_recipient_email,m.subject,m.idempotency_key,m.metadata,m.provider_message_id,m.provider_thread_id,
      m.status,ea.provider,ea.composio_connected_account_id,ea.email AS mailbox_email,ea.daily_limit,ea.hourly_limit,ea.ramp_started_on,ea.ramp_paused_days,
      w.daily_send_cap AS workspace_daily_cap,w.postal_address,e.campaign_id
    FROM messages m JOIN enrollments e ON e.id=m.enrollment_id JOIN email_accounts ea ON ea.id=m.email_account_id JOIN workspaces w ON w.id=m.workspace_id
    WHERE ((e.status='paused' AND e.stop_reason='provider_result_unknown' AND m.status='failed' AND m.error_class='unknown_provider_result')
      OR (m.status='accepted' AND m.metadata->>'acceptanceBookkeepingPending'='true'))
      ${payload.workspaceId ? "AND m.workspace_id=$1" : ""} ${payload.mailboxId ? `AND m.email_account_id=$${payload.workspaceId ? 2 : 1}` : ""}
    ORDER BY m.updated_at ASC LIMIT 500`, [payload.workspaceId, payload.mailboxId].filter((value): value is string => Boolean(value)));

  let reconciled = 0;
  for (const message of result.rows) {
    if (message.provider !== "smtp" && !composio.enabled) continue;
    const client = await deps.pool.connect();
    try {
      if (message.status === "accepted") {
        if (await completeAcceptedBookkeeping(client, message, deps)) reconciled += 1;
        continue;
      }
      let outcome: "sent" | "not_sent" | "unknown" = "sent";
      if (!message.provider_message_id) {
        if (message.provider !== "smtp") assertComposioProvider(message.provider, "reconcile-inbox.findSentMessage");
        const mailClient = await mailClientFor({ provider: message.provider, emailAccountId: message.email_account_id });
        const attemptedAt = typeof message.metadata?.providerAttemptedAt === "string" ? new Date(message.metadata.providerAttemptedAt) : undefined;
        outcome = await mailClient.findSentMessage({ connectedAccountId: message.composio_connected_account_id, provider: message.provider, recipientEmail: message.recipient_email, subject: message.subject, messageId: typeof message.metadata?.providerRfcMessageId === "string" ? message.metadata.providerRfcMessageId : undefined, after: attemptedAt });
      }
      if (outcome === "sent") {
        const attempt = await client.query<{ attempt_number: number }>("SELECT attempt_number FROM send_attempts WHERE message_id=$1 ORDER BY attempt_number DESC LIMIT 1", [message.id]);
        const rfcMessageId = message.provider === "smtp" && typeof message.metadata?.providerRfcMessageId === "string" ? message.metadata.providerRfcMessageId : undefined;
        const rfcThreadId = message.provider === "smtp" && typeof message.metadata?.providerRfcThreadId === "string" ? message.metadata.providerRfcThreadId : rfcMessageId;
        await recordAccepted(client, message, attempt.rows[0]?.attempt_number ?? 1, { providerMessageId: message.provider_message_id ?? rfcMessageId, providerThreadId: message.provider_thread_id ?? rfcThreadId }, deps);
        reconciled += 1;
      } else if (outcome === "not_sent") {
        await client.query("BEGIN");
        try {
          if (message.campaign_id) await client.query("SELECT id FROM campaigns WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [message.workspace_id, message.campaign_id]);
          await client.query("UPDATE messages SET status='failed',claim_expires_at=NULL,error_class='provider_not_sent',error_message='Provider reconciliation confirmed no message was sent',updated_at=now() WHERE id=$1 AND error_class='unknown_provider_result'", [message.id]);
          await client.query("UPDATE enrollments SET status='cancelled',stopped_at=now(),stop_reason='provider_not_sent',updated_at=now() WHERE id=$1 AND status='paused' AND stop_reason='provider_result_unknown'", [message.enrollment_id]);
          if (message.campaign_id) await reconcileCampaignStatus(client, { workspaceId: message.workspace_id, campaignId: message.campaign_id });
          await client.query("COMMIT"); reconciled += 1;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    } catch (error) {
      logger.error("Message reconciliation failed", { messageId: message.id, error: error instanceof Error ? error.message : String(error) });
    } finally { client.release(); }
  }
  logger.info("Reconciled unknown provider results", { job: "reconcile-inbox", workspaceId: payload.workspaceId, mailboxId: payload.mailboxId, reconciled });
}
