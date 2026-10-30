import { canSend, entitlingSubscriptionSql, freePlanMonthlySendsSql, isCloudEdition, providerCircuitKey, providerCircuitKeySql, reconcileCampaignStatus, unlicensedWorkspaceSql, type DenyReason, type Edition } from "@inboxjoy/core";
import { createDb } from "@inboxjoy/db";
import type { TransactionalEmailService } from "@inboxjoy/email";
import type { ScheduleDueMessagesJob } from "@inboxjoy/queue";
import { enqueueJob, queueNames, type InboxJoyQueue } from "@inboxjoy/queue";
import type { Pool } from "pg";

import { logger } from "../logger.js";
import { notifyReplyReceived } from "../notify.js";
import { manualReplyEventSql } from "./send-message.js";

type DueMessage = {
  id: string;
  workspace_id: string;
  email_account_id: string;
  enrollment_id: string;
  campaign_id: string | null;
  sequence_step_id: string;
  idempotency_key: string;
  provider: string;
  owner_email_verified: boolean;
  workspace_status: string;
  kill_switch_enabled: boolean;
  postal_address: string | null;
  workspace_daily_cap: number;
  workspace_today: string;
  workspace_month: string;
  legacy_free_until: Date | null;
  subscription_status: string | null;
  subscription_trial_end: Date | null;
  subscription_on_hold_grace_ends_at: Date | null;
  mailbox_status: string;
  daily_limit: number;
  hourly_limit: number;
  ramp_started_on: string | null;
  ramp_paused_days: number;
  mailbox_today: string;
  mailbox_hour: string;
  mailbox_last_send_at: Date | null;
  in_sending_window: boolean;
  health_state: string | null;
  effective_daily_limit: number | null;
  throttled_until: Date | null;
  circuit_state: string | null;
  next_probe_at: Date | null;
  campaign_status: string | null;
  sequence_status: string;
  enrollment_status: string;
  suppressed: boolean;
  already_replied: boolean;
};

const PER_WORKSPACE_TICK_CAP_PAID = 1000;
const PER_WORKSPACE_TICK_CAP_DEFAULT = 100;
const GLOBAL_TICK_CAP = 3000;
// "Paid" here is the cloud entitlement rule, hasSendingEntitlement() in SQL
// (entitlingSubscriptionSql: active lifetime license or comp, a trial before its
// end, or on_hold inside its 7-day grace, matching subscription_on_hold_grace_ends_at
// below). `subscriptions.plan` is a legacy column Dodo never writes, so it must not
// gate the tick cap. Legacy Free and unlicensed workspaces keep the small tick.
export const PAID_WORKSPACE_TICK_CAP_SQL = entitlingSubscriptionSql("sub", "$1::timestamptz");

// Self-host is always entitled, so every workspace gets the paid tick size.
export function perWorkspaceTickCapSql(edition: Edition): string {
  return isCloudEdition(edition)
    ? `(CASE WHEN ${PAID_WORKSPACE_TICK_CAP_SQL} THEN ${PER_WORKSPACE_TICK_CAP_PAID} ELSE ${PER_WORKSPACE_TICK_CAP_DEFAULT} END)`
    : String(PER_WORKSPACE_TICK_CAP_PAID);
}

// Cloud workspaces with no license, comp or open legacy window (sendingPlan()
// "unlicensed") only ever get payment_required. Their due rows go after every
// other workspace's, so a backlog of them (all legacy windows end at the same
// second) only fills tick slots nobody else needs and never starves a
// workspace that can send. Each denial then parks the row for
// PAYMENT_REQUIRED_RETRY_MS, out of the due range. Self-host has no such rows.
export const UNLICENSED_WORKSPACE_SQL = unlicensedWorkspaceSql("sub", "plan_w", "$1::timestamptz");

export function dueOrderSql(edition: Edition): string {
  return isCloudEdition(edition)
    ? `${UNLICENSED_WORKSPACE_SQL},r.workspace_rank,m.scheduled_at,m.id`
    : "r.workspace_rank,m.scheduled_at,m.id";
}

// The plan joins behind the cloud tick size and order: the workspace row
// (legacy Free window) and its subscription (one row per workspace at most, so
// neither join changes which rows are due). Self-host reads neither and skips
// both lookups on every due row.
export function duePlanJoinsSql(edition: Edition): string {
  return isCloudEdition(edition)
    ? `JOIN workspaces plan_w ON plan_w.id=m.workspace_id
      LEFT JOIN subscriptions sub ON sub.workspace_id=m.workspace_id`
    : "";
}

export type ScheduleDueMessagesDeps = { pool: Pool; queue: InboxJoyQueue; edition: Edition; transactionalEmail?: TransactionalEmailService };
const SEND_MIN_GAP_MS = 30_000;
const SEND_MAX_GAP_MS = 90_000;
const TICK_HORIZON_MS = 120_000;
const SCHEDULER_ADVISORY_LOCK_KEY = 1_346_527_691;
const nextGap = (): number => SEND_MIN_GAP_MS + Math.floor(Math.random() * (SEND_MAX_GAP_MS - SEND_MIN_GAP_MS + 1));

export async function scheduleDueMessages(payload: ScheduleDueMessagesJob, deps?: ScheduleDueMessagesDeps): Promise<void> {
  if (!deps) return;
  const lockClient = await deps.pool.connect();
  let lockAcquired = false;
  try {
    const lockResult = await lockClient.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [SCHEDULER_ADVISORY_LOCK_KEY]);
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);
    if (!lockAcquired) {
      logger.info("scheduler tick skipped, already running", { job: "schedule-due-messages" });
      return;
    }

    await scheduleDueMessagesWithLock(payload, deps);
  } finally {
    try {
      if (lockAcquired) {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [SCHEDULER_ADVISORY_LOCK_KEY]);
      }
    } finally {
      lockClient.release();
    }
  }
}

async function scheduleDueMessagesWithLock(payload: ScheduleDueMessagesJob, deps: ScheduleDueMessagesDeps): Promise<void> {
  const now = payload.now ? new Date(payload.now) : new Date();
  await deps.pool.query(`WITH expired AS (
      UPDATE messages SET status='failed', error_class='unknown_provider_result',
        error_message='Send claim expired before acceptance was recorded', updated_at=now()
      WHERE status='sending' AND claim_expires_at < $1
      RETURNING id, enrollment_id
    ), attempts AS (
      UPDATE send_attempts sa SET status='failed', error_class='unknown_provider_result',
        error_message='Send claim expired before acceptance was recorded', finished_at=now()
      FROM expired WHERE sa.message_id=expired.id AND sa.status='sending'
      RETURNING sa.message_id
    )
    UPDATE enrollments e SET status='paused', stop_reason='provider_result_unknown', updated_at=now()
    FROM expired WHERE e.id=expired.enrollment_id AND e.status IN ('scheduled','active')`, [now]);

  const result = await deps.pool.query<DueMessage>(`WITH ranked AS (
      SELECT m.id,row_number() OVER (PARTITION BY m.workspace_id ORDER BY m.scheduled_at,m.id) AS workspace_rank
      FROM messages m
      WHERE m.status IN ('scheduled','retryable') AND m.scheduled_at <= $1
        ${payload.workspaceId ? "AND m.workspace_id=$2" : ""}
    ), due AS (
      SELECT m.*,r.workspace_rank FROM ranked r JOIN messages m ON m.id=r.id
      ${duePlanJoinsSql(deps.edition)}
      WHERE r.workspace_rank <= ${perWorkspaceTickCapSql(deps.edition)}
      ORDER BY ${dueOrderSql(deps.edition)}
      LIMIT ${GLOBAL_TICK_CAP}
    ), due_mailboxes AS MATERIALIZED (
      SELECT DISTINCT email_account_id FROM due
    ), due_workspaces AS MATERIALIZED (
      SELECT DISTINCT workspace_id FROM due
    ), provider_circuit_recovered AS (
      UPDATE provider_circuit pc SET state='open',next_probe_at=$1::timestamptz,updated_at=$1::timestamptz
      FROM (SELECT DISTINCT ${providerCircuitKeySql("ea")} AS provider FROM email_accounts ea JOIN due_mailboxes dm ON dm.email_account_id=ea.id) due_providers
      WHERE pc.provider=due_providers.provider AND pc.state='half_open' AND pc.updated_at < $1::timestamptz-interval '10 minutes'
      RETURNING pc.provider
    ), mailbox_hourly_usage AS MATERIALIZED (
      SELECT hm.email_account_id,count(*)::int AS accepted_count
      FROM messages hm JOIN due_mailboxes dm ON dm.email_account_id=hm.email_account_id
      WHERE (hm.status='accepted' AND hm.accepted_at > $1::timestamptz-interval '1 hour')
        OR (hm.status='sending' AND hm.claim_expires_at > $1::timestamptz)
      GROUP BY hm.email_account_id
    ), workspace_daily_usage AS MATERIALIZED (
      SELECT wm.workspace_id,count(*)::int AS accepted_count
      FROM messages wm JOIN due_workspaces dw ON dw.workspace_id=wm.workspace_id
      WHERE (wm.status='accepted' AND wm.accepted_at::date=($1::timestamptz AT TIME ZONE 'UTC')::date)
        OR (wm.status='sending' AND wm.claim_expires_at > $1::timestamptz)
      GROUP BY wm.workspace_id
    ), mailbox_daily_usage_with_inflight AS MATERIALIZED (
      SELECT dm.email_account_id,count(*)::int AS accepted_count
      FROM messages dm JOIN due_mailboxes due_box ON due_box.email_account_id=dm.email_account_id
      WHERE (dm.status='accepted' AND dm.accepted_at::date=($1::timestamptz AT TIME ZONE 'UTC')::date)
        OR (dm.status='sending' AND dm.claim_expires_at > $1::timestamptz)
      GROUP BY dm.email_account_id
    ), mailbox_gate AS MATERIALIZED (
      SELECT ea.id,ea.provider::text AS provider,ea.status::text AS mailbox_status,ea.daily_limit,ea.hourly_limit,ea.ramp_started_on,ea.ramp_paused_days,
        (COALESCE(du.accepted_count,0)+${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "ea.workspace_id", emailAccountIdSql: "ea.id", range: "today", nowSql: "$1::timestamptz" })})::text AS mailbox_today,
        (COALESCE(hu.accepted_count,0)+${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "ea.workspace_id", emailAccountIdSql: "ea.id", range: "last_hour", nowSql: "$1::timestamptz" })})::text AS mailbox_hour,
        last_send.mailbox_last_send_at,
        (NOT EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=ea.id AND ms.is_active=true)
          OR EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=ea.id AND ms.is_active=true
            AND ms.day_of_week=extract(dow FROM $1::timestamptz AT TIME ZONE ms.timezone)::int
            AND ($1::timestamptz AT TIME ZONE ms.timezone)::time BETWEEN ms.start_time AND ms.end_time)) AS in_sending_window,
        mh.state AS health_state,mh.effective_daily_limit,mh.throttled_until,
        pc.state AS circuit_state,pc.next_probe_at
      FROM email_accounts ea
      JOIN due_mailboxes dm ON dm.email_account_id=ea.id
      LEFT JOIN mailbox_daily_usage_with_inflight du ON du.email_account_id=ea.id
      LEFT JOIN mailbox_hourly_usage hu ON hu.email_account_id=ea.id
      LEFT JOIN mailbox_health mh ON mh.email_account_id=ea.id
      LEFT JOIN provider_circuit pc ON pc.provider=${providerCircuitKeySql("ea")}
      LEFT JOIN provider_circuit_recovered pcr ON pcr.provider=${providerCircuitKeySql("ea")}
      LEFT JOIN LATERAL (
        SELECT GREATEST(
          (SELECT max(lm.accepted_at) FROM messages lm WHERE lm.email_account_id=ea.id AND lm.status='accepted'),
          (SELECT max(lm.claimed_at) FROM messages lm
            WHERE lm.email_account_id=ea.id AND lm.status='sending' AND lm.claim_expires_at > $1::timestamptz),
          ${manualReplyEventSql({ aggregate: "latest", workspaceIdSql: "ea.workspace_id", emailAccountIdSql: "ea.id" })}
        ) AS mailbox_last_send_at
      ) last_send ON true
    ), workspace_gate AS MATERIALIZED (
      SELECT w.id,w.status::text AS workspace_status,w.kill_switch_enabled,w.postal_address,w.daily_send_cap AS workspace_daily_cap,w.legacy_free_until,
        (COALESCE(wu.accepted_count,0)+${manualReplyEventSql({ aggregate: "count", workspaceIdSql: "w.id", range: "today", nowSql: "$1::timestamptz" })})::text AS workspace_today,
        ${freePlanMonthlySendsSql({ workspaceIdSql: "w.id", nowSql: "$1::timestamptz" })}::text AS workspace_month,
        COALESCE((SELECT au.email_verified FROM memberships om
          JOIN auth_users au ON au.id=om.user_id
          WHERE om.workspace_id=w.id AND om.role='owner' AND om.status='active'
          ORDER BY om.created_at LIMIT 1),false) AS owner_email_verified,
        sub.status::text AS subscription_status,sub.trial_end AS subscription_trial_end,
        (sub.updated_at + interval '7 days') AS subscription_on_hold_grace_ends_at
      FROM workspaces w JOIN due_workspaces dw ON dw.workspace_id=w.id
      LEFT JOIN workspace_daily_usage wu ON wu.workspace_id=w.id
      LEFT JOIN subscriptions sub ON sub.workspace_id=w.id
    )
    SELECT m.id,m.workspace_id,m.email_account_id,m.enrollment_id,e.campaign_id,m.sequence_step_id,m.idempotency_key,m.workspace_rank,mg.provider,
      w.workspace_status,w.kill_switch_enabled,w.postal_address,w.workspace_daily_cap,w.workspace_today,w.workspace_month,w.legacy_free_until,w.owner_email_verified,
      w.subscription_status,w.subscription_trial_end,w.subscription_on_hold_grace_ends_at,
      mg.mailbox_status,mg.daily_limit,mg.hourly_limit,mg.ramp_started_on,mg.ramp_paused_days,mg.mailbox_today,mg.mailbox_hour,mg.mailbox_last_send_at,
      mg.in_sending_window,mg.health_state,mg.effective_daily_limit,mg.throttled_until,mg.circuit_state,mg.next_probe_at,
      ca.status::text AS campaign_status,s.status::text AS sequence_status,e.status::text AS enrollment_status,
      EXISTS (SELECT 1 FROM suppressions su WHERE su.workspace_id=m.workspace_id AND su.normalized_email=m.normalized_recipient_email) AS suppressed,
      (e.status='replied' OR c.status='replied' OR c.replied_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM message_events re LEFT JOIN messages rm ON rm.id=re.message_id
        WHERE re.workspace_id=m.workspace_id AND re.event_type='replied' AND (
          rm.contact_id=m.contact_id
          OR (m.conversation_thread_id IS NOT NULL AND rm.conversation_thread_id=m.conversation_thread_id)
          OR (m.provider_thread_id IS NOT NULL AND rm.provider_thread_id=m.provider_thread_id)
          OR lower(re.metadata->>'sender')=m.normalized_recipient_email
        )
      )) AS already_replied
    FROM due m
    JOIN enrollments e ON e.id=m.enrollment_id
    JOIN sequences s ON s.id=e.sequence_id
    LEFT JOIN campaigns ca ON ca.id=e.campaign_id
    JOIN mailbox_gate mg ON mg.id=m.email_account_id
    JOIN workspace_gate w ON w.id=m.workspace_id
    JOIN contacts c ON c.id=m.contact_id
    ORDER BY m.workspace_rank,m.scheduled_at,m.id`, payload.workspaceId ? [now, payload.workspaceId] : [now]);

  const denied: Array<{ id: string; reason: DenyReason; retryAt?: Date }> = [];
  const scheduledProbes = new Set<string>();
  const mailboxNextAllowed = new Map<string, number>();
  let enqueued = 0;
  for (const row of result.rows) {
    const circuitKey = providerCircuitKey(row.provider, row.email_account_id);
    const probeDue = row.circuit_state === "open" && Boolean(row.next_probe_at) && new Date(row.next_probe_at!) <= now && !scheduledProbes.has(circuitKey);
    const decision = row.campaign_id && row.campaign_status !== "active"
      ? { allowed: false as const, reason: "sequence_inactive" as DenyReason, retryAt: new Date(now.getTime() + 15 * 60_000) }
      : canSend({
        now,
        edition: deps.edition,
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
          trialEnd: row.subscription_trial_end,
          onHoldGraceEndsAt: row.subscription_on_hold_grace_ends_at,
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
        },
        health: row.health_state ? { state: row.health_state, effectiveDailyLimit: row.effective_daily_limit, throttledUntil: row.throttled_until } : null,
        providerCircuit: row.circuit_state ? { state: row.circuit_state, nextProbeAt: row.next_probe_at, probeAllowed: probeDue } : null,
      }, {
        sequenceStatus: row.sequence_status,
        enrollmentStatus: row.enrollment_status,
        suppressed: row.suppressed,
        alreadyReplied: row.already_replied,
      });
    if (!decision.allowed) {
      denied.push({ id: row.id, reason: decision.reason, retryAt: decision.retryAt });
      continue;
    }
    const mb = row.email_account_id;
    const nowMs = now.getTime();
    const nextAllowedAt = mailboxNextAllowed.get(mb)
      ?? Math.max(nowMs, row.mailbox_last_send_at ? new Date(row.mailbox_last_send_at).getTime() + nextGap() : nowMs);
    if (nextAllowedAt > nowMs + TICK_HORIZON_MS) {
      denied.push({ id: row.id, reason: "mailbox_min_gap", retryAt: new Date(nextAllowedAt) });
      mailboxNextAllowed.set(mb, nextAllowedAt + nextGap());
      continue;
    }
    if (probeDue) scheduledProbes.add(circuitKey);
    await enqueueJob(
      deps.queue,
      queueNames.sendMessage,
      { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, sequenceStepId: row.sequence_step_id, idempotencyKey: row.idempotency_key },
      { singletonKey: row.idempotency_key, ...(nextAllowedAt > nowMs ? { startAfter: new Date(nextAllowedAt) } : {}) },
    );
    enqueued += 1;
    mailboxNextAllowed.set(mb, nextAllowedAt > nowMs ? nextAllowedAt + nextGap() : nowMs + nextGap());
  }

  if (denied.length) {
    const deniedResult = await deps.pool.query<{ replied_enrollment_ids: string[] | null; campaigns: Array<{ campaignId: string; workspaceId: string }> | null }>(`WITH denied AS (
        SELECT * FROM unnest($1::uuid[],$2::text[],$3::timestamptz[]) AS d(id,reason,retry_at)
      ), updated_messages AS (
        UPDATE messages m SET blocked_reason=d.reason,
          status=CASE WHEN d.retry_at IS NULL THEN 'cancelled'::message_status ELSE m.status END,
          scheduled_at=CASE WHEN d.retry_at IS NOT NULL AND d.retry_at > m.scheduled_at THEN d.retry_at ELSE m.scheduled_at END,
          updated_at=now()
        FROM denied d WHERE m.id=d.id AND m.status IN ('scheduled','retryable')
        RETURNING m.enrollment_id,m.contact_id,d.reason
      ), suppressed AS (
        UPDATE enrollments e SET status='unsubscribed',stopped_at=now(),stop_reason='suppressed',next_due_at=NULL,updated_at=now()
        FROM updated_messages u WHERE e.id=u.enrollment_id AND u.reason='suppressed'
        RETURNING e.campaign_id,e.workspace_id
      ), replied AS (
        -- Excludes already-'replied' enrollments so RETURNING only reports the first
        -- transition into 'replied' -- the signal used to send the reply-received email
        -- at most once per enrollment, even though this job runs every 2 minutes.
        UPDATE enrollments e SET status='replied',stopped_at=COALESCE(stopped_at,now()),stop_reason='reply_detected',next_due_at=NULL,updated_at=now()
        FROM updated_messages u WHERE e.id=u.enrollment_id AND u.reason='already_replied' AND e.status <> 'replied'
        RETURNING e.id,e.campaign_id,e.workspace_id
      ), replied_contacts AS (
        UPDATE contacts c SET status='replied',replied_at=COALESCE(replied_at,now()),updated_at=now()
        FROM updated_messages u WHERE c.id=u.contact_id AND u.reason='already_replied'
      ) SELECT (SELECT array_agg(id) FROM replied) AS replied_enrollment_ids,
        (SELECT json_agg(json_build_object('campaignId',campaign_id,'workspaceId',workspace_id)) FROM (
          SELECT campaign_id,workspace_id FROM suppressed WHERE campaign_id IS NOT NULL
          UNION SELECT campaign_id,workspace_id FROM replied WHERE campaign_id IS NOT NULL
        ) stopped_campaigns) AS campaigns`, [
      denied.map((item) => item.id),
      denied.map((item) => item.reason),
      denied.map((item) => item.retryAt ?? null),
    ]);
    const db = createDb(deps.pool);
    for (const campaign of (deniedResult.rows[0]?.campaigns ?? []).sort((left, right) => left.campaignId.localeCompare(right.campaignId))) {
      // The enrollment changes above are already committed; the status sweep
      // converges a missed reconcile, so a failure here must not skip the reply emails below.
      try {
        await reconcileCampaignStatus(db, campaign);
      } catch (error) {
        logger.error("Campaign status reconciliation failed", { job: "schedule-due-messages", campaignId: campaign.campaignId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const enrollmentId of deniedResult.rows[0]?.replied_enrollment_ids ?? []) {
      await notifyReplyReceived({ pool: deps.pool, transactionalEmail: deps.transactionalEmail }, enrollmentId);
    }
  }

  logger.info("Enqueued due messages", {
    job: "schedule-due-messages",
    workspaceId: payload.workspaceId,
    now: now.toISOString(),
    candidates: result.rowCount ?? 0,
    denied: denied.length,
    count: enqueued,
  });
}
