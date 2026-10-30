import type { TransactionalEmailService } from "@inboxjoy/email";

import { logger } from "./logger.js";

// Any query-capable handle: a pg Pool or a checked-out PoolClient both satisfy this,
// so notify helpers can be used from inside an open transaction (via the client) or
// from a top-level job (via the pool) without caring which one they got.
export type QueryExecutor = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type NotifyDeps = {
  pool: QueryExecutor;
  transactionalEmail?: TransactionalEmailService;
};

// Mailbox health states that block sending (mirrors packages/core's
// UNHEALTHY_MAILBOX_STATES minus "degraded", which does not block sending).
export const NON_SENDING_HEALTH_STATES = new Set([
  "disconnected",
  "auth_error",
  "throttled",
  "quota_exceeded",
  "reputation_warning",
  "critical",
  "paused",
]);

const MAILBOX_ALERT_REASONS: Record<string, string> = {
  disconnected: "The connection to this mailbox expired.",
  auth_error: "The connection to this mailbox expired.",
  throttled: "Too many delivery failures, so sending was paused to protect your reputation.",
  quota_exceeded: "The provider's sending quota for this mailbox was reached.",
  reputation_warning: "Delivery problems suggest this mailbox needs attention.",
};

export function mailboxAlertReasonSentence(state: string): string {
  return MAILBOX_ALERT_REASONS[state] ?? "This mailbox is not currently able to send.";
}

// e.g. "15 September 2026" — matches apps/api's billing email date format.
export function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

async function safeSend(kind: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    logger.warn(`Failed to send ${kind} email`, { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function getWorkspaceOwner(pool: QueryExecutor, workspaceId: string): Promise<{ email: string; name: string | null } | null> {
  const result = await pool.query<{ email: string; display_name: string | null }>(
    `SELECT u.email, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 AND m.role = 'owner' AND m.status = 'active'
     ORDER BY m.created_at ASC LIMIT 1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row ? { email: row.email, name: row.display_name } : null;
}

export async function notifyMailboxAlert(deps: NotifyDeps, input: { workspaceId: string; mailboxEmail: string; state: string }): Promise<void> {
  if (!deps.transactionalEmail?.enabled) return;
  const transactionalEmail = deps.transactionalEmail;
  await safeSend("mailbox alert", async () => {
    const owner = await getWorkspaceOwner(deps.pool, input.workspaceId);
    if (!owner) return;
    await transactionalEmail.sendMailboxAlert({
      recipient: { email: owner.email, name: owner.name },
      mailboxEmail: input.mailboxEmail,
      reasonSentence: mailboxAlertReasonSentence(input.state),
    });
  });
}

export async function notifyCampaignCompleted(deps: NotifyDeps, input: { workspaceId: string; campaignId: string; campaignName: string; previousCompletedAt: Date | null }): Promise<void> {
  if (!deps.transactionalEmail?.enabled) return;
  if (input.previousCompletedAt && Date.now() - input.previousCompletedAt.getTime() <= 86_400_000) return;
  const transactionalEmail = deps.transactionalEmail;
  await safeSend("campaign completed", async () => {
    const owner = await getWorkspaceOwner(deps.pool, input.workspaceId);
    if (!owner) return;
    const stats = await deps.pool.query<{ sent: string; opened: string; replied: string }>(
      `SELECT
         (SELECT count(*) FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = $1 AND m.status = 'accepted')::text AS sent,
         (SELECT count(DISTINCT me.message_id) FROM message_events me JOIN messages m ON m.id = me.message_id JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = $1 AND me.event_type = 'opened')::text AS opened,
         (SELECT count(*) FROM enrollments WHERE campaign_id = $1 AND status = 'replied')::text AS replied`,
      [input.campaignId],
    );
    const row = stats.rows[0];
    await transactionalEmail.sendCampaignCompleted({
      recipient: { email: owner.email, name: owner.name },
      campaignName: input.campaignName,
      campaignId: input.campaignId,
      sent: Number(row?.sent ?? 0),
      opened: Number(row?.opened ?? 0),
      replied: Number(row?.replied ?? 0),
    });
  });
}

export async function notifyReplyReceived(deps: NotifyDeps, enrollmentId: string): Promise<void> {
  if (!deps.transactionalEmail?.enabled) return;
  const transactionalEmail = deps.transactionalEmail;
  await safeSend("reply received", async () => {
    const result = await deps.pool.query<{
      workspace_id: string;
      campaign_id: string | null;
      campaign_name: string | null;
      contact_first_name: string | null;
      contact_last_name: string | null;
      contact_email: string;
      mailbox_email: string | null;
    }>(
      `SELECT e.workspace_id, e.campaign_id, ca.name AS campaign_name,
              c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.email AS contact_email,
              ea.email AS mailbox_email
       FROM enrollments e
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN campaigns ca ON ca.id = e.campaign_id
       JOIN email_accounts ea ON ea.id = e.email_account_id
       WHERE e.id = $1`,
      [enrollmentId],
    );
    const row = result.rows[0];
    // Reply-received emails only make sense for campaign sends (the email links to
    // /app/sequences/:campaignId); a bare sequence enrollment without a campaign has
    // nothing to populate campaignName/campaignId with, so it's skipped.
    if (!row?.campaign_id || !row.campaign_name) return;
    const owner = await getWorkspaceOwner(deps.pool, row.workspace_id);
    if (!owner) return;
    const contactLabel = [row.contact_first_name, row.contact_last_name].filter(Boolean).join(" ").trim() || row.contact_email;
    await transactionalEmail.sendReplyReceived({
      recipient: { email: owner.email, name: owner.name },
      contactLabel,
      campaignName: row.campaign_name,
      campaignId: row.campaign_id,
      mailboxEmail: row.mailbox_email ?? "your inbox",
    });
  });
}
