import { ComposioRequestError, createComposioClient, type ComposioClient, type FetchedReply } from "@inboxjoy/composio";
import {
  assertComposioProvider,
  canSend,
  freePlanMonthlySendsSql,
  providerCircuitKey,
  providerCircuitKeySql,
  reconcileCampaignStatus,
  renderTemplate,
  type CampaignStatusResult,
  type LeadVariableSource,
  type RenderOptions,
  followUpSendJitterMs,
  mailboxHealthAfterFailure,
  mailboxHealthAfterSuccess,
  PROVIDER_CIRCUIT_FAILURE_THRESHOLD,
  rfcMessageId,
  sendingPlan,
  type CanSendContext,
  type DenyReason,
  type Edition,
  type MailboxFailureKind,
  type MailboxHealthSnapshot,
  type MailboxProvider,
  type MailClient,
} from "@inboxjoy/core";
import { createDb } from "@inboxjoy/db";
import { ImapError, SmtpSendError } from "@inboxjoy/smtp";
import { appendUnsubscribeFooter, createUnsubscribeToken, renderEmailHtml, type TransactionalEmailService } from "@inboxjoy/email";

export { renderEmailHtml };
import type { SendMessageJob } from "@inboxjoy/queue";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { logger } from "../logger.js";
import { createMailClientResolver, type MailClientFor } from "../mail-client.js";
import { NON_SENDING_HEALTH_STATES, notifyCampaignCompleted, notifyMailboxAlert, notifyReplyReceived } from "../notify.js";

type Dependencies = { pool: Pool; composioApiKey?: string; toolkitVersion?: string; apiBaseUrl?: string; authSecret?: string; composio?: ComposioClient; mailClientFor?: MailClientFor; mailboxCredentialsKeys?: Map<number, Buffer>; transactionalEmail?: TransactionalEmailService };
// The send path also needs the edition: the plan gate, the footer and the
// Message-ID domain depend on it. Required so a missing wire-up cannot default.
export type SendMessageDependencies = Dependencies & { edition: Edition };

export type ClaimedMessage = {
  id: string;
  workspace_id: string;
  enrollment_id: string;
  sequence_step_id: string;
  email_account_id: string;
  contact_id: string;
  recipient_email: string;
  normalized_recipient_email: string;
  subject: string;
  tracking_token?: string;
  campaign_id?: string | null;
  metadata: Record<string, unknown> | null;
  provider: MailboxProvider;
  composio_connected_account_id: string;
  daily_limit: number;
  hourly_limit: number;
  ramp_started_on: string | null;
  ramp_paused_days: number;
  workspace_daily_cap: number;
  postal_address: string | null;
  // Set at claim time: legacy Free sends carry the "Sent via InboxJoy" footer.
  sent_via?: boolean;
  // Workspace setting, off by default: only then does the email carry the open-tracking image.
  open_tracking_enabled?: boolean;
  mailbox_email: string | null;
  previous_provider_thread_id?: string | null;
  previous_accepted_at?: Date | null;
  previous_rfc_message_id?: string | null;
};

type DeliveryMessage = ClaimedMessage & {
  sequence_id: string;
  mailbox_user_id: string;
};

type DeliveryDecisionRow = DeliveryMessage & {
  gate_now: Date;
  owner_email_verified: boolean;
  workspace_status: string;
  kill_switch_enabled: boolean;
  campaign_status: string | null;
  sequence_status: string;
  enrollment_status: string;
  mailbox_status: string;
  suppressed: boolean;
  already_replied: boolean;
  mailbox_today: string;
  mailbox_hour: string;
  mailbox_last_send_at?: Date | null;
  workspace_today: string;
  workspace_month: string;
  legacy_free_until: Date | null;
  subscription_status: string | null;
  subscription_trial_end: Date | null;
  subscription_on_hold_grace_ends_at: Date | null;
  in_sending_window: boolean;
  health_state: string | null;
  effective_daily_limit: number | null;
  health_consecutive_failures: number | null;
  health_temp_failures_24h: number | null;
  health_perm_failures_24h: number | null;
  throttled_until: Date | null;
  circuit_state: string | null;
  circuit_failure_count: number | null;
  next_probe_at: Date | null;
  attempt_count: string;
};

const SEND_MIN_GAP_MS = 30_000;

type ManualReplyEventSqlOptions = {
  aggregate: "count" | "latest";
  workspaceIdSql: string;
  emailAccountIdSql?: string;
  range?: "today" | "last_hour";
  nowSql?: string;
};

export function manualReplyEventSql(options: ManualReplyEventSqlOptions): string {
  const aggregateSql = options.aggregate === "count" ? "count(*)" : "max(manual_reply_event.occurred_at)";
  const mailboxSql = options.emailAccountIdSql
    ? ` AND manual_reply_event.metadata->>'emailAccountId'=${options.emailAccountIdSql}::text`
    : "";
  const nowSql = options.nowSql ?? "now()";
  const rangeSql = options.range === "today"
    ? ` AND manual_reply_event.occurred_at::date=(${nowSql} AT TIME ZONE 'UTC')::date`
    : options.range === "last_hour"
      ? ` AND manual_reply_event.occurred_at>${nowSql}-interval '1 hour'`
      : "";
  return `(SELECT ${aggregateSql} FROM message_events manual_reply_event
    WHERE manual_reply_event.workspace_id=${options.workspaceIdSql}
      AND manual_reply_event.event_type IN ('manual_reply_pending','manual_reply_sent')${mailboxSql}${rangeSql})`;
}

export class MessagePreparationError extends Error {
  override readonly name = "MessagePreparationError";
}

type MailboxHealthRow = {
  state: string;
  effective_daily_limit: number | null;
  consecutive_failures: number;
  temp_failures_24h: number;
  perm_failures_24h: number;
  throttled_until: Date | null;
};

// Maps a snake_case database row (contacts columns, optional custom_fields and
// campaign_variables JSON) onto the shared template-variable source.
export function variableSourceFromRow(contact: Record<string, unknown>): LeadVariableSource {
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return {
    firstName: contact.first_name as string | null | undefined,
    lastName: contact.last_name as string | null | undefined,
    company: contact.company as string | null | undefined,
    title: contact.title as string | null | undefined,
    email: contact.email as string | null | undefined,
    customFields: object(contact.custom_fields),
    campaignVariables: object(contact.campaign_variables),
  };
}

export function render(value: string, contact: Record<string, unknown>, options: RenderOptions = {}): string {
  return renderTemplate(value, variableSourceFromRow(contact), options).text;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class ReplyPersistenceError extends Error {
  constructor(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    super(`Reply persistence temporarily unavailable: ${detail}`);
    this.name = "ReplyPersistenceError";
  }
}

export async function persistProviderReply(pool: Pool, message: DeliveryMessage, reply: FetchedReply): Promise<void> {
  const receivedAt = reply.receivedAt ?? new Date();
  const snippet = reply.bodyText?.replace(/\s+/g, " ").trim().slice(0, 320) || null;
  const fallbackKey = [
    message.email_account_id,
    message.contact_id,
    reply.providerThreadId ?? "",
    (reply.from ?? message.normalized_recipient_email).toLowerCase(),
    reply.subject ?? "",
    reply.bodyText ?? "",
  ].join("|");
  const eventId = `provider-reply:${hash(reply.providerMessageId ?? fallbackKey)}`;

  await pool.query(`
    INSERT INTO replies (
      id,workspace_id,contact_id,enrollment_id,sequence_id,email_account_id,
      in_reply_to_message_id,provider_message_id,provider_thread_id,subject,
      body_text,snippet,from_email,received_at,source,metadata
    )
    SELECT $1,$2,$3,$4,$5,$6,prior.id,$7,$8,$9,$10,$11,$12,$13,'backfill',$14::jsonb
    FROM LATERAL (
      SELECT id FROM messages
      WHERE enrollment_id=$4 AND status='accepted'
      ORDER BY accepted_at DESC NULLS LAST,created_at DESC
      LIMIT 1
    ) prior
    WHERE NOT EXISTS (
      SELECT 1 FROM replies existing
      WHERE existing.workspace_id=$2 AND existing.contact_id=$3
        AND (existing.provider_message_id=$7 OR ($7::text IS NULL
          AND existing.enrollment_id=$4
          AND COALESCE(existing.provider_thread_id,'')=COALESCE($8,'')
          AND COALESCE(existing.body_text,'')=COALESCE($10,'')))
    )
    ON CONFLICT DO NOTHING
  `, [
    randomUUID(), message.workspace_id, message.contact_id, message.enrollment_id,
    message.sequence_id, message.email_account_id,
    reply.providerMessageId ?? null, reply.providerThreadId ?? null, reply.subject ?? null,
    reply.bodyText ?? null, snippet, reply.from ?? message.normalized_recipient_email,
    receivedAt, JSON.stringify({ provider: message.provider, source: "send_fallback" }),
  ]);
  await pool.query(`
    INSERT INTO message_events (id,workspace_id,message_id,event_type,provider_event_id,occurred_at,metadata)
    SELECT $1,$2,prior.id,'replied',$3,$4,$5::jsonb
    FROM LATERAL (
      SELECT id FROM messages
      WHERE enrollment_id=$6 AND status='accepted'
      ORDER BY accepted_at DESC NULLS LAST,created_at DESC
      LIMIT 1
    ) prior
    ON CONFLICT DO NOTHING
  `, [
    randomUUID(), message.workspace_id, eventId, receivedAt,
    JSON.stringify({ sender: reply.from ?? message.normalized_recipient_email, emailAccountId: message.email_account_id, provider: message.provider, providerThreadId: reply.providerThreadId ?? null, source: "send_fallback" }),
    message.enrollment_id,
  ]);
}


export type ClassifiedSendError = {
  kind: "retryable" | "permanent" | "unknown" | "mailbox";
  message: string;
  status?: number;
  body?: unknown;
  retryAfter?: Date;
  providerFailure: boolean;
  ambiguousProviderResult?: boolean;
};

function sanitizeProviderDetail(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value
      .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
      .replace(/((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => sanitizeProviderDetail(item, depth + 1));
  if (typeof value === "object") {
    const safeKeys = new Set(["code", "error", "errors", "message", "detail", "details", "status", "type"]);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => safeKeys.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizeProviderDetail(item, depth + 1)])
      .filter(([, item]) => item !== undefined));
  }
  return undefined;
}

export function sanitizedComposioErrorMessage(error: ComposioRequestError): string {
  const sanitized = sanitizeProviderDetail(error.body);
  const detail = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return detail && detail !== "{}" && detail !== "[]"
    ? `${error.message}: ${detail}`.slice(0, 1000)
    : error.message;
}

export function errorClass(error: unknown): ClassifiedSendError {
  if (error instanceof SmtpSendError) {
    const status = error.responseCode;
    // MAIL FROM and RCPT TO failures share stage "mail"; fold the command into
    // the persisted message so the repeated-failure guard below (and anyone
    // reading error_message) can tell a sender-side MAIL rejection apart from a
    // per-recipient RCPT rejection with the same response code.
    const commandSuffix = error.stage === "mail" && error.command ? ` [${error.command}]` : "";
    const details = { message: `SMTP ${error.stage === "auth" ? "authentication" : error.stage} failed${status === undefined ? "" : ` (${status})`}${commandSuffix}`, status, providerFailure: false };
    if (status !== undefined && status >= 400 && status < 500) return { kind: "retryable", ...details, providerFailure: true };
    if ((error.stage === "auth" && status !== undefined && status >= 500) || (status !== undefined && [535, 534, 530, 538].includes(status)) || (status === undefined && error.stage === "auth" && error.code === "EAUTH")) return { kind: "mailbox", ...details };
    if (status !== undefined && status >= 500) return { kind: "permanent", ...details, providerFailure: true };
    if (error.stage === "connect") return { kind: "retryable", ...details, providerFailure: true };
    if (error.stage === "data") {
      return { kind: "unknown", ...details, providerFailure: true, ambiguousProviderResult: true };
    }
    if (error.stage === "auth") return { kind: "retryable", ...details, providerFailure: true };
    return { kind: "permanent", ...details };
  }
  if (error instanceof ImapError) {
    const details = { message: `IMAP ${error.stage === "auth" ? "authentication" : error.stage} failed`, providerFailure: false };
    if (error.stage === "auth") return { kind: "mailbox", ...details };
    return { kind: "retryable", message: details.message, providerFailure: true };
  }
  const message = error instanceof ComposioRequestError
    ? sanitizedComposioErrorMessage(error)
    : error instanceof Error ? error.message : String(error);
  if (error instanceof ComposioRequestError) {
    const details = { message, status: error.status, body: sanitizeProviderDetail(error.body), retryAfter: error.retryAfter, providerFailure: false };
    if (error.status === 401 || error.status === 403) return { kind: "mailbox", ...details };
    if (error.status === 408) return { kind: "retryable", ...details, providerFailure: true, ambiguousProviderResult: true };
    if (error.status === 425 || error.status === 429) return { kind: "retryable", ...details, providerFailure: true };
    if (error.status >= 500) return { kind: "unknown", ...details, providerFailure: true, ambiguousProviderResult: true };
    return { kind: "permanent", ...details };
  }
  if (/timeout|timed out|abort|socket hang up|econnreset|rate.?limit|temporar|unavailable|overloaded/i.test(message)) {
    const ambiguousProviderResult = /timeout|timed out|abort|socket hang up|econnreset/i.test(message);
    return { kind: "retryable", message, providerFailure: true, ambiguousProviderResult };
  }
  return { kind: "permanent", message, providerFailure: false };
}

function deliveryContext(row: DeliveryDecisionRow, edition: Edition, probeAllowed = false): CanSendContext {
  const now = row.gate_now ? new Date(row.gate_now) : new Date();
  return {
    now,
    edition,
    ownerEmailVerified: row.owner_email_verified,
    workspace: {
      status: row.workspace_status,
      killSwitchEnabled: row.kill_switch_enabled,
      postalAddress: row.postal_address,
      dailySendCap: row.workspace_daily_cap,
      sentToday: Number(row.workspace_today),
      sentThisMonth: Number(row.workspace_month),
      legacyFreeUntil: row.legacy_free_until ? new Date(row.legacy_free_until) : null,
    },
    subscription: row.subscription_status ? {
      status: row.subscription_status,
      trialEnd: row.subscription_trial_end ? new Date(row.subscription_trial_end) : null,
      onHoldGraceEndsAt: row.subscription_on_hold_grace_ends_at ? new Date(row.subscription_on_hold_grace_ends_at) : null,
    } : null,
    mailbox: {
      status: row.mailbox_status,
      dailyLimit: row.daily_limit,
      hourlyLimit: row.hourly_limit,
      rampStartedOn: row.ramp_started_on,
      rampPausedDays: row.ramp_paused_days,
      sentToday: Number(row.mailbox_today),
      sentLastHour: Number(row.mailbox_hour),
      inSendingWindow: row.in_sending_window,
      nextAllowedAt: row.mailbox_last_send_at ? new Date(new Date(row.mailbox_last_send_at).getTime() + SEND_MIN_GAP_MS) : null,
    },
    health: row.health_state ? {
      state: row.health_state,
      effectiveDailyLimit: row.effective_daily_limit,
      throttledUntil: row.throttled_until ? new Date(row.throttled_until) : null,
    } : null,
    providerCircuit: row.circuit_state ? {
      state: row.circuit_state,
      nextProbeAt: row.next_probe_at ? new Date(row.next_probe_at) : null,
      probeAllowed,
    } : null,
  };
}

async function recordDenial(client: PoolClient, message: DeliveryDecisionRow, reason: DenyReason, retryAt?: Date): Promise<{ replyTransitioned: boolean }> {
  const terminal = !retryAt;
  await client.query(`UPDATE messages SET status=$2, blocked_reason=$3,
    scheduled_at=COALESCE($4::timestamptz,scheduled_at),claimed_at=NULL,claim_expires_at=NULL,updated_at=now()
    WHERE id=$1`, [message.id, terminal ? "cancelled" : "scheduled", reason, retryAt ?? null]);

  let replyTransitioned = false;
  if (reason === "suppressed") {
    await client.query("UPDATE enrollments SET status='unsubscribed',stopped_at=now(),stop_reason='suppressed',next_due_at=NULL,updated_at=now() WHERE id=$1", [message.enrollment_id]);
  } else if (reason === "already_replied") {
    // Excludes 'replied' from the target list (vs. the original catch-all) so the
    // RETURNING rowCount tells us this is the first time this enrollment flipped to
    // replied -- the signal used to send the reply-received email at most once.
    const updated = await client.query("UPDATE enrollments SET status='replied',stopped_at=COALESCE(stopped_at,now()),stop_reason='reply_detected',next_due_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('scheduled','active','paused') RETURNING id", [message.enrollment_id]);
    replyTransitioned = (updated.rowCount ?? 0) > 0;
    await client.query("UPDATE contacts SET status='replied',replied_at=COALESCE(replied_at,now()),updated_at=now() WHERE id=$1", [message.contact_id]);
  }
  if ((reason === "suppressed" || reason === "already_replied") && message.campaign_id) {
    await reconcileCampaignStatus(client, { workspaceId: message.workspace_id, campaignId: message.campaign_id });
  }
  return { replyTransitioned };
}

export async function claimMessage(client: PoolClient, payload: SendMessageJob, opts: { composioConfigured?: boolean; edition: Edition }): Promise<{ message?: DeliveryMessage; attemptNumber?: number; deniedReason?: DenyReason; replyDetected?: boolean }> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT id FROM campaigns WHERE workspace_id=$1 AND id IN (
      SELECT campaign_id FROM enrollments WHERE workspace_id=$1 AND id=$2
    ) ORDER BY id FOR UPDATE`, [payload.workspaceId, payload.enrollmentId]);
    // Acquire shared workspace capacity before taking the SELECT snapshot.
    // All claims in a workspace see committed reservations from earlier claims.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('send-capacity:' || $1::text))", [payload.workspaceId]);
    const selected = await client.query<DeliveryDecisionRow>(`
      SELECT m.*, now() AS gate_now, e.campaign_id, e.sequence_id, e.status::text AS enrollment_status,
             s.status::text AS sequence_status, ca.status::text AS campaign_status,
             a.provider, a.composio_connected_account_id, a.user_id AS mailbox_user_id, a.email AS mailbox_email, a.status::text AS mailbox_status,
             a.daily_limit, a.hourly_limit, a.ramp_started_on, a.ramp_paused_days,
             w.status::text AS workspace_status, w.kill_switch_enabled, w.daily_send_cap AS workspace_daily_cap, w.postal_address, w.open_tracking_enabled, w.legacy_free_until,
             COALESCE((SELECT au.email_verified FROM memberships om
               JOIN auth_users au ON au.id=om.user_id
               WHERE om.workspace_id=w.id AND om.role='owner' AND om.status='active'
               ORDER BY om.created_at LIMIT 1),false) AS owner_email_verified,
             sub.status::text AS subscription_status, sub.trial_end AS subscription_trial_end,
             (sub.updated_at + interval '7 days') AS subscription_on_hold_grace_ends_at,
             EXISTS (SELECT 1 FROM suppressions su WHERE su.workspace_id=m.workspace_id AND su.normalized_email=m.normalized_recipient_email) AS suppressed,
             (e.status='replied' OR c.status='replied' OR c.replied_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM message_events re
               LEFT JOIN messages rm ON rm.id=re.message_id
               WHERE re.workspace_id=m.workspace_id AND re.event_type='replied' AND (
                 rm.contact_id=m.contact_id
                 OR (m.conversation_thread_id IS NOT NULL AND rm.conversation_thread_id=m.conversation_thread_id)
                 OR (m.provider_thread_id IS NOT NULL AND rm.provider_thread_id=m.provider_thread_id)
                 OR lower(re.metadata->>'sender')=m.normalized_recipient_email
               )
             )) AS already_replied,
             ((SELECT count(*) FROM messages dm WHERE dm.email_account_id=a.id AND (
               (dm.status='accepted' AND dm.accepted_at::date=CURRENT_DATE)
               OR (dm.status='sending' AND dm.claim_expires_at > now())
               OR (dm.status='failed' AND dm.error_class='unknown_provider_result' AND dm.updated_at::date=CURRENT_DATE)
             )) + ${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "m.workspace_id", emailAccountIdSql: "a.id", range: "today" })})::text AS mailbox_today,
             ((SELECT count(*) FROM messages hm WHERE hm.email_account_id=a.id AND (
               (hm.status='accepted' AND hm.accepted_at > now()-interval '1 hour')
               OR (hm.status='sending' AND hm.claim_expires_at > now())
               OR (hm.status='failed' AND hm.error_class='unknown_provider_result' AND hm.updated_at > now()-interval '1 hour')
             )) + ${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "m.workspace_id", emailAccountIdSql: "a.id", range: "last_hour" })})::text AS mailbox_hour,
             ((SELECT count(*) FROM messages wm WHERE wm.workspace_id=w.id AND (
               (wm.status='accepted' AND wm.accepted_at::date=CURRENT_DATE)
               OR (wm.status='sending' AND wm.claim_expires_at > now())
               OR (wm.status='failed' AND wm.error_class='unknown_provider_result' AND wm.updated_at::date=CURRENT_DATE)
             )) + ${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "m.workspace_id", range: "today" })})::text AS workspace_today,
             ${freePlanMonthlySendsSql({ workspaceIdSql: "w.id" })}::text AS workspace_month,
             (NOT EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=a.id AND ms.is_active=true)
               OR EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=a.id AND ms.is_active=true
                 AND ms.day_of_week=extract(dow FROM now() AT TIME ZONE ms.timezone)::int
                 AND (now() AT TIME ZONE ms.timezone)::time BETWEEN ms.start_time AND ms.end_time)) AS in_sending_window,
             mh.state AS health_state, mh.effective_daily_limit, mh.consecutive_failures AS health_consecutive_failures,
             mh.temp_failures_24h AS health_temp_failures_24h, mh.perm_failures_24h AS health_perm_failures_24h, mh.throttled_until,
             (SELECT count(*) FROM send_attempts sa WHERE sa.message_id=m.id)::text AS attempt_count,
             previous.provider_thread_id AS previous_provider_thread_id, previous.accepted_at AS previous_accepted_at, previous.metadata->>'providerRfcMessageId' AS previous_rfc_message_id
      FROM messages m
      JOIN enrollments e ON e.id = m.enrollment_id
      JOIN sequences s ON s.id = e.sequence_id
      LEFT JOIN campaigns ca ON ca.id = e.campaign_id
      JOIN email_accounts a ON a.id = m.email_account_id
      JOIN workspaces w ON w.id = m.workspace_id
      LEFT JOIN subscriptions sub ON sub.workspace_id = w.id
      JOIN contacts c ON c.id = m.contact_id
      LEFT JOIN mailbox_health mh ON mh.email_account_id=a.id
      LEFT JOIN LATERAL (SELECT pm.provider_thread_id,pm.accepted_at,pm.metadata FROM messages pm
        WHERE pm.enrollment_id=m.enrollment_id AND pm.status='accepted'
        ORDER BY pm.accepted_at DESC LIMIT 1) previous ON true
      WHERE m.idempotency_key = $1 AND m.workspace_id = $2 AND e.id = $3
        AND m.status IN ('scheduled', 'retryable') AND m.scheduled_at <= now()
      FOR UPDATE OF m,e,c,a,w SKIP LOCKED
    `, [payload.idempotencyKey, payload.workspaceId, payload.enrollmentId]);
    const message = selected.rows[0];
    if (!message) {
      await client.query("ROLLBACK");
      return {};
    }
    if (message.provider !== "smtp" && opts.composioConfigured === false) {
      await client.query("ROLLBACK");
      logger.warn("Skipping send because Composio is not configured", { idempotencyKey: payload.idempotencyKey });
      return {};
    }

    // Queue startAfter is only a hint; overdue jobs and restarts can claim together.
    // Serialize per mailbox and enforce the actual send spacing inside this transaction.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mailbox-send-spacing:' || $1::text))", [message.email_account_id]);
    const lastSend = await client.query<{ last_send_at: Date | null }>(`SELECT GREATEST(
        (SELECT max(accepted_at) FROM messages WHERE email_account_id=$1 AND status='accepted'),
        (SELECT max(claimed_at) FROM messages WHERE email_account_id=$1 AND status='sending' AND claim_expires_at>now()),
        ${manualReplyEventSql({ aggregate: "latest", workspaceIdSql: "$2", emailAccountIdSql: "$1" })}
      ) AS last_send_at`, [message.email_account_id, message.workspace_id]);
    const lastSendAt = lastSend.rows[0]?.last_send_at;
    const nextAllowedAt = lastSendAt ? new Date(new Date(lastSendAt).getTime() + SEND_MIN_GAP_MS) : null;
    if (nextAllowedAt && nextAllowedAt > new Date(message.gate_now)) {
      await client.query(`UPDATE messages SET status='scheduled',blocked_reason='mailbox_min_gap',
        scheduled_at=GREATEST(scheduled_at,$2::timestamptz),claimed_at=NULL,claim_expires_at=NULL,updated_at=now()
        WHERE id=$1`, [message.id, nextAllowedAt]);
      await client.query("COMMIT");
      return { deniedReason: "mailbox_min_gap" };
    }

    const circuitKey = providerCircuitKey(message.provider, message.email_account_id);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('provider-circuit:' || $1))", [circuitKey]);
    await client.query("UPDATE provider_circuit SET state='open',next_probe_at=now(),updated_at=now() WHERE provider=$1 AND state='half_open' AND updated_at < now()-interval '10 minutes'", [circuitKey]);
    const circuit = await client.query<{ state: string | null; failure_count: number | null; next_probe_at: Date | null }>("SELECT state,failure_count,next_probe_at FROM provider_circuit WHERE provider=$1", [circuitKey]);
    message.circuit_state = circuit.rows[0]?.state ?? null;
    message.circuit_failure_count = circuit.rows[0]?.failure_count ?? null;
    message.next_probe_at = circuit.rows[0]?.next_probe_at ?? null;

    const probeDue = message.circuit_state === "open" && Boolean(message.next_probe_at) && new Date(message.next_probe_at!) <= new Date(message.gate_now);
    let decision = message.campaign_id && message.campaign_status !== "active"
      ? { allowed: false as const, reason: "sequence_inactive" as DenyReason, retryAt: new Date(new Date(message.gate_now).getTime() + 15 * 60_000) }
      : canSend(deliveryContext(message, opts.edition, probeDue), {
      sequenceStatus: message.sequence_status,
      enrollmentStatus: message.enrollment_status,
      suppressed: message.suppressed,
      alreadyReplied: message.already_replied,
    });
    if (decision.allowed && probeDue) {
      const probe = await client.query(`UPDATE provider_circuit SET state='half_open',updated_at=now()
        WHERE provider=$1 AND state='open' AND next_probe_at<=now() RETURNING provider`, [circuitKey]);
      if (probe.rowCount !== 1) {
        decision = { allowed: false, reason: "provider_circuit_open", retryAt: new Date(new Date(message.gate_now).getTime() + 15 * 60_000) };
      }
    }
    if (!decision.allowed) {
      const { replyTransitioned } = await recordDenial(client, message, decision.reason, decision.retryAt);
      await client.query("COMMIT");
      logger.info("Message delivery blocked", { messageId: message.id, reason: decision.reason, retryAt: decision.retryAt?.toISOString() });
      return { deniedReason: decision.reason, replyDetected: replyTransitioned };
    }

    // Only the legacy Free plan carries the "Sent via InboxJoy" footer.
    const gateContext = deliveryContext(message, opts.edition);
    message.sent_via = sendingPlan({ edition: gateContext.edition, subscription: gateContext.subscription, legacyFreeUntil: gateContext.workspace.legacyFreeUntil }, gateContext.now) === "legacy_free";
    const attemptNumber = Number(message.attempt_count) + 1;
    // Cloud: <id@messages.inboxjoy.online>, unchanged. Self-host: the sending
    // mailbox's own domain. A retry reuses the id an earlier attempt sent with,
    // so reconciliation and threading always look for what actually went out.
    const providerRfcMessageId = typeof message.metadata?.providerRfcMessageId === "string"
      ? message.metadata.providerRfcMessageId
      : rfcMessageId(message.id, opts.edition, message.mailbox_email);
    const attemptMetadata = {
      providerRfcMessageId,
      providerAttemptedAt: new Date(message.gate_now).toISOString(),
      ...(message.provider === "smtp" ? { providerRfcThreadId: message.previous_rfc_message_id ?? providerRfcMessageId } : {}),
    };
    message.metadata = { ...message.metadata, ...attemptMetadata };
    await client.query("UPDATE messages SET metadata=metadata || $2::jsonb WHERE id=$1", [message.id, JSON.stringify(attemptMetadata)]);
    await client.query("UPDATE messages SET status='sending', blocked_reason=NULL, claimed_at=now(), claim_expires_at=now()+interval '10 minutes', updated_at=now() WHERE id=$1", [message.id]);
    await client.query(`INSERT INTO send_attempts (id,workspace_id,message_id,attempt_number,status,started_at)
      VALUES ($1,$2,$3,$4,'sending',now())`, [randomUUID(), message.workspace_id, message.id, attemptNumber]);
    await client.query("COMMIT");
    return { message, attemptNumber };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function preSendReplyCheck(client: PoolClient, message: ClaimedMessage, attemptNumber: number, providerReplyDetected: boolean, deps: Pick<SendMessageDependencies, "edition" | "transactionalEmail">): Promise<boolean> {
  await client.query("BEGIN");
  try {
    if (message.campaign_id) await client.query("SELECT id FROM campaigns WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [message.workspace_id, message.campaign_id]);
    const result = await client.query<DeliveryDecisionRow & { message_status: string }>(`SELECT
        m.*,now() AS gate_now,m.status::text AS message_status,e.campaign_id,e.sequence_id,
        e.status::text AS enrollment_status,s.status::text AS sequence_status,ca.status::text AS campaign_status,
        a.provider,a.composio_connected_account_id,a.user_id AS mailbox_user_id,a.email AS mailbox_email,a.status::text AS mailbox_status,
        a.daily_limit,a.hourly_limit,a.ramp_started_on,a.ramp_paused_days,
        w.status::text AS workspace_status,w.kill_switch_enabled,w.daily_send_cap AS workspace_daily_cap,w.postal_address,w.legacy_free_until,
        COALESCE((SELECT au.email_verified FROM memberships om JOIN auth_users au ON au.id=om.user_id
          WHERE om.workspace_id=w.id AND om.role='owner' AND om.status='active' ORDER BY om.created_at LIMIT 1),false) AS owner_email_verified,
        sub.status::text AS subscription_status,sub.trial_end AS subscription_trial_end,
        sub.updated_at+interval '7 days' AS subscription_on_hold_grace_ends_at,
        (SELECT count(*) FROM messages dm WHERE dm.email_account_id=a.id AND dm.id<>m.id AND (
          (dm.status='accepted' AND dm.accepted_at::date=CURRENT_DATE) OR (dm.status='sending' AND dm.claim_expires_at>now())
          OR (dm.status='failed' AND dm.error_class='unknown_provider_result' AND dm.updated_at::date=CURRENT_DATE))) +
        ${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "m.workspace_id", emailAccountIdSql: "a.id", range: "today" })} AS mailbox_today,
        (SELECT count(*) FROM messages hm WHERE hm.email_account_id=a.id AND hm.id<>m.id AND (
          (hm.status='accepted' AND hm.accepted_at>now()-interval '1 hour') OR (hm.status='sending' AND hm.claim_expires_at>now())
          OR (hm.status='failed' AND hm.error_class='unknown_provider_result' AND hm.updated_at>now()-interval '1 hour'))) +
        ${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "m.workspace_id", emailAccountIdSql: "a.id", range: "last_hour" })} AS mailbox_hour,
        (SELECT count(*) FROM messages wm WHERE wm.workspace_id=w.id AND wm.id<>m.id AND (
          (wm.status='accepted' AND wm.accepted_at::date=CURRENT_DATE) OR (wm.status='sending' AND wm.claim_expires_at>now())
          OR (wm.status='failed' AND wm.error_class='unknown_provider_result' AND wm.updated_at::date=CURRENT_DATE))) +
        ${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "m.workspace_id", range: "today" })} AS workspace_today,
        ${freePlanMonthlySendsSql({ workspaceIdSql: "w.id", excludeMessageIdSql: "m.id" })}::text AS workspace_month,
        GREATEST(
          (SELECT max(accepted_at) FROM messages lm WHERE lm.email_account_id=a.id AND lm.id<>m.id AND lm.status='accepted'),
          (SELECT max(claimed_at) FROM messages lm WHERE lm.email_account_id=a.id AND lm.id<>m.id AND lm.status='sending' AND lm.claim_expires_at>now()),
          ${manualReplyEventSql({ aggregate: "latest", workspaceIdSql: "m.workspace_id", emailAccountIdSql: "a.id" })}
        ) AS mailbox_last_send_at,
        (NOT EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=a.id AND ms.is_active=true)
          OR EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=a.id AND ms.is_active=true
            AND ms.day_of_week=extract(dow FROM now() AT TIME ZONE ms.timezone)::int
            AND (now() AT TIME ZONE ms.timezone)::time BETWEEN ms.start_time AND ms.end_time)) AS in_sending_window,
        mh.state AS health_state,mh.effective_daily_limit,mh.consecutive_failures AS health_consecutive_failures,
        mh.temp_failures_24h AS health_temp_failures_24h,mh.perm_failures_24h AS health_perm_failures_24h,mh.throttled_until,
        pc.state AS circuit_state,pc.failure_count AS circuit_failure_count,pc.next_probe_at,
        EXISTS (SELECT 1 FROM suppressions su WHERE su.workspace_id=m.workspace_id AND su.normalized_email=m.normalized_recipient_email) AS suppressed,
        (e.status='replied' OR c.status='replied' OR c.replied_at IS NOT NULL OR EXISTS (
          SELECT 1 FROM message_events re LEFT JOIN messages rm ON rm.id=re.message_id
          WHERE re.workspace_id=m.workspace_id AND re.event_type='replied' AND (
            rm.contact_id=m.contact_id OR (m.conversation_thread_id IS NOT NULL AND rm.conversation_thread_id=m.conversation_thread_id)
            OR (m.provider_thread_id IS NOT NULL AND rm.provider_thread_id=m.provider_thread_id)
            OR lower(re.metadata->>'sender')=m.normalized_recipient_email
          )
        )) AS already_replied
      FROM messages m
      JOIN enrollments e ON e.id=m.enrollment_id
      JOIN sequences s ON s.id=e.sequence_id
      LEFT JOIN campaigns ca ON ca.id=e.campaign_id
      JOIN email_accounts a ON a.id=m.email_account_id
      JOIN workspaces w ON w.id=m.workspace_id
      JOIN contacts c ON c.id=m.contact_id
      LEFT JOIN subscriptions sub ON sub.workspace_id=w.id
      LEFT JOIN mailbox_health mh ON mh.email_account_id=a.id
      LEFT JOIN provider_circuit pc ON pc.provider=${providerCircuitKeySql("a")}
      WHERE m.id=$1 FOR UPDATE OF m,e,c,a,w`, [message.id]);
    const state = result.rows[0];
    if (!state || state.message_status !== "sending") {
      await client.query("ROLLBACK");
      return false;
    }
    if (providerReplyDetected || state.enrollment_status === "replied" || state.already_replied) {
      await client.query("UPDATE messages SET status='cancelled',blocked_reason='already_replied',claim_expires_at=NULL,error_class='reply_detected',updated_at=now() WHERE id=$1 AND status='sending'", [message.id]);
      await client.query("UPDATE send_attempts SET status='cancelled',error_class='reply_detected',error_message='Recipient replied',finished_at=now() WHERE message_id=$1 AND attempt_number=$2 AND status='sending'", [message.id, attemptNumber]);
      const repliedUpdate = await client.query("UPDATE enrollments SET status='replied',stopped_at=COALESCE(stopped_at,now()),stop_reason='reply_detected',next_due_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('scheduled','active','paused') RETURNING id", [message.enrollment_id]);
      await client.query("UPDATE contacts SET status='replied',replied_at=COALESCE(replied_at,now()),updated_at=now() WHERE id=$1", [message.contact_id]);
      if (message.campaign_id) await reconcileCampaignStatus(client, { workspaceId: message.workspace_id, campaignId: message.campaign_id });
      await client.query("COMMIT");
      if ((repliedUpdate.rowCount ?? 0) > 0 && deps.transactionalEmail) {
        await notifyReplyReceived({ pool: client, transactionalEmail: deps.transactionalEmail }, message.enrollment_id);
      }
      return false;
    }
    const probeAllowed = state.circuit_state === "half_open" || (state.circuit_state === "open" && Boolean(state.next_probe_at) && new Date(state.next_probe_at!) <= new Date(state.gate_now));
    const decision = message.campaign_id && state.campaign_status !== "active"
      ? { allowed: false as const, reason: "sequence_inactive" as DenyReason, retryAt: new Date(new Date(state.gate_now).getTime() + 15 * 60_000) }
      : canSend(deliveryContext(state, deps.edition, probeAllowed), {
        sequenceStatus: state.sequence_status,
        enrollmentStatus: state.enrollment_status,
        suppressed: state.suppressed,
        alreadyReplied: state.already_replied,
      });
    if (!decision.allowed) {
      await recordDenial(client, state, decision.reason, decision.retryAt);
      await client.query("UPDATE send_attempts SET status='cancelled',error_class=$3,error_message=$4,finished_at=now() WHERE message_id=$1 AND attempt_number=$2 AND status='sending'", [message.id, attemptNumber, decision.reason, "Send blocked by " + decision.reason]);
      await client.query("COMMIT");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function currentMailboxHealth(client: PoolClient, message: ClaimedMessage): Promise<MailboxHealthRow> {
  await client.query(`INSERT INTO mailbox_health (id,workspace_id,email_account_id,state,effective_daily_limit)
    VALUES ($1,$2,$3,'healthy',$4) ON CONFLICT (email_account_id) DO NOTHING`, [randomUUID(), message.workspace_id, message.email_account_id, message.daily_limit]);
  const result = await client.query<MailboxHealthRow>(`SELECT state,effective_daily_limit,consecutive_failures,temp_failures_24h,
    perm_failures_24h,throttled_until FROM mailbox_health WHERE email_account_id=$1 FOR UPDATE`, [message.email_account_id]);
  return result.rows[0] ?? {
    state: "healthy",
    effective_daily_limit: message.daily_limit,
    consecutive_failures: 0,
    temp_failures_24h: 0,
    perm_failures_24h: 0,
    throttled_until: null,
  };
}

function healthSnapshot(row: MailboxHealthRow): MailboxHealthSnapshot {
  return {
    state: row.state,
    effectiveDailyLimit: row.effective_daily_limit,
    consecutiveFailures: row.consecutive_failures,
    tempFailures24h: row.temp_failures_24h,
    permFailures24h: row.perm_failures_24h,
    throttledUntil: row.throttled_until ? new Date(row.throttled_until) : null,
  };
}

export async function updateMailboxHealthForFailure(
  client: PoolClient,
  message: ClaimedMessage,
  kind: MailboxFailureKind,
  now = new Date(),
  retryAfter?: Date,
): Promise<{ previousState: string; nextState: string }> {
  const current = await currentMailboxHealth(client, message);
  const next = mailboxHealthAfterFailure(healthSnapshot(current), message.daily_limit, kind, now, retryAfter);
  await client.query(`UPDATE mailbox_health SET state=$2,effective_daily_limit=$3,consecutive_failures=$4,
    temp_failures_24h=$5,perm_failures_24h=$6,throttled_until=$7,updated_at=$8 WHERE email_account_id=$1`, [
    message.email_account_id,
    next.state,
    next.effectiveDailyLimit,
    next.consecutiveFailures,
    next.tempFailures24h,
    next.permFailures24h,
    next.throttledUntil,
    now,
  ]);
  return { previousState: current.state, nextState: next.state };
}

export async function updateMailboxHealthForSuccess(client: PoolClient, message: ClaimedMessage, now = new Date()): Promise<void> {
  const current = await currentMailboxHealth(client, message);
  const next = mailboxHealthAfterSuccess(healthSnapshot(current), message.daily_limit);
  await client.query(`UPDATE mailbox_health SET state=$2,effective_daily_limit=$3,consecutive_failures=$4,
    throttled_until=$5,last_successful_send_at=$6,updated_at=$6 WHERE email_account_id=$1`, [
    message.email_account_id,
    next.state,
    next.effectiveDailyLimit,
    next.consecutiveFailures,
    next.throttledUntil,
    now,
  ]);
}

async function recordProviderCircuitFailure(client: PoolClient, message: ClaimedMessage, retryAfter?: Date): Promise<void> {
  const nextProbeAt = retryAfter && retryAfter > new Date() ? retryAfter : new Date(Date.now() + 15 * 60_000);
  const circuitKey = providerCircuitKey(message.provider, message.email_account_id);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('provider-circuit:' || $1))", [circuitKey]);
  await client.query(`INSERT INTO provider_circuit (provider,state,opened_at,failure_count,next_probe_at,updated_at)
    VALUES ($1,CASE WHEN $2<=1 THEN 'open' ELSE 'closed' END,CASE WHEN $2<=1 THEN now() ELSE NULL END,1,
      CASE WHEN $2<=1 THEN $3::timestamptz ELSE NULL END,now())
    ON CONFLICT (provider) DO UPDATE SET
      failure_count=provider_circuit.failure_count+1,
      state=CASE WHEN provider_circuit.state='half_open' OR provider_circuit.failure_count+1 >= $2 THEN 'open' ELSE provider_circuit.state END,
      opened_at=CASE WHEN provider_circuit.state='half_open' OR provider_circuit.failure_count+1 >= $2 THEN COALESCE(provider_circuit.opened_at,now()) ELSE provider_circuit.opened_at END,
      next_probe_at=CASE WHEN provider_circuit.state='half_open' OR provider_circuit.failure_count+1 >= $2 THEN $3::timestamptz ELSE provider_circuit.next_probe_at END,
      updated_at=now()`, [circuitKey, PROVIDER_CIRCUIT_FAILURE_THRESHOLD, nextProbeAt]);
}

async function recordProviderCircuitSuccess(client: PoolClient, message: ClaimedMessage): Promise<void> {
  const circuitKey = providerCircuitKey(message.provider, message.email_account_id);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('provider-circuit:' || $1))", [circuitKey]);
  await client.query(`INSERT INTO provider_circuit (provider,state,failure_count,updated_at) VALUES ($1,'closed',0,now())
    ON CONFLICT (provider) DO UPDATE SET state='closed',opened_at=NULL,failure_count=0,next_probe_at=NULL,updated_at=now()`, [circuitKey]);
}

export async function recordProviderAccepted(client: PoolClient, message: ClaimedMessage, attemptNumber: number, sent: { providerMessageId?: string; providerThreadId?: string; logId?: string }): Promise<boolean> {
  await client.query("BEGIN");
  try {
    const finalized = await client.query(`UPDATE messages SET status='accepted', accepted_at=now(), provider_message_id=$2,
      provider_thread_id=$3, claim_expires_at=NULL, blocked_reason=NULL, error_class=NULL, error_message=NULL,
      metadata=metadata || $4::jsonb, updated_at=now() WHERE id=$1 AND (status='sending' OR (status='failed' AND error_class='unknown_provider_result')) RETURNING id`,
    [message.id, sent.providerMessageId ?? null, sent.providerThreadId ?? null, JSON.stringify({ ...(sent.logId ? { composioLogId: sent.logId } : {}), acceptanceBookkeepingPending: true })]);
    if (finalized.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`UPDATE send_attempts SET status='accepted', provider_message_id=$3, provider_thread_id=$4,
      finished_at=now() WHERE message_id=$1 AND attempt_number=$2`, [message.id, attemptNumber, sent.providerMessageId ?? null, sent.providerThreadId ?? null]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  try {
    await client.query("BEGIN");
    await updateMailboxHealthForSuccess(client, message);
    await recordProviderCircuitSuccess(client, message);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    logger.warn("Accepted message health bookkeeping failed", { messageId: message.id, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

// A lead can be live in several sequences at once: it only returns to "active" once
// none of its enrollments is still scheduled, active or paused.
async function resetContactStatusWhenIdle(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  await client.query(`UPDATE contacts SET status='active',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='enrolled'
    AND NOT EXISTS (SELECT 1 FROM enrollments oe WHERE oe.contact_id=$1 AND oe.workspace_id=$2 AND oe.status IN ('scheduled','active','paused'))`, [contactId, workspaceId]);
}

export async function completeAcceptedBookkeeping(client: PoolClient, message: ClaimedMessage, deps: Dependencies): Promise<boolean> {
  await client.query("BEGIN");
  let completedCampaign: CampaignStatusResult | null = null;
  try {
    if (message.campaign_id) await client.query("SELECT id FROM campaigns WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [message.workspace_id, message.campaign_id]);
    const pending = await client.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM messages WHERE id=$1 AND status='accepted' FOR UPDATE", [message.id]);
    if (pending.rows[0]?.metadata.acceptanceBookkeepingPending !== true) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`INSERT INTO mailbox_daily_usage (workspace_id,email_account_id,usage_date,accepted_count)
      VALUES ($1,$2,CURRENT_DATE,1) ON CONFLICT (email_account_id,usage_date)
      DO UPDATE SET accepted_count=mailbox_daily_usage.accepted_count+1,updated_at=now()`, [message.workspace_id, message.email_account_id]);

    const current = await client.query<{ step_order: number }>("SELECT step_order FROM sequence_steps WHERE id=$1", [message.sequence_step_id]);
    // Lock the enrollment and honor pause/stop decisions that landed while this send was in flight:
    // a paused enrollment must stay paused (resume reschedules its pending message), and a terminal one
    // (replied/cancelled/...) must not be reactivated or scheduled further.
    const enrollmentState = await client.query<{ status: string; email_account_id: string | null }>("SELECT status,email_account_id FROM enrollments WHERE id=$1 FOR UPDATE", [message.enrollment_id]);
    const enrollmentStatus = enrollmentState.rows[0]?.status;
    const emailAccountId = enrollmentState.rows[0]?.email_account_id ?? message.email_account_id;
    const advanceable = enrollmentStatus === "scheduled" || enrollmentStatus === "active" || enrollmentStatus === "paused";
    const next = await client.query(`
      SELECT s.id, s.step_order, s.delay_days, s.subject, s.body_text,
             c.email, c.normalized_email, c.first_name, c.last_name, c.company, c.title,
             c.custom_fields, v."values" AS campaign_variables, sv.custom_variables_enforced
      FROM enrollments e
      JOIN sequence_versions sv ON sv.id=e.sequence_version_id
      JOIN sequence_steps s ON s.sequence_version_id=e.sequence_version_id
      JOIN contacts c ON c.id=e.contact_id
      LEFT JOIN campaign_lead_variables v ON v.sequence_id=e.sequence_id AND v.contact_id=e.contact_id AND v.workspace_id=e.workspace_id
      WHERE e.id=$1 AND s.step_order>$2
      ORDER BY s.step_order LIMIT 1
    `, [message.enrollment_id, current.rows[0]?.step_order ?? 0]);

    const nextRow = next.rowCount && advanceable ? next.rows[0] as Record<string, unknown> : null;
    const nextSource = nextRow ? variableSourceFromRow(nextRow) : null;
    // Versions published before custom variables shipped render like they always did and never stop for missing values.
    const renderOptions: RenderOptions = { enforceCustom: nextRow?.custom_variables_enforced !== false };
    const renderedBody = nextRow && nextSource ? renderTemplate(String(nextRow.body_text ?? ""), nextSource, renderOptions) : null;
    const renderedSubject = nextRow && nextSource ? renderTemplate(String(nextRow.subject ?? ""), nextSource, renderOptions) : null;
    const missingVariables = [...new Set([...(renderedSubject?.missing ?? []), ...(renderedBody?.missing ?? [])])].sort();

    if (nextRow && renderedBody && renderedSubject && missingVariables.length) {
      // A variable this step needs was removed after launch: stop this enrollment instead of
      // queueing a blank email. No message row is written, so no idempotency key is consumed.
      await client.query("UPDATE enrollments SET status='cancelled',status_before_pause=NULL,paused_at=NULL,next_due_at=NULL,stopped_at=now(),stop_reason='missing_variables',updated_at=now() WHERE id=$1", [message.enrollment_id]);
      // Stage the lead (also when it was enrolled directly, not through a list) so it is revived
      // at this step, on the same version and mailbox, once the value is written again.
      await client.query(`INSERT INTO staged_enrollments (id,workspace_id,sequence_id,lead_id,campaign_id,inbox_ids,created_at)
        SELECT $2,e.workspace_id,e.sequence_id,e.contact_id,e.campaign_id,CASE WHEN e.email_account_id IS NULL THEN NULL ELSE ARRAY[e.email_account_id] END,now()
        FROM enrollments e WHERE e.id=$1
        ON CONFLICT DO NOTHING`, [message.enrollment_id, randomUUID()]);
      await resetContactStatusWhenIdle(client, message.workspace_id, message.contact_id);
      logger.warn("Stopped enrollment: next step is missing lead variables", { enrollmentId: message.enrollment_id, contactId: message.contact_id, missingVariables });
      if (message.campaign_id) {
        completedCampaign = await reconcileCampaignStatus(client, { workspaceId: message.workspace_id, campaignId: message.campaign_id });
      }
    } else if (nextRow && renderedBody && renderedSubject) {
      const row = nextRow;
      const body = renderedBody.text;
      const subject = renderedSubject.text;
      const token = createUnsubscribeToken({ workspaceId: message.workspace_id, contactId: message.contact_id, normalizedEmail: String(row.normalized_email), expiresAt: Date.now() + 365 * 86_400_000 }, deps.authSecret!);
      const unsubscribeUrl = `${deps.apiBaseUrl!.replace(/\/$/, "")}/v1/unsubscribe?token=${encodeURIComponent(token)}`;
      const bodyWithFooter = appendUnsubscribeFooter(body, unsubscribeUrl, message.postal_address);
      const scheduledAt = new Date(Date.now() + Number(row.delay_days ?? 0) * 86_400_000 + followUpSendJitterMs(`${message.enrollment_id}:${String(row.step_order)}`));
      await client.query(`INSERT INTO messages (
        id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,
        scheduled_at,recipient_email,normalized_recipient_email,subject,body_hash,metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING`, [
        randomUUID(), message.workspace_id, message.enrollment_id, row.id, emailAccountId, message.contact_id,
        `${message.enrollment_id}:${row.step_order}`, scheduledAt, row.email, row.normalized_email, subject, hash(bodyWithFooter),
        JSON.stringify({ bodyText: bodyWithFooter, sequenceStepOrder: row.step_order, unsubscribeUrl }),
      ]);
      await client.query(`UPDATE enrollments SET status=CASE WHEN status='paused' AND stop_reason IS DISTINCT FROM 'provider_result_unknown' THEN 'paused'::enrollment_status ELSE 'active'::enrollment_status END,
        status_before_pause=CASE WHEN status='paused' AND stop_reason IS DISTINCT FROM 'provider_result_unknown' THEN status_before_pause ELSE NULL END,
        paused_at=CASE WHEN status='paused' AND stop_reason IS DISTINCT FROM 'provider_result_unknown' THEN paused_at ELSE NULL END,
        stop_reason=CASE WHEN status='paused' AND stop_reason IS DISTINCT FROM 'provider_result_unknown' THEN stop_reason ELSE NULL END,
        next_step_order=$2,next_due_at=$3,updated_at=now() WHERE id=$1`, [message.enrollment_id, row.step_order, scheduledAt]);
    } else if (advanceable) {
      await client.query("UPDATE enrollments SET status='completed',status_before_pause=NULL,paused_at=NULL,next_due_at=NULL,stopped_at=now(),stop_reason='sequence_completed',updated_at=now() WHERE id=$1", [message.enrollment_id]);
      await resetContactStatusWhenIdle(client, message.workspace_id, message.contact_id);
      if (message.campaign_id) {
        completedCampaign = await reconcileCampaignStatus(client, { workspaceId: message.workspace_id, campaignId: message.campaign_id });
      }
    }
    await client.query("UPDATE messages SET metadata=metadata-'acceptanceBookkeepingPending',updated_at=now() WHERE id=$1", [message.id]);
    await client.query("COMMIT");
    if (completedCampaign?.change === "finished" && deps.transactionalEmail) {
      await notifyCampaignCompleted({ pool: client, transactionalEmail: deps.transactionalEmail }, {
        workspaceId: message.workspace_id,
        campaignId: completedCampaign.id,
        campaignName: completedCampaign.name,
        previousCompletedAt: completedCampaign.previousCompletedAt,
      });
    }
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function recordAccepted(client: PoolClient, message: ClaimedMessage, attemptNumber: number, sent: { providerMessageId?: string; providerThreadId?: string; logId?: string }, deps: Dependencies): Promise<void> {
  await recordProviderAccepted(client, message, attemptNumber, sent);
  await completeAcceptedBookkeeping(client, message, deps);
}

export async function recordFailure(client: PoolClient, message: DeliveryMessage, attemptNumber: number, error: unknown, deliveryAttempted = true, deps?: Pick<Dependencies, "transactionalEmail">): Promise<void> {
  const classified = errorClass(error);
  const preparationFailure = error instanceof MessagePreparationError;
  const mailboxFailure = classified.kind === "mailbox";
  const ambiguousProviderResult = deliveryAttempted && classified.ambiguousProviderResult === true;
  const retryable = mailboxFailure || (!preparationFailure && !ambiguousProviderResult && classified.kind === "retryable" && attemptNumber < 5);
  const persistedErrorClass = preparationFailure
    ? "preparation_failed"
    : (classified.kind === "unknown" && deliveryAttempted) || ambiguousProviderResult
      ? "unknown_provider_result"
      : mailboxFailure
        ? "mailbox_authentication"
        : !deliveryAttempted
          ? "reply_check_failed"
          : retryable
            ? "provider_retryable"
            : "provider_permanent";
  const delaySeconds = Math.min(3600, 60 * (2 ** attemptNumber));
  const retryAt = classified.retryAfter && classified.retryAfter > new Date()
    ? classified.retryAfter
    : new Date(Date.now() + delaySeconds * 1000);
  await client.query("BEGIN");
  try {
    // Campaign rows lock first (ordered) wherever enrollments change. A retryable
    // failure touches this message only; a permanent one can auto-pause the whole
    // sequence; a mailbox failure pauses every lead sending from that mailbox.
    await client.query(`SELECT id FROM campaigns WHERE workspace_id=$1 AND (
      id=$4
      OR ($5::boolean AND sequence_id=$2)
      OR ($6::boolean AND id IN (SELECT campaign_id FROM enrollments WHERE workspace_id=$1 AND email_account_id=$3 AND status IN ('scheduled','active')))
    ) ORDER BY id FOR UPDATE`, [message.workspace_id, message.sequence_id, message.email_account_id, message.campaign_id ?? null, !retryable, mailboxFailure]);
    await client.query("SELECT id FROM sequences WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [message.workspace_id, message.sequence_id]);
    const finalized = await client.query(`UPDATE messages SET status=$2, scheduled_at=CASE WHEN $6 THEN $5::timestamptz ELSE scheduled_at END,
      claim_expires_at=NULL,error_class=$3,error_message=$4,updated_at=now() WHERE id=$1 AND status='sending' RETURNING id`, [
      message.id, retryable ? "retryable" : "failed",
      persistedErrorClass,
      classified.message.slice(0, 1000), retryAt, retryable,
    ]);
    if (finalized.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(`UPDATE send_attempts SET status=$3,provider_status_code=$4,error_class=$5,error_message=$6,finished_at=now()
      WHERE message_id=$1 AND attempt_number=$2`, [message.id, attemptNumber, retryable ? "retryable" : "failed", classified.status ?? null, persistedErrorClass, classified.message.slice(0, 1000)]);
    if (mailboxFailure) {
      const now = new Date();
      await client.query("UPDATE email_accounts SET status='expired',last_health_check_at=$2,updated_at=$2 WHERE id=$1", [message.email_account_id, now]);
      await client.query(`UPDATE enrollments SET status_before_pause=status,status='paused',paused_at=$2,stop_reason='mailbox_auth_expired',updated_at=$2
        WHERE email_account_id=$1 AND status IN ('scheduled','active')`, [message.email_account_id, now]);
      const notificationBody = `Reconnect ${message.mailbox_email ?? "the sending inbox"} to resume paused campaigns.`;
      await client.query(`INSERT INTO notifications (id,workspace_id,type,title,body)
        SELECT $1,$2,'mailbox_reconnect_required','Reconnect your sending inbox',$3
        WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE workspace_id=$2 AND type='mailbox_reconnect_required' AND body=$3 AND read_at IS NULL)`, [randomUUID(), message.workspace_id, notificationBody]);
    } else if ((classified.kind === "unknown" && deliveryAttempted) || ambiguousProviderResult) {
      await client.query("UPDATE enrollments SET status='paused',stop_reason='provider_result_unknown',updated_at=now() WHERE id=$1", [message.enrollment_id]);
    } else if (!retryable) {
      const stopReason = preparationFailure
        ? "message_preparation_failed"
        : deliveryAttempted
          ? "provider_permanent_failure"
          : "pre_send_retry_exhausted";
      await client.query("UPDATE enrollments SET status='cancelled',stopped_at=now(),stop_reason=$2,updated_at=now() WHERE id=$1", [message.enrollment_id, stopReason]);
      if (message.campaign_id) await reconcileCampaignStatus(client, { workspaceId: message.workspace_id, campaignId: message.campaign_id });
      // A single sender-side permanent rejection (Gmail/Outlook via Composio, or an
      // SMTP mailbox rejected at MAIL FROM/DATA rather than per-recipient RCPT) says
      // nothing about the lead — the provider is refusing the mailbox, not the
      // recipient. Without this guard every due lead gets cancelled one at a time.
      // RCPT-stage SMTP failures are per-recipient and stay outside this guard.
      const smtpSenderSideFailure = error instanceof SmtpSendError && error.command !== "RCPT";
      if (classified.kind === "permanent" && (error instanceof ComposioRequestError || smtpSenderSideFailure)) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('sequence-send-failure:' || $1::text))", [message.sequence_id]);
        // "Identical" for Composio is the same sequence + exact sanitized message.
        // For SMTP it also requires the same mailbox, since a different mailbox in
        // rotation may still be healthy — the message text already encodes the
        // stage, response code and (for the mail stage) the MAIL/RCPT command.
        const mailboxScope = smtpSenderSideFailure ? message.email_account_id : null;
        const repeated = await client.query<{ count: string }>(`SELECT count(*)::text AS count
          FROM messages failed_message
          JOIN enrollments failed_enrollment ON failed_enrollment.id=failed_message.enrollment_id
          WHERE failed_enrollment.sequence_id=$1
            AND failed_message.error_class='provider_permanent' AND failed_message.error_message=$2
            AND failed_message.updated_at>=now()-interval '15 minutes'
            AND ($3::uuid IS NULL OR failed_message.email_account_id=$3)`, [message.sequence_id, classified.message.slice(0, 1000), mailboxScope]);
        if (Number(repeated.rows[0]?.count ?? 0) >= 3) {
          const paused = await client.query<{ id: string; name: string }>(`UPDATE sequences SET status='paused',paused_at=now(),updated_at=now()
            WHERE id=$1 AND status='active'
            RETURNING id,name`, [message.sequence_id]);
          if (paused.rowCount === 1) {
            await client.query(`UPDATE enrollments SET status_before_pause=status,status='paused',paused_at=now(),
              stop_reason='repeated_provider_failure',updated_at=now()
              WHERE sequence_id=$1 AND status IN ('scheduled','active')`, [paused.rows[0]!.id]);
            await client.query(`INSERT INTO notifications (id,workspace_id,type,title,body)
              VALUES ($1,$2,'sequence_auto_paused',$3,$4)`, [
              randomUUID(), message.workspace_id, `Sequence paused: ${paused.rows[0]!.name}`,
              "Sending was paused after three identical provider failures in 15 minutes. Review the sending inbox, then resume when fixed.",
            ]);
          }
        }
      }
    }
    await client.query("COMMIT");
  } catch (transactionError) {
    await client.query("ROLLBACK");
    throw transactionError;
  }
  if (deliveryAttempted) {
    try {
    await client.query("BEGIN");
    const healthKind: MailboxFailureKind = mailboxFailure ? "auth" : classified.kind === "retryable" ? "temporary" : classified.kind === "unknown" ? "unknown" : "permanent";
    const healthTransition = await updateMailboxHealthForFailure(client, message, healthKind, new Date(), classified.retryAfter);
    if (classified.providerFailure) await recordProviderCircuitFailure(client, message, classified.retryAfter);
    await client.query("COMMIT");
    if (
      deps?.transactionalEmail &&
      !NON_SENDING_HEALTH_STATES.has(healthTransition.previousState) &&
      NON_SENDING_HEALTH_STATES.has(healthTransition.nextState)
    ) {
      await notifyMailboxAlert({ pool: client, transactionalEmail: deps.transactionalEmail }, {
        workspaceId: message.workspace_id,
        mailboxEmail: message.mailbox_email ?? "your inbox",
        state: healthTransition.nextState,
      });
    }
  } catch (healthError) {
    await client.query("ROLLBACK");
    logger.warn("Message failure health bookkeeping failed", { messageId: message.id, error: healthError instanceof Error ? healthError.message : String(healthError) });
  }
  }
  logger.error("Message send failed", { messageId: message.id, attemptNumber, errorClass: persistedErrorClass, providerStatus: classified.status, retryable, retryAfter: classified.retryAfter?.toISOString(), error: classified.message });
}

export async function sendMessage(payload: SendMessageJob, deps?: SendMessageDependencies): Promise<void> {
  if (!deps?.apiBaseUrl || !deps.authSecret) {
    logger.warn("Skipping send because send configuration is incomplete", { idempotencyKey: payload.idempotencyKey });
    return;
  }

  const claimClient = await deps.pool.connect();
  let claimed: Awaited<ReturnType<typeof claimMessage>>;
  try {
    claimed = await claimMessage(claimClient, payload, { composioConfigured: Boolean(deps.composioApiKey || deps.composio?.enabled || (deps.mailClientFor && !deps.composio)), edition: deps.edition });
  } finally {
    claimClient.release();
  }
  if (claimed.replyDetected) {
    await notifyReplyReceived({ pool: deps.pool, transactionalEmail: deps.transactionalEmail }, payload.enrollmentId);
  }
  if (!claimed.message || !claimed.attemptNumber) return;

  const message = claimed.message;
  const preflightClient = await deps.pool.connect();
  try {
    if (!await preSendReplyCheck(preflightClient, message, claimed.attemptNumber, false, deps)) return;
  } finally {
    preflightClient.release();
  }
  let mailClient: MailClient;
  try {
    const mailClientFor = deps.mailClientFor ?? createMailClientResolver({ db: createDb(deps.pool), keys: deps.mailboxCredentialsKeys, composio: deps.composio ?? createComposioClient(deps.composioApiKey, undefined, deps.toolkitVersion) }).getMailClientFor;
    mailClient = await mailClientFor({ provider: message.provider, emailAccountId: message.email_account_id });
  } catch (error) {
    const failureClient = await deps.pool.connect();
    try { await recordFailure(failureClient, message, claimed.attemptNumber, error, false, deps); } finally { failureClient.release(); }
    return;
  }
  if (message.previous_accepted_at && (mailClient.fetchReplies || mailClient.findReply)) {
    try {
      const lookupInput = {
        connectedAccountId: message.composio_connected_account_id,
        userId: message.mailbox_user_id,
        provider: message.provider,
        senderEmail: message.normalized_recipient_email,
        threadId: message.previous_provider_thread_id ?? undefined,
        after: new Date(message.previous_accepted_at),
      };
      let replies: FetchedReply[] = [];
      if (mailClient.fetchReplies) {
        if (lookupInput.provider !== "smtp") assertComposioProvider(lookupInput.provider, "send-message.fetchReplies");
        replies = await mailClient.fetchReplies({ ...lookupInput, provider: lookupInput.provider });
      } else if (mailClient.findReply) {
        if (lookupInput.provider !== "smtp") assertComposioProvider(lookupInput.provider, "send-message.findReply");
        replies = await mailClient.findReply({ ...lookupInput, provider: lookupInput.provider })
          ? [{ from: message.normalized_recipient_email, providerThreadId: message.previous_provider_thread_id ?? undefined, receivedAt: new Date() }]
          : [];
      }
      const reply = replies
        .filter((item) => !item.receivedAt || item.receivedAt.getTime() >= new Date(message.previous_accepted_at!).getTime())
        .sort((left, right) => (left.receivedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.receivedAt?.getTime() ?? Number.MAX_SAFE_INTEGER))[0];
      if (reply) {
        try {
          await persistProviderReply(deps.pool, message, reply);
        } catch (error) {
          const failureClient = await deps.pool.connect();
          try { await recordFailure(failureClient, message, claimed.attemptNumber, new ReplyPersistenceError(error), false, deps); } finally { failureClient.release(); }
          return;
        }
        const replyClient = await deps.pool.connect();
        try { await preSendReplyCheck(replyClient, message, claimed.attemptNumber, true, deps); } finally { replyClient.release(); }
        return;
      }
    } catch (error) {
      const failureClient = await deps.pool.connect();
      try { await recordFailure(failureClient, message, claimed.attemptNumber, error, false, deps); } finally { failureClient.release(); }
      return;
    }
  }
  const finalGateClient = await deps.pool.connect();
  try {
    if (!await preSendReplyCheck(finalGateClient, message, claimed.attemptNumber, false, deps)) return;
  } finally {
    finalGateClient.release();
  }
  let sent: Awaited<ReturnType<MailClient["sendEmail"]>>;
  let deliveryStarted = false;
  try {
    const storedBody = typeof message.metadata?.bodyText === "string" ? message.metadata.bodyText : "";
    const unsubscribeUrl = typeof message.metadata?.unsubscribeUrl === "string" ? message.metadata.unsubscribeUrl : undefined;
    if (!message.tracking_token) throw new MessagePreparationError("Message tracking token is missing; refusing to send");
    // The postal address is optional by owner decision (2026-09-15).
    if (!unsubscribeUrl) throw new MessagePreparationError("Unsubscribe URL is missing; refusing to send");
    if (!storedBody.trim()) throw new MessagePreparationError("Rendered message body is missing; refusing to send");
    const footerOptions = { sentVia: message.sent_via === true };
    const body = appendUnsubscribeFooter(storedBody, unsubscribeUrl, message.postal_address, footerOptions);
    const trackingUrl = message.open_tracking_enabled === true ? deps.apiBaseUrl.replace(/\/$/, "") + "/t/" + message.tracking_token + ".gif" : undefined;
    const html = renderEmailHtml(body, unsubscribeUrl, trackingUrl, message.postal_address, footerOptions);
    const sendInput = {
      connectedAccountId: message.composio_connected_account_id,
      userId: message.mailbox_user_id,
      provider: message.provider,
      to: message.recipient_email,
      subject: message.subject,
      body,
      html,
      from: message.mailbox_email ?? undefined,
      unsubscribeUrl,
      messageId: typeof message.metadata?.providerRfcMessageId === "string" ? message.metadata.providerRfcMessageId : undefined,
      inReplyTo: message.previous_rfc_message_id ?? undefined,
      threadId: message.previous_provider_thread_id ?? undefined,
    };
    try {
      if (sendInput.provider !== "smtp") assertComposioProvider(sendInput.provider, "send-message.sendEmail");
    } catch (error) {
      throw new MessagePreparationError(error instanceof Error ? error.message : String(error));
    }
    deliveryStarted = true;
    sent = await mailClient.sendEmail({ ...sendInput, provider: sendInput.provider });
  } catch (error) {
    const failureClient = await deps.pool.connect();
    try {
      await recordFailure(failureClient, message, claimed.attemptNumber, error, deliveryStarted, deps);
    } finally {
      failureClient.release();
    }
    return;
  }

  const acceptedClient = await deps.pool.connect();
  let accepted = false;
  try {
    accepted = await recordProviderAccepted(acceptedClient, message, claimed.attemptNumber, sent);
  } catch (error) {
    logger.error("Provider accepted message but acceptance persistence failed", { messageId: message.id, attemptNumber: claimed.attemptNumber, providerMessageId: sent.providerMessageId, error: error instanceof Error ? error.message : String(error) });
    return;
  } finally {
    acceptedClient.release();
  }
  if (!accepted) return;

  const bookkeepingClient = await deps.pool.connect();
  try {
    await completeAcceptedBookkeeping(bookkeepingClient, message, deps);
  } catch (error) {
    logger.error("Accepted message bookkeeping failed; leaving it for reconciliation", { messageId: message.id, attemptNumber: claimed.attemptNumber, providerMessageId: sent.providerMessageId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    bookkeepingClient.release();
  }
}
