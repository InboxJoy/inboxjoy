import { describe, expect, it } from "vitest";

import {
  canSend,
  entitlingSubscriptionSql,
  FREE_PLAN_MONTHLY_SEND_LIMIT,
  hasSendingEntitlement,
  mailboxHealthAfterFailure,
  mailboxHealthAfterSuccess,
  PAYMENT_REQUIRED_RETRY_MS,
  planAllowsCampaignSends,
  sendingPlan,
  unlicensedWorkspaceSql,
  type CanSendContext,
  type CanSendInput,
  type DenyReason,
  type MailboxHealthSnapshot,
} from "../src/index.js";

const now = new Date("2026-09-01T12:00:00.000Z");
const legacyFreeUntil = new Date("2026-09-20T00:00:00.000Z");

function fixture(): { ctx: CanSendContext; input: CanSendInput } {
  return {
    ctx: {
      now,
      edition: "cloud",
      ownerEmailVerified: true,
      workspace: { status: "active", killSwitchEnabled: false, postalAddress: "123 Main St", dailySendCap: 200, sentToday: 0, sentThisMonth: 0, legacyFreeUntil: null },
      subscription: { status: "active", trialEnd: null, onHoldGraceEndsAt: null },
      mailbox: { status: "active", dailyLimit: 50, hourlyLimit: 10, rampStartedOn: null, sentToday: 0, sentLastHour: 0, inSendingWindow: true },
      health: { state: "healthy", effectiveDailyLimit: 50, throttledUntil: null },
      providerCircuit: { state: "closed", nextProbeAt: null },
    },
    input: { sequenceStatus: "active", enrollmentStatus: "active", suppressed: false, alreadyReplied: false },
  };
}

function expectReason(reason: DenyReason, mutate: (value: ReturnType<typeof fixture>) => void): void {
  const value = fixture();
  mutate(value);
  expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason });
}

describe("canSend", () => {
  it("includes the scheduler mailbox spacing denial reason", () => {
    const reason: DenyReason = "mailbox_min_gap";
    expect(reason).toBe("mailbox_min_gap");
  });

  it("allows a healthy eligible delivery", () => {
    const value = fixture();
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
  });

  it("allows a manual reply to a replied enrollment while retaining pause gates", () => {
    const value = fixture();
    value.input = { ...value.input, mode: "manual_reply", sequenceStatus: "paused", enrollmentStatus: "replied", alreadyReplied: true };
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    // Manual replies never wait on the plan: not on a license, nor on legacy Free's cap.
    value.ctx.subscription = null;
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    value.ctx.workspace.legacyFreeUntil = legacyFreeUntil;
    value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT;
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    value.ctx.subscription = { status: "active" };
    value.ctx.workspace.killSwitchEnabled = true;
    expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "kill_switch" });
  });

  it("does not apply the campaign minimum gap to a manual reply", () => {
    const value = fixture();
    value.ctx.mailbox.nextAllowedAt = new Date("2026-09-01T12:00:30.000Z");
    expect(canSend(value.ctx, value.input)).toEqual({
      allowed: false,
      reason: "mailbox_min_gap",
      retryAt: value.ctx.mailbox.nextAllowedAt,
    });
    value.input.mode = "manual_reply";
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
  });

  it("allows manual replies outside the sending window and over hourly and warm-up caps", () => {
    const value = fixture();
    value.input.mode = "manual_reply";
    value.ctx.mailbox.inSendingWindow = false;
    value.ctx.mailbox.sentLastHour = value.ctx.mailbox.hourlyLimit;
    value.ctx.mailbox.rampStartedOn = "2026-09-01";
    value.ctx.mailbox.sentToday = 10;
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
  });

  it.each([
    ["suppressed", (value: ReturnType<typeof fixture>) => { value.input.suppressed = true; }],
    ["mailbox_daily_cap", (value: ReturnType<typeof fixture>) => { value.ctx.mailbox.sentToday = value.ctx.mailbox.dailyLimit; }],
    ["workspace_daily_cap", (value: ReturnType<typeof fixture>) => { value.ctx.workspace.sentToday = value.ctx.workspace.dailySendCap; }],
  ] satisfies Array<[DenyReason, (value: ReturnType<typeof fixture>) => void]>) ("keeps the %s gate for manual replies", (reason, mutate) => {
    const value = fixture();
    value.input.mode = "manual_reply";
    mutate(value);
    expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason });
  });

  it("defers an unverified owner's message for one hour", () => {
    const value = fixture();
    value.ctx.ownerEmailVerified = false;
    expect(canSend(value.ctx, value.input)).toEqual({
      allowed: false,
      reason: "email_unverified",
      retryAt: new Date("2026-09-01T13:00:00.000Z"),
    });
  });

  const unentitled = [
    ["no subscription", null],
    ["trialing without trial end", { status: "trialing", trialEnd: null, onHoldGraceEndsAt: null }],
    ["on-hold past grace", { status: "on_hold", trialEnd: null, onHoldGraceEndsAt: new Date("2026-09-01T11:59:59.999Z") }],
    ["cancelled", { status: "cancelled", trialEnd: null, onHoldGraceEndsAt: null }],
    ["refunded lifetime license", { status: "refunded", trialEnd: null, onHoldGraceEndsAt: null }],
    ["expired comp", { status: "expired", trialEnd: null, onHoldGraceEndsAt: null }],
    ["expired trial", { status: "trialing", trialEnd: new Date("2026-09-01T11:59:59.999Z"), onHoldGraceEndsAt: null }],
  ] satisfies Array<[string, CanSendContext["subscription"]]>;

  const entitled = [
    ["a lifetime license", { status: "active", trialEnd: null, onHoldGraceEndsAt: null }],
    ["a comp", { status: "active", trialEnd: null, onHoldGraceEndsAt: null }],
    ["a trial before its end", { status: "trialing", trialEnd: new Date("2026-09-01T12:00:00.001Z"), onHoldGraceEndsAt: null }],
    ["on-hold in grace", { status: "on_hold", trialEnd: null, onHoldGraceEndsAt: new Date("2026-09-01T12:00:00.001Z") }],
  ] satisfies Array<[string, NonNullable<CanSendContext["subscription"]>]>;

  describe("cloud, unlicensed", () => {
    it.each(unentitled)("blocks campaign sends for %s with payment_required, rechecked in 6 hours", (_label, subscription) => {
      const value = fixture();
      value.ctx.subscription = subscription;
      expect(canSend(value.ctx, value.input)).toEqual({
        allowed: false,
        reason: "payment_required",
        retryAt: new Date("2026-09-01T18:00:00.000Z"),
      });
    });

    // Every entitlement path releases parked mail at once, so the recheck is a
    // fallback and must stay long enough that unpaid backlogs do not churn the
    // scheduler (both worker paths take this retryAt from canSend).
    it("waits PAYMENT_REQUIRED_RETRY_MS, far longer than the 15-minute operational retries", () => {
      expect(PAYMENT_REQUIRED_RETRY_MS).toBe(6 * 60 * 60_000);
      const value = fixture();
      value.ctx.subscription = null;
      const decision = canSend(value.ctx, value.input);
      expect(decision).toMatchObject({ allowed: false, reason: "payment_required" });
      expect(!decision.allowed && decision.retryAt!.getTime() - now.getTime()).toBe(PAYMENT_REQUIRED_RETRY_MS);
      const killed = fixture();
      killed.ctx.workspace.killSwitchEnabled = true;
      const killedDecision = canSend(killed.ctx, killed.input);
      expect(!killedDecision.allowed && killedDecision.retryAt!.getTime() - now.getTime()).toBe(15 * 60_000);
    });

    it("blocks a legacy Free workspace once its window has ended", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.ctx.workspace.legacyFreeUntil = new Date("2026-09-01T12:00:00.000Z");
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "payment_required" });
      value.ctx.workspace.legacyFreeUntil = new Date("2026-08-01T00:00:00.000Z");
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "payment_required" });
    });

    it("still lets manual replies go out", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.input = { ...value.input, mode: "manual_reply", enrollmentStatus: "replied", alreadyReplied: true };
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    });

    it("keeps earlier safety gates ahead of the license", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.input.suppressed = true;
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "suppressed" });
      value.input.suppressed = false;
      value.ctx.workspace.killSwitchEnabled = true;
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "kill_switch" });
    });
  });

  describe("cloud, entitled", () => {
    it.each(entitled)("lets %s send past the legacy Free limit, with no cap", (_label, subscription) => {
      const value = fixture();
      value.ctx.subscription = subscription;
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT * 5;
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
      // A license bought during the legacy window outranks it.
      value.ctx.workspace.legacyFreeUntil = legacyFreeUntil;
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    });
  });

  describe("cloud, legacy Free", () => {
    it.each(unentitled)("gives %s the old monthly cap until legacy_free_until", (_label, subscription) => {
      const value = fixture();
      value.ctx.subscription = subscription;
      value.ctx.workspace.legacyFreeUntil = legacyFreeUntil;
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT - 1;
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT;
      expect(canSend(value.ctx, value.input)).toEqual({
        allowed: false,
        reason: "free_monthly_cap",
        retryAt: new Date("2026-09-20T00:00:00.000Z"),
      });
    });

    it("parks a capped message until the month resets when the window outlasts the month", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.ctx.workspace.legacyFreeUntil = new Date("2026-10-15T00:00:00.000Z");
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT;
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: false, reason: "free_monthly_cap", retryAt: new Date("2026-10-01T00:00:00.000Z") });
      value.ctx.now = new Date("2026-12-31T23:59:59.000Z");
      value.ctx.workspace.legacyFreeUntil = new Date("2027-01-15T00:00:00.000Z");
      expect(canSend(value.ctx, value.input)).toMatchObject({ reason: "free_monthly_cap", retryAt: new Date("2027-01-01T00:00:00.000Z") });
    });

    it("parks a capped message no later than the end of the window, when it becomes payment_required", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.ctx.workspace.legacyFreeUntil = legacyFreeUntil;
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT;
      const parked = canSend(value.ctx, value.input);
      expect(parked).toMatchObject({ reason: "free_monthly_cap", retryAt: legacyFreeUntil });
      value.ctx.now = (parked as { retryAt: Date }).retryAt;
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "payment_required" });
    });

    it("fails closed when the month's count is missing", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.ctx.workspace.legacyFreeUntil = legacyFreeUntil;
      value.ctx.workspace.sentThisMonth = Number(undefined);
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "free_monthly_cap" });
    });

    it("never caps manual replies", () => {
      const value = fixture();
      value.ctx.subscription = null;
      value.ctx.workspace.legacyFreeUntil = legacyFreeUntil;
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT * 2;
      value.input.mode = "manual_reply";
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    });
  });

  describe("self-host", () => {
    it.each([...unentitled, ...entitled])("is always entitled, with %s", (_label, subscription) => {
      const value = fixture();
      value.ctx.edition = "selfhost";
      value.ctx.subscription = subscription;
      value.ctx.workspace.sentThisMonth = FREE_PLAN_MONTHLY_SEND_LIMIT * 5;
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
      expect(hasSendingEntitlement(subscription, now, "selfhost")).toBe(true);
      // A stamped or expired legacy window means nothing outside cloud.
      value.ctx.workspace.legacyFreeUntil = new Date("2026-08-01T00:00:00.000Z");
      expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
      expect(sendingPlan({ edition: "selfhost", subscription, legacyFreeUntil }, now)).toBe("entitled");
    });

    it("keeps every non-plan safety gate", () => {
      const value = fixture();
      value.ctx.edition = "selfhost";
      value.ctx.subscription = null;
      value.ctx.workspace.sentToday = value.ctx.workspace.dailySendCap;
      expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "workspace_daily_cap" });
    });
  });

  it.each([...unentitled, ...entitled])("hasSendingEntitlement agrees with canSend in cloud for %s", (_label, subscription) => {
    const value = fixture();
    value.ctx.subscription = subscription;
    expect(hasSendingEntitlement(subscription, now, "cloud")).toBe(canSend(value.ctx, value.input).allowed);
  });

  it("maps every plan to the workspace-level answer canSend gives", () => {
    const cases: Array<[Parameters<typeof sendingPlan>[0], number, ReturnType<typeof sendingPlan>, boolean]> = [
      [{ edition: "selfhost", subscription: null, legacyFreeUntil: null }, FREE_PLAN_MONTHLY_SEND_LIMIT, "entitled", true],
      [{ edition: "cloud", subscription: { status: "active" }, legacyFreeUntil: null }, FREE_PLAN_MONTHLY_SEND_LIMIT, "entitled", true],
      [{ edition: "cloud", subscription: null, legacyFreeUntil }, FREE_PLAN_MONTHLY_SEND_LIMIT - 1, "legacy_free", true],
      [{ edition: "cloud", subscription: null, legacyFreeUntil }, FREE_PLAN_MONTHLY_SEND_LIMIT, "legacy_free", false],
      [{ edition: "cloud", subscription: null, legacyFreeUntil: null }, 0, "unlicensed", false],
    ];
    for (const [input, sentThisMonth, plan, allowed] of cases) {
      expect(sendingPlan(input, now)).toBe(plan);
      expect(planAllowsCampaignSends(plan, sentThisMonth)).toBe(allowed);
      const value = fixture();
      value.ctx.edition = input.edition;
      value.ctx.subscription = input.subscription;
      value.ctx.workspace.legacyFreeUntil = input.legacyFreeUntil;
      value.ctx.workspace.sentThisMonth = sentThisMonth;
      expect(canSend(value.ctx, value.input).allowed).toBe(allowed);
    }
  });

  it("states the entitlement rule in SQL with the same three statuses", () => {
    expect(entitlingSubscriptionSql("sub", "$1::timestamptz")).toBe(
      "(sub.status='active' OR (sub.status='trialing' AND sub.trial_end > $1::timestamptz) OR (sub.status='on_hold' AND sub.updated_at + interval '7 days' > $1::timestamptz))",
    );
  });

  it("states the unlicensed plan in SQL as neither entitled nor inside a legacy window, with missing rows counting as neither", () => {
    expect(unlicensedWorkspaceSql("sub", "w", "$1::timestamptz")).toBe(
      `(NOT COALESCE(${entitlingSubscriptionSql("sub", "$1::timestamptz")}, false) AND NOT COALESCE(w.legacy_free_until > $1::timestamptz, false))`,
    );
  });

  it.each([
    ["workspace_inactive", (value: ReturnType<typeof fixture>) => { value.ctx.workspace.status = "paused"; }],
    ["kill_switch", (value: ReturnType<typeof fixture>) => { value.ctx.workspace.killSwitchEnabled = true; }],
    ["sequence_inactive", (value: ReturnType<typeof fixture>) => { value.input.sequenceStatus = "paused"; }],
    ["enrollment_inactive", (value: ReturnType<typeof fixture>) => { value.input.enrollmentStatus = "paused"; }],
    ["mailbox_inactive", (value: ReturnType<typeof fixture>) => { value.ctx.mailbox.status = "paused"; }],
    ["suppressed", (value: ReturnType<typeof fixture>) => { value.input.suppressed = true; }],
    ["mailbox_daily_cap", (value: ReturnType<typeof fixture>) => { value.ctx.mailbox.sentToday = 50; }],
    ["mailbox_hourly_cap", (value: ReturnType<typeof fixture>) => { value.ctx.mailbox.sentLastHour = 10; }],
    ["workspace_daily_cap", (value: ReturnType<typeof fixture>) => { value.ctx.workspace.sentToday = 200; }],
    ["warmup_limit", (value: ReturnType<typeof fixture>) => { value.ctx.mailbox.rampStartedOn = "2026-09-01"; value.ctx.mailbox.sentToday = 10; }],
    ["outside_window", (value: ReturnType<typeof fixture>) => { value.ctx.mailbox.inSendingWindow = false; }],
    ["mailbox_throttled", (value: ReturnType<typeof fixture>) => { value.ctx.health = { state: "throttled", effectiveDailyLimit: 25, throttledUntil: new Date("2026-09-01T14:00:00.000Z") }; }],
    ["mailbox_unhealthy", (value: ReturnType<typeof fixture>) => { value.ctx.health = { state: "auth_error", effectiveDailyLimit: 25, throttledUntil: null }; }],
    ["provider_circuit_open", (value: ReturnType<typeof fixture>) => { value.ctx.providerCircuit = { state: "open", nextProbeAt: new Date("2026-09-01T12:30:00.000Z") }; }],
    ["already_replied", (value: ReturnType<typeof fixture>) => { value.input.alreadyReplied = true; }],
  ] satisfies Array<[DenyReason, (value: ReturnType<typeof fixture>) => void]>) ("denies with %s", (reason, mutate) => {
    expectReason(reason, mutate);
  });

  it("allows exactly one acquired half-open probe", () => {
    const value = fixture();
    value.ctx.providerCircuit = { state: "open", nextProbeAt: new Date("2026-09-01T11:59:00.000Z"), probeAllowed: true };
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    value.ctx.providerCircuit = { state: "half_open", probeAllowed: true };
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });
    value.ctx.providerCircuit.probeAllowed = false;
    expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "provider_circuit_open" });
  });

  it("allows degraded mailboxes below their reduced effective limit", () => {
    const value = fixture();
    value.ctx.health = { state: "degraded", effectiveDailyLimit: 25, throttledUntil: null };
    value.ctx.mailbox.sentToday = 24;
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });

    value.ctx.mailbox.sentToday = 25;
    expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "mailbox_daily_cap" });
  });

  it("treats critical mailbox health as unhealthy", () => {
    const value = fixture();
    value.ctx.health = { state: "critical", effectiveDailyLimit: 0, throttledUntil: null };
    expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "mailbox_unhealthy" });
  });

  it("uses the full mailbox limit for healthy state despite a stale effective limit", () => {
    const value = fixture();
    value.ctx.health = { state: "healthy", effectiveDailyLimit: 25, throttledUntil: null };
    value.ctx.mailbox.sentToday = 25;
    expect(canSend(value.ctx, value.input)).toEqual({ allowed: true });

    value.ctx.mailbox.sentToday = 50;
    expect(canSend(value.ctx, value.input)).toMatchObject({ allowed: false, reason: "mailbox_daily_cap" });
  });
});

describe("mailbox health ladder", () => {
  const healthy: MailboxHealthSnapshot = {
    state: "healthy",
    effectiveDailyLimit: 40,
    consecutiveFailures: 0,
    tempFailures24h: 0,
    permFailures24h: 0,
    throttledUntil: null,
  };

  it("halves capacity after repeated temporary failures and extends continued throttling", () => {
    const first = mailboxHealthAfterFailure(healthy, 40, "temporary", now);
    expect(first).toMatchObject({ state: "healthy", effectiveDailyLimit: 40, consecutiveFailures: 1 });
    const second = mailboxHealthAfterFailure(first, 40, "temporary", now);
    expect(second).toMatchObject({ state: "throttled", effectiveDailyLimit: 20, consecutiveFailures: 2, throttledUntil: new Date("2026-09-01T12:30:00.000Z") });
    const third = mailboxHealthAfterFailure(second, 40, "temporary", now);
    expect(third).toMatchObject({ state: "throttled", effectiveDailyLimit: 10, consecutiveFailures: 3, throttledUntil: new Date("2026-09-01T14:00:00.000Z") });
  });

  it("honors Retry-After and recovers capacity gradually", () => {
    const limited = mailboxHealthAfterFailure({ ...healthy, consecutiveFailures: 1 }, 40, "temporary", now, new Date("2026-09-01T15:00:00.000Z"));
    expect(limited.throttledUntil).toEqual(new Date("2026-09-01T15:00:00.000Z"));
    const recovered = mailboxHealthAfterSuccess(limited, 40);
    expect(recovered).toMatchObject({ state: "throttled", effectiveDailyLimit: 30, consecutiveFailures: 1, throttledUntil: null });
    expect(mailboxHealthAfterSuccess(recovered, 40)).toMatchObject({ state: "healthy", effectiveDailyLimit: 40, consecutiveFailures: 0 });
  });

  it("moves authentication failures directly to auth_error", () => {
    expect(mailboxHealthAfterFailure(healthy, 40, "auth", now)).toMatchObject({ state: "auth_error", consecutiveFailures: 1, permFailures24h: 1 });
  });
});
