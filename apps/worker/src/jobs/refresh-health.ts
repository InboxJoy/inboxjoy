import type { TransactionalEmailService } from "@inboxjoy/email";
import type { RefreshHealthJob } from "@inboxjoy/queue";
import type { Pool, QueryResult } from "pg";

import { logger } from "../logger.js";
import { NON_SENDING_HEALTH_STATES, notifyMailboxAlert } from "../notify.js";

type Dependencies = { pool: Pool; transactionalEmail?: TransactionalEmailService };

const HEALTH_BATCH_SIZE = 200;

// The daily billing check (comp expiry) only needs to run once a day. refreshHealth
// runs every 15 minutes (see packages/queue's scheduleRecurringJobs), so this guards
// it to a single 15-minute window per UTC day rather than adding a new pg-boss
// job/cron entry. Running on more than one worker replica in that window is
// harmless: expiring comps is an idempotent UPDATE.
export function isDailyBillingCheckWindow(now: Date): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 15;
}

// expireCompSubscriptions in @inboxjoy/core does the same thing against a
// Drizzle db handle (used by the admin CLI and tests); this job only has a
// raw pg Pool, so it runs the equivalent SQL directly instead of pulling in
// the core package here.
export async function expireCompSubscriptions(pool: Pool, now: Date = new Date()): Promise<number> {
  const result = await pool.query(
    `UPDATE subscriptions
     SET status = 'expired', updated_at = $1
     WHERE status = 'active'
       AND dodo_subscription_id IS NULL
       AND metadata->>'comp' = 'true'
       AND next_billing_date IS NOT NULL
       AND next_billing_date < $1`,
    [now],
  );
  return result.rowCount ?? 0;
}

export async function refreshHealth(payload: RefreshHealthJob, deps?: Dependencies): Promise<void> {
  if (!deps) return;

  let cursor: string | null = null;
  let refreshed = 0;

  do {
    const result: QueryResult<{ id: string; mailbox_email: string; workspace_id: string; new_state: string; previous_state: string | null }> = await deps.pool.query<{ id: string; mailbox_email: string; workspace_id: string; new_state: string; previous_state: string | null }>(`
      WITH selected AS (
        SELECT id, workspace_id, daily_limit
        FROM email_accounts
        WHERE status = 'active'
          AND ($1::uuid IS NULL OR workspace_id = $1)
          AND ($2::uuid IS NULL OR id = $2)
          AND ($3::uuid IS NULL OR id > $3)
        ORDER BY id
        LIMIT $4
      ), existing_health AS (
        -- Pre-update snapshot (this WITH query's CTEs all read the same pre-statement
        -- snapshot), used below to detect a mailbox transitioning into a non-sending
        -- state so an alert email fires once, on the transition, not on every refresh.
        SELECT email_account_id, state FROM mailbox_health WHERE email_account_id IN (SELECT id FROM selected)
      ), ordered_messages AS (
        SELECT m.email_account_id, m.status, m.error_class, m.accepted_at, m.bounced_at, m.created_at,
          count(*) FILTER (WHERE m.status <> 'failed') OVER (
            PARTITION BY m.email_account_id
            ORDER BY m.created_at DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS newer_non_failures
        FROM messages m
        JOIN selected s ON s.id = m.email_account_id
        -- Messages are created when the lead is enrolled, often days before they
        -- send. Window sent mail by when it was sent, or a mailbox working through
        -- a backlog reads as "never sent" and its bounce rate loses its denominator.
        WHERE COALESCE(m.accepted_at, m.created_at) >= now() - interval '7 days'
      ), message_stats AS (
        SELECT email_account_id,
          count(*) FILTER (WHERE status = 'accepted') AS accepted_count,
          count(*) FILTER (WHERE status = 'failed' AND newer_non_failures = 0) AS consecutive_failures,
          count(*) FILTER (
            WHERE COALESCE(bounced_at, created_at) >= now() - interval '24 hours'
              AND (status = 'failed' OR bounced_at IS NOT NULL)
              AND error_class IN ('hard_bounce', 'domain_not_found', 'spam_block', 'policy_rejection')
          ) AS perm_failures_24h,
          count(*) FILTER (
            WHERE created_at >= now() - interval '24 hours'
              AND status IN ('failed', 'retryable')
              AND COALESCE(error_class, '') NOT IN ('hard_bounce', 'domain_not_found', 'spam_block', 'policy_rejection')
          ) AS temp_failures_24h,
          max(accepted_at) FILTER (WHERE status = 'accepted') AS last_successful_send_at
        FROM ordered_messages
        GROUP BY email_account_id
      ), event_stats AS (
        SELECT m.email_account_id,
          count(DISTINCT me.message_id) FILTER (WHERE me.event_type IN ('hard_bounce', 'domain_not_found', 'spam_block', 'policy_rejection', 'bounced')) AS bounce_count,
          -- Recency signal. bounce_rate is a 7-day ratio whose denominator stops
          -- growing the moment a mailbox is blocked from sending, so it can freeze
          -- high and hold the mailbox down. This says whether the damage is ongoing.
          count(DISTINCT me.message_id) FILTER (
            WHERE me.event_type IN ('hard_bounce', 'domain_not_found', 'spam_block', 'policy_rejection', 'bounced')
              AND me.occurred_at >= now() - interval '24 hours'
          ) AS bounce_count_24h,
          count(DISTINCT me.message_id) FILTER (WHERE me.event_type = 'replied') AS reply_count
        FROM message_events me
        JOIN messages m ON m.id = me.message_id
        JOIN selected s ON s.id = m.email_account_id
        WHERE me.occurred_at >= now() - interval '7 days'
        GROUP BY m.email_account_id
      ), health_rows AS (
        SELECT s.id AS email_account_id, s.workspace_id,
          COALESCE(ms.consecutive_failures, 0)::int AS consecutive_failures,
          COALESCE(ms.temp_failures_24h, 0)::int AS temp_failures_24h,
          COALESCE(ms.perm_failures_24h, 0)::int AS perm_failures_24h,
          COALESCE(es.bounce_count_24h, 0)::int AS bounce_count_24h,
          ROUND(100.0 * COALESCE(es.bounce_count, 0) / NULLIF(COALESCE(ms.accepted_count, 0), 0), 2) AS bounce_rate,
          ROUND(100.0 * COALESCE(es.reply_count, 0) / NULLIF(COALESCE(ms.accepted_count, 0), 0), 2) AS reply_rate,
          ms.last_successful_send_at,
          s.daily_limit
        FROM selected s
        LEFT JOIN message_stats ms ON ms.email_account_id = s.id
        LEFT JOIN event_stats es ON es.email_account_id = s.id
      ), upserted AS (
        INSERT INTO mailbox_health (
          id, workspace_id, email_account_id, state, effective_daily_limit,
          consecutive_failures, temp_failures_24h, perm_failures_24h,
          bounce_rate, reply_rate, last_successful_send_at, updated_at
        )
        SELECT gen_random_uuid(), workspace_id, email_account_id,
          -- 'critical' sets the limit to 0 and can_send rejects the state outright,
          -- so it must only hold while the damage is ongoing. A stale 7-day bounce
          -- rate with no bounce in the last 24h steps down to 'degraded', which
          -- still sends at half volume -- that trickle grows the denominator and
          -- lets the mailbox climb back instead of sitting dead until the window
          -- ages out. A fresh bounce snaps it straight back to 'critical'.
          CASE
            WHEN perm_failures_24h >= 3 OR (COALESCE(bounce_rate, 0) >= 5 AND bounce_count_24h > 0) THEN 'critical'
            WHEN consecutive_failures >= 3 OR temp_failures_24h >= 3 OR COALESCE(bounce_rate, 0) >= 2 THEN 'degraded'
            ELSE 'healthy'
          END,
          CASE
            WHEN perm_failures_24h >= 3 OR (COALESCE(bounce_rate, 0) >= 5 AND bounce_count_24h > 0) THEN 0
            WHEN consecutive_failures >= 3 OR temp_failures_24h >= 3 OR COALESCE(bounce_rate, 0) >= 2 THEN GREATEST(1, FLOOR(daily_limit * 0.5)::int)
            ELSE daily_limit
          END,
          consecutive_failures, temp_failures_24h, perm_failures_24h,
          COALESCE(bounce_rate, 0), COALESCE(reply_rate, 0), last_successful_send_at, now()
        FROM health_rows
        ON CONFLICT (email_account_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          -- state and effective_daily_limit are shared with the send path. This job
          -- must not un-pause a dead-token mailbox every 15 minutes, nor undo a live
          -- throttle window -- but it must not hold a mailbox down forever either.
          -- 'auth_error'/'paused'/'disconnected' are operator- or token-owned: only
          -- the send path or the user clears them. An unexpired throttle belongs to
          -- the send-path ladder. Everything else -- an expired throttle,
          -- 'quota_exceeded', 'reputation_warning', 'critical', 'degraded' -- is
          -- metric-derived and decays back down once the metrics agree, otherwise a
          -- mailbox that can't send can never produce the successful send that was
          -- its only way out.
          state = CASE
            WHEN mailbox_health.state IN ('auth_error','paused','disconnected')
              THEN mailbox_health.state
            WHEN mailbox_health.state = 'throttled'
              AND mailbox_health.throttled_until IS NOT NULL
              AND mailbox_health.throttled_until > now()
              THEN mailbox_health.state
            ELSE EXCLUDED.state
          END,
          effective_daily_limit = CASE
            WHEN mailbox_health.throttled_until IS NOT NULL AND mailbox_health.throttled_until > now()
              THEN mailbox_health.effective_daily_limit
            WHEN mailbox_health.state IN ('auth_error','paused','disconnected')
              THEN mailbox_health.effective_daily_limit
            ELSE EXCLUDED.effective_daily_limit
          END,
          consecutive_failures = GREATEST(mailbox_health.consecutive_failures, EXCLUDED.consecutive_failures),
          temp_failures_24h = EXCLUDED.temp_failures_24h,
          perm_failures_24h = EXCLUDED.perm_failures_24h,
          bounce_rate = EXCLUDED.bounce_rate,
          reply_rate = EXCLUDED.reply_rate,
          last_successful_send_at = EXCLUDED.last_successful_send_at,
          updated_at = now()
        RETURNING email_account_id, state
      )
      UPDATE email_accounts ea
      SET last_health_check_at = now(),
          -- Engagement-aware warm-up: a degraded day does not count toward the
          -- ramp. Increment at most once per calendar day while health is bad.
          -- 'degraded'/'critical' are the states bounces actually produce, so they
          -- belong here -- without them the badge claimed bounces paused the ramp
          -- while only a throttle ever did.
          ramp_paused_days = CASE
            WHEN u.state IN ('throttled','reputation_warning','quota_exceeded','degraded','critical')
              AND (ea.ramp_pause_last_date IS NULL OR ea.ramp_pause_last_date < CURRENT_DATE)
              THEN ea.ramp_paused_days + 1
            ELSE ea.ramp_paused_days
          END,
          ramp_pause_last_date = CASE
            WHEN u.state IN ('throttled','reputation_warning','quota_exceeded','degraded','critical')
              THEN CURRENT_DATE
            ELSE ea.ramp_pause_last_date
          END,
          updated_at = now()
      FROM upserted u
      LEFT JOIN existing_health eh ON eh.email_account_id = u.email_account_id
      WHERE ea.id = u.email_account_id
      RETURNING ea.id, ea.email AS mailbox_email, ea.workspace_id, u.state AS new_state, eh.state AS previous_state
    `, [payload.workspaceId ?? null, payload.mailboxId ?? null, cursor, HEALTH_BATCH_SIZE]);

    refreshed += result.rowCount ?? 0;
    cursor = result.rows.reduce<string | null>((latest, row) => latest === null || row.id > latest ? row.id : latest, null);

    if (deps.transactionalEmail?.enabled) {
      for (const row of result.rows) {
        const wasSending = !NON_SENDING_HEALTH_STATES.has(row.previous_state ?? "healthy");
        if (wasSending && NON_SENDING_HEALTH_STATES.has(row.new_state)) {
          await notifyMailboxAlert({ pool: deps.pool, transactionalEmail: deps.transactionalEmail }, {
            workspaceId: row.workspace_id,
            mailboxEmail: row.mailbox_email,
            state: row.new_state,
          });
        }
      }
    }

    if (payload.mailboxId || (result.rowCount ?? 0) < HEALTH_BATCH_SIZE) break;
  } while (cursor);

  logger.info("Refreshed mailbox health", { job: "refresh-health", workspaceId: payload.workspaceId, mailboxId: payload.mailboxId, count: refreshed });

  if (!payload.workspaceId && !payload.mailboxId && isDailyBillingCheckWindow(new Date())) {
    // A failure here must never break the rest of the (already-completed) health refresh.
    try {
      const expired = await expireCompSubscriptions(deps.pool);
      if (expired) logger.info("Expired comp subscriptions", { job: "refresh-health", count: expired });
    } catch (error) {
      logger.warn("Failed to expire comp subscriptions", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
