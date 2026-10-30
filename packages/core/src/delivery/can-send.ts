import { isCloudEdition, type Edition } from "../edition.js";

export type DenyReason =
  // Cloud workspace with no lifetime license, comp or legacy Free window.
  | "payment_required"
  | "email_unverified"
  | "workspace_inactive"
  | "kill_switch"
  | "sequence_inactive"
  | "enrollment_inactive"
  | "mailbox_inactive"
  | "suppressed"
  | "mailbox_daily_cap"
  | "mailbox_hourly_cap"
  | "mailbox_min_gap"
  | "workspace_daily_cap"
  | "free_monthly_cap"
  | "warmup_limit"
  | "outside_window"
  | "mailbox_throttled"
  | "mailbox_unhealthy"
  | "provider_circuit_open"
  | "already_replied";

export type MailboxHealthState =
  | "healthy"
  | "degraded"
  | "critical"
  | "throttled"
  | "auth_error"
  | "quota_exceeded"
  | "reputation_warning"
  | "paused"
  | "disconnected";

export const UNHEALTHY_MAILBOX_STATES = new Set<MailboxHealthState>([
  "degraded",
  "critical",
  "throttled",
  "auth_error",
  "quota_exceeded",
  "reputation_warning",
  "paused",
  "disconnected",
]);

export type ProviderCircuitState = "closed" | "open" | "half_open";

export type CanSendContext = {
  now: Date;
  // Self-host is always entitled; cloud reads the subscription and the legacy
  // Free window.
  edition: Edition;
  ownerEmailVerified: boolean;
  workspace: {
    status: string;
    killSwitchEnabled: boolean;
    postalAddress?: string | null;
    dailySendCap: number;
    sentToday: number;
    // Campaign sends this UTC calendar month (accepted + in flight); see
    // freePlanMonthlySendsSql. Only gates legacy Free workspaces.
    sentThisMonth: number;
    // workspaces.legacy_free_until: hosted workspaces that were on the old Free
    // plan when the lifetime-only release shipped keep its rules until then.
    legacyFreeUntil: Date | null;
  };
  subscription: {
    status: string | null;
    trialEnd?: Date | null;
    onHoldGraceEndsAt?: Date | null;
  } | null;
  mailbox: {
    status: string;
    dailyLimit: number;
    hourlyLimit: number;
    rampStartedOn?: string | Date | null;
    rampPausedDays?: number | null;
    sentToday: number;
    sentLastHour: number;
    inSendingWindow: boolean;
    nextWindowAt?: Date | null;
    nextAllowedAt?: Date | null;
  };
  health?: {
    state: MailboxHealthState | string;
    effectiveDailyLimit?: number | null;
    throttledUntil?: Date | null;
  } | null;
  providerCircuit?: {
    state: ProviderCircuitState | string;
    nextProbeAt?: Date | null;
    probeAllowed?: boolean;
  } | null;
};

export type CanSendInput = {
  sequenceStatus: string;
  enrollmentStatus: string;
  suppressed: boolean;
  alreadyReplied: boolean;
  mode?: "sequence" | "manual_reply";
};

export type CanSendResult = { allowed: true } | { allowed: false; reason: DenyReason; retryAt?: Date };

const MINUTE = 60_000;
const DAY = 86_400_000;

// How long a payment_required message waits before the gate looks at it again.
// Every entitlement path (lifetime license, comp, a Dodo subscription that
// becomes entitling) releases parked email at once (releasePlanBlockedSends),
// so this recheck is only the fallback for a change that skips them, such as a
// manual fix in the database. Six hours keeps that fallback inside a working
// day while an unpaid backlog is rechecked 4 times a day instead of 96, so
// workspaces that never buy do not churn the scheduler.
export const PAYMENT_REQUIRED_RETRY_MS = 6 * 60 * MINUTE;

function retryIn(now: Date, milliseconds: number): Date {
  return new Date(now.getTime() + milliseconds);
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

// Legacy Free plan: hosted workspaces stamped
// with workspaces.legacy_free_until keep sending until then, capped per UTC
// calendar month, with a "Sent via InboxJoy" footer. Manual replies never count
// and are never capped. Nobody new joins it.
export const FREE_PLAN_MONTHLY_SEND_LIMIT = 10_000;
export const FREE_PLAN_CONTACT_LIMIT = 2_500;

export function freePlanMonthResetsAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Campaign sends this UTC month, counted like the daily caps: accepted, in
// flight, or an ambiguous provider result. The single count for the worker
// gates, billing.get, campaign status and the delivery advisor (via sql.raw;
// callers pass column references, never user input).
export function freePlanMonthlySendsSql(options: { workspaceIdSql: string; nowSql?: string; excludeMessageIdSql?: string }): string {
  const nowSql = options.nowSql ?? "now()";
  const monthStart = `(date_trunc('month', ${nowSql} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
  const exclude = options.excludeMessageIdSql ? ` AND month_message.id<>${options.excludeMessageIdSql}` : "";
  return `(SELECT count(*) FROM messages month_message
    WHERE month_message.workspace_id=${options.workspaceIdSql}${exclude} AND (
      (month_message.status='accepted' AND month_message.accepted_at >= ${monthStart})
      OR (month_message.status='sending' AND month_message.claim_expires_at > ${nowSql})
      OR (month_message.status='failed' AND month_message.error_class='unknown_provider_result' AND month_message.updated_at >= ${monthStart})
    ))`;
}

// The single entitlement rule: self-host is always entitled; in cloud a
// lifetime license or comp (status active), a trial before its end, or on_hold
// inside its 7-day grace. Entitled workspaces send with no monthly cap and no
// footer. canSend() enforces it; billing.get, campaign status and the delivery
// advisor reuse it (through sendingPlan) so the app can never disagree with
// what the worker allows. entitlingSubscriptionSql() is the same rule in SQL.
export function hasSendingEntitlement(subscription: CanSendContext["subscription"], now: Date, edition: Edition): boolean {
  if (!isCloudEdition(edition)) return true;
  if (!subscription?.status) return false;
  if (subscription.status === "active") return true;
  if (subscription.status === "trialing") return Boolean(subscription.trialEnd && subscription.trialEnd > now);
  if (subscription.status === "on_hold") return Boolean(subscription.onHoldGraceEndsAt && subscription.onHoldGraceEndsAt > now);
  return false;
}

// hasSendingEntitlement() for one subscriptions row in SQL, cloud only (the
// edition is never in the database). The on_hold grace matches the worker's
// updated_at + 7 days. Callers pass a table alias and a timestamp expression,
// never user input. Migration 0042 inlines the same rule.
export function entitlingSubscriptionSql(alias: string, nowSql = "now()"): string {
  return `(${alias}.status='active' OR (${alias}.status='trialing' AND ${alias}.trial_end > ${nowSql}) OR (${alias}.status='on_hold' AND ${alias}.updated_at + interval '7 days' > ${nowSql}))`;
}

// sendingPlan() === "unlicensed" in SQL, cloud only: no entitling subscription
// and no legacy Free window still open. A missing subscription row (LEFT JOIN)
// or a NULL window counts as neither. Callers pass table aliases and a
// timestamp expression, never user input.
export function unlicensedWorkspaceSql(subscriptionAlias: string, workspaceAlias: string, nowSql = "now()"): string {
  return `(NOT COALESCE(${entitlingSubscriptionSql(subscriptionAlias, nowSql)}, false) AND NOT COALESCE(${workspaceAlias}.legacy_free_until > ${nowSql}, false))`;
}

// What a workspace's campaign sends get. "entitled": no cap, no footer.
// "legacy_free": the old Free plan's monthly cap and footer until
// legacy_free_until. "unlicensed" (cloud only): blocked with payment_required
// until the $79 lifetime license is bought.
export type SendingPlan = "entitled" | "legacy_free" | "unlicensed";

export function sendingPlan(input: { edition: Edition; subscription: CanSendContext["subscription"]; legacyFreeUntil: Date | null }, now: Date): SendingPlan {
  if (hasSendingEntitlement(input.subscription, now, input.edition)) return "entitled";
  if (input.legacyFreeUntil && input.legacyFreeUntil > now) return "legacy_free";
  return "unlicensed";
}

// The plan's answer to "can campaign email go out now?", the same one canSend()
// gives at workspace level. A count that failed to load (NaN) fails closed.
export function planAllowsCampaignSends(plan: SendingPlan, sentThisMonth: number): boolean {
  if (plan === "entitled") return true;
  if (plan === "legacy_free") return sentThisMonth < FREE_PLAN_MONTHLY_SEND_LIMIT;
  return false;
}

export const WARMUP_START = 8;
export const WARMUP_GROWTH = 1.15;

export function warmupRampDays(rampStartedOn: string | Date | null | undefined, now: Date, pausedDays = 0): number | null {
  if (!rampStartedOn) return null;
  const start = rampStartedOn instanceof Date
    ? rampStartedOn
    : new Date(rampStartedOn.includes("T") ? rampStartedOn : `${rampStartedOn}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / DAY) - Math.max(0, pausedDays));
}

// 21-day reputation ramp: start at 8/day and compound ~15% daily, so a
// 50/day inbox reaches full speed in ~2 weeks instead of overnight.
export function warmupDailyLimit(dailyLimit: number, rampStartedOn: string | Date | null | undefined, now: Date, pausedDays = 0): number {
  const rampDays = warmupRampDays(rampStartedOn, now, pausedDays);
  if (rampDays === null) return dailyLimit;
  return Math.min(dailyLimit, Math.max(WARMUP_START, Math.round(WARMUP_START * WARMUP_GROWTH ** rampDays)));
}

export function warmupFullOn(dailyLimit: number, rampStartedOn: string | Date | null | undefined, pausedDays = 0): string | null {
  if (!rampStartedOn || dailyLimit <= WARMUP_START) return null;
  const start = new Date(`${String(rampStartedOn).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const daysNeeded = Math.ceil(Math.log(dailyLimit / WARMUP_START) / Math.log(WARMUP_GROWTH));
  return new Date(start.getTime() + (daysNeeded + Math.max(0, pausedDays)) * DAY).toISOString().slice(0, 10);
}

export function canSend(ctx: CanSendContext, input: CanSendInput): CanSendResult {
  const retrySoon = () => retryIn(ctx.now, 15 * MINUTE);

  if (ctx.workspace.status !== "active") return { allowed: false, reason: "workspace_inactive", retryAt: retrySoon() };
  if (ctx.workspace.killSwitchEnabled) return { allowed: false, reason: "kill_switch", retryAt: retrySoon() };
  if (!ctx.ownerEmailVerified) return { allowed: false, reason: "email_unverified", retryAt: retryIn(ctx.now, 60 * MINUTE) };
  if (input.mode !== "manual_reply") {
    if (input.sequenceStatus !== "active") return { allowed: false, reason: "sequence_inactive", retryAt: retrySoon() };
    if (input.alreadyReplied || input.enrollmentStatus === "replied") return { allowed: false, reason: "already_replied" };
    if (input.enrollmentStatus !== "scheduled" && input.enrollmentStatus !== "active") {
      return { allowed: false, reason: "enrollment_inactive", retryAt: retrySoon() };
    }
  }
  if (ctx.mailbox.status !== "active") return { allowed: false, reason: "mailbox_inactive", retryAt: retrySoon() };
  if (input.suppressed) return { allowed: false, reason: "suppressed" };
  // The plan never gates manual replies: an unlicensed or capped workspace can
  // still answer the people who wrote back.
  if (input.mode !== "manual_reply") {
    const plan = sendingPlan({ edition: ctx.edition, subscription: ctx.subscription, legacyFreeUntil: ctx.workspace.legacyFreeUntil }, ctx.now);
    // Getting the license releases parked messages at once
    // (releasePlanBlockedSends); the long recheck is only the fallback.
    if (plan === "unlicensed") return { allowed: false, reason: "payment_required", retryAt: retryIn(ctx.now, PAYMENT_REQUIRED_RETRY_MS) };
    if (!planAllowsCampaignSends(plan, ctx.workspace.sentThisMonth)) {
      // Wait for the month to reset, but no later than the end of the legacy
      // Free window, when the message is rechecked (and becomes payment_required).
      const monthResetsAt = freePlanMonthResetsAt(ctx.now);
      const legacyEndsAt = ctx.workspace.legacyFreeUntil;
      return { allowed: false, reason: "free_monthly_cap", retryAt: legacyEndsAt && legacyEndsAt < monthResetsAt ? legacyEndsAt : monthResetsAt };
    }
  }
  // Postal address is deliberately NOT a send blocker (owner decision,
  // 2026-09-15): when set it renders in the footer; when absent, sends proceed.

  const circuit = ctx.providerCircuit;
  if ((circuit?.state === "open" || circuit?.state === "half_open") && !circuit.probeAllowed) {
    const nextProbeAt = circuit.nextProbeAt && circuit.nextProbeAt > ctx.now ? circuit.nextProbeAt : retryIn(ctx.now, 15 * MINUTE);
    return { allowed: false, reason: "provider_circuit_open", retryAt: nextProbeAt };
  }

  const health = ctx.health;
  if (health?.state === "throttled" && health.throttledUntil && health.throttledUntil > ctx.now) {
    return { allowed: false, reason: "mailbox_throttled", retryAt: health.throttledUntil };
  }
  if (health && health.state !== "healthy" && health.state !== "degraded" && health.state !== "throttled") {
    return { allowed: false, reason: "mailbox_unhealthy", retryAt: retryIn(ctx.now, 60 * MINUTE) };
  }

  const effectiveDailyLimit = Math.max(0, health?.state === "healthy" ? ctx.mailbox.dailyLimit : health?.effectiveDailyLimit ?? ctx.mailbox.dailyLimit);
  if (ctx.mailbox.sentToday >= effectiveDailyLimit) {
    return { allowed: false, reason: "mailbox_daily_cap", retryAt: nextUtcDay(ctx.now) };
  }
  if (ctx.workspace.sentToday >= ctx.workspace.dailySendCap) {
    return { allowed: false, reason: "workspace_daily_cap", retryAt: nextUtcDay(ctx.now) };
  }

  // Human replies keep safety, entitlement, health, and daily-volume gates,
  // but do not wait for campaign pacing rules.
  if (input.mode !== "manual_reply") {
    if (ctx.mailbox.sentLastHour >= ctx.mailbox.hourlyLimit) {
      return { allowed: false, reason: "mailbox_hourly_cap", retryAt: retryIn(ctx.now, 60 * MINUTE) };
    }
    const warmupLimit = warmupDailyLimit(effectiveDailyLimit, ctx.mailbox.rampStartedOn, ctx.now, ctx.mailbox.rampPausedDays ?? 0);
    if (ctx.mailbox.sentToday >= warmupLimit) {
      return { allowed: false, reason: "warmup_limit", retryAt: nextUtcDay(ctx.now) };
    }
    if (!ctx.mailbox.inSendingWindow) {
      return { allowed: false, reason: "outside_window", retryAt: ctx.mailbox.nextWindowAt ?? retrySoon() };
    }
    if (ctx.mailbox.nextAllowedAt && ctx.mailbox.nextAllowedAt > ctx.now) {
      return { allowed: false, reason: "mailbox_min_gap", retryAt: ctx.mailbox.nextAllowedAt };
    }
  }

  return { allowed: true };
}
