import { afterEach, describe, expect, it, vi } from "vitest";

import { PAYMENT_REQUIRED_RETRY_MS, unlicensedWorkspaceSql } from "@inboxjoy/core";

import { dueOrderSql, duePlanJoinsSql, PAID_WORKSPACE_TICK_CAP_SQL, perWorkspaceTickCapSql, scheduleDueMessages, UNLICENSED_WORKSPACE_SQL } from "../src/jobs/schedule-due-messages.js";

const now = "2026-09-01T12:00:00.000Z";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function due(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    workspace_id: "00000000-0000-4000-8000-000000000002",
    email_account_id: "00000000-0000-4000-8000-000000000006",
    enrollment_id: "00000000-0000-4000-8000-000000000003",
    campaign_id: null,
    sequence_step_id: "00000000-0000-4000-8000-000000000004",
    idempotency_key: "enrollment:step:one",
    provider: "gmail",
    owner_email_verified: true,
    workspace_status: "active",
    kill_switch_enabled: false,
    postal_address: "123 Main St",
    workspace_daily_cap: 200,
    workspace_today: "0",
    subscription_status: "active",
    subscription_trial_end: null,
    subscription_on_hold_grace_ends_at: null,
    mailbox_status: "active",
    daily_limit: 50,
    hourly_limit: 10,
    ramp_started_on: null,
    ramp_paused_days: 0,
    mailbox_today: "0",
    mailbox_hour: "0",
    mailbox_last_send_at: null,
    in_sending_window: true,
    health_state: "healthy",
    effective_daily_limit: 50,
    throttled_until: null,
    circuit_state: "closed",
    next_probe_at: null,
    campaign_status: null,
    sequence_status: "active",
    enrollment_status: "active",
    suppressed: false,
    already_replied: false,
    ...overrides,
  };
}

function schedulerHarness(rows: ReturnType<typeof due>[], lockAcquired = true) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const lockClient = {
    query: vi.fn(async (text: string) => text.includes("pg_try_advisory_lock")
      ? { rowCount: 1, rows: [{ acquired: lockAcquired }] }
      : { rowCount: 1, rows: [{ pg_advisory_unlock: true }] }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(lockClient),
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push({ text, values });
      if (text.includes("WITH ranked AS")) return { rowCount: rows.length, rows };
      return { rowCount: 0, rows: [] };
    }),
  };
  const queue = { send: vi.fn().mockResolvedValue("job-id") };

  return { lockClient, pool, queue, statements };
}

describe("scheduleDueMessages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses per-workspace ranking and skips certain denials", async () => {
    const rows = [due(), due({ id: "00000000-0000-4000-8000-000000000005", idempotency_key: "enrollment:step:two", kill_switch_enabled: true })];
    const { lockClient, pool, queue, statements } = schedulerHarness(rows);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition: "cloud" });

    expect(statements.some((statement) => statement.text.includes("row_number() OVER (PARTITION BY m.workspace_id"))).toBe(true);
    expect(statements.some((statement) => statement.text.includes(`${PAID_WORKSPACE_TICK_CAP_SQL} THEN 1000 ELSE 100`))).toBe(true);
    expect(statements.some((statement) => statement.text.includes("LIMIT 3000"))).toBe(true);
    expect(statements.some((statement) => statement.text.includes("AS mailbox_last_send_at"))).toBe(true);
    expect(statements.some((statement) => statement.text.includes("manual_reply_event.workspace_id=ea.workspace_id"))).toBe(true);
    expect(statements.some((statement) => statement.text.includes("manual_reply_event.workspace_id=w.id"))).toBe(true);
    expect(statements.some((statement) => statement.text.includes("JOIN auth_users au ON au.id=om.user_id"))).toBe(true);
    expect(statements.some((statement) => statement.text.includes("lm.status='accepted'") && statement.text.includes("lm.status='sending'") && statement.text.includes("lm.claim_expires_at > $1::timestamptz"))).toBe(true);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith("email.send-message", expect.objectContaining({ idempotencyKey: "enrollment:step:one" }), expect.any(Object));
    const blocked = statements.find((statement) => statement.text.includes("blocked_reason=d.reason"));
    expect(blocked?.values?.[1]).toEqual(["kill_switch"]);
    expect(lockClient.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", expect.any(Array));
    expect(lockClient.release).toHaveBeenCalledOnce();
  });

  it("enqueues two messages for one mailbox and staggers the second by the minimum gap", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rows = [
      due(),
      due({ id: "00000000-0000-4000-8000-000000000007", idempotency_key: "enrollment:step:two" }),
    ];
    const { pool, queue, statements } = schedulerHarness(rows);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition: "cloud" });

    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send.mock.calls[0]?.[2]).not.toHaveProperty("startAfter");
    const secondStart = queue.send.mock.calls[1]?.[2]?.startAfter as Date;
    expect(secondStart).toBeInstanceOf(Date);
    expect(secondStart.getTime() - new Date(now).getTime()).toBeGreaterThanOrEqual(30_000);
    expect(statements.some((statement) => statement.text.includes("blocked_reason=d.reason"))).toBe(false);
  });

  it("enqueues due messages from different mailboxes in the same tick", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rows = [
      due(),
      due({
        id: "00000000-0000-4000-8000-000000000007",
        email_account_id: "00000000-0000-4000-8000-000000000008",
        idempotency_key: "enrollment:step:two",
      }),
    ];
    const { pool, queue } = schedulerHarness(rows);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition: "cloud" });

    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send.mock.calls[0]?.[2]).not.toHaveProperty("startAfter");
    expect(queue.send.mock.calls[1]?.[2]).not.toHaveProperty("startAfter");
    expect(pool.query.mock.calls.some(([text]) => text.includes("blocked_reason=d.reason"))).toBe(false);
  });

  it("retries an unverified owner's message and enqueues it on the next tick after verification", async () => {
    const message = due({ owner_email_verified: false });
    const first = schedulerHarness([message]);

    await scheduleDueMessages({ now }, { pool: first.pool as never, queue: first.queue as never, edition: "cloud" });

    expect(first.queue.send).not.toHaveBeenCalled();
    const blocked = first.statements.find((statement) => statement.text.includes("blocked_reason=d.reason"));
    expect(blocked?.values?.[0]).toEqual([message.id]);
    expect(blocked?.values?.[1]).toEqual(["email_unverified"]);
    expect((blocked?.values?.[2] as Date[])[0]).toEqual(new Date("2026-09-01T13:00:00.000Z"));

    const second = schedulerHarness([{ ...message, owner_email_verified: true }]);
    await scheduleDueMessages({ now: "2026-09-01T13:00:00.000Z" }, { pool: second.pool as never, queue: second.queue as never, edition: "cloud" });

    expect(second.queue.send).toHaveBeenCalledOnce();
    expect(second.queue.send).toHaveBeenCalledWith("email.send-message", expect.objectContaining({ idempotencyKey: message.idempotency_key }), expect.any(Object));
  });

  it("delays a mailbox's first due message when its last send is within the gap", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rows = [due({ mailbox_last_send_at: new Date("2026-09-01T11:59:50.000Z") })];
    const { pool, queue, statements } = schedulerHarness(rows);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition: "cloud" });

    expect(queue.send).toHaveBeenCalledOnce();
    expect(queue.send.mock.calls[0]?.[2]?.startAfter).toEqual(new Date("2026-09-01T12:00:20.000Z"));
    expect(statements.some((statement) => statement.text.includes("blocked_reason=d.reason"))).toBe(false);
  });

  it("defers messages whose mailbox release time exceeds the tick horizon", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rows = Array.from({ length: 6 }, (_, index) => due({
      id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      idempotency_key: `enrollment:step:${index}`,
    }));
    const { pool, queue, statements } = schedulerHarness(rows);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition: "cloud" });

    expect(queue.send).toHaveBeenCalledTimes(5);
    expect(queue.send.mock.calls[4]?.[2]?.startAfter).toEqual(new Date("2026-09-01T12:02:00.000Z"));
    const blocked = statements.find((statement) => statement.text.includes("blocked_reason=d.reason"));
    expect(blocked?.values?.[0]).toEqual([rows[5]?.id]);
    expect(blocked?.values?.[1]).toEqual(["mailbox_min_gap"]);
    expect((blocked?.values?.[2] as Date[])[0]).toEqual(new Date("2026-09-01T12:02:30.000Z"));
  });

  it.each([
    ["an unlicensed cloud workspace", "cloud", { subscription_status: null, legacy_free_until: null, workspace_month: "0" }, "payment_required", new Date("2026-09-01T18:00:00.000Z")],
    ["a legacy Free window that has ended", "cloud", { subscription_status: null, legacy_free_until: new Date("2026-09-01T11:00:00.000Z"), workspace_month: "0" }, "payment_required", new Date("2026-09-01T18:00:00.000Z")],
    ["legacy Free at its cap", "cloud", { subscription_status: null, legacy_free_until: new Date("2026-09-10T00:00:00.000Z"), workspace_month: "10000" }, "free_monthly_cap", new Date("2026-09-10T00:00:00.000Z")],
  ] as const)("parks a due message for %s", async (_label, edition, row, reason, retryAt) => {
    const { pool, queue, statements } = schedulerHarness([due(row)]);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition });

    expect(queue.send).not.toHaveBeenCalled();
    const blocked = statements.find((statement) => statement.text.includes("blocked_reason=d.reason"));
    expect(blocked?.values?.[1]).toEqual([reason]);
    expect((blocked?.values?.[2] as Date[])[0]).toEqual(retryAt);
  });

  it.each([
    ["legacy Free under its cap", "cloud", { subscription_status: null, legacy_free_until: new Date("2026-09-10T00:00:00.000Z"), workspace_month: "9999" }],
    ["a self-hosted workspace with no subscription", "selfhost", { subscription_status: null, legacy_free_until: null, workspace_month: "50000" }],
  ] as const)("enqueues a due message for %s", async (_label, edition, row) => {
    const { pool, queue } = schedulerHarness([due(row)]);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition });

    expect(queue.send).toHaveBeenCalledOnce();
  });

  it("reads the legacy window and gives self-host the paid tick size", async () => {
    const cloud = schedulerHarness([]);
    await scheduleDueMessages({ now }, { pool: cloud.pool as never, queue: cloud.queue as never, edition: "cloud" });
    const cloudSelect = cloud.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text;
    expect(cloudSelect).toContain("w.legacy_free_until");
    expect(cloudSelect).toContain(`${PAID_WORKSPACE_TICK_CAP_SQL} THEN 1000 ELSE 100`);

    const selfhost = schedulerHarness([]);
    await scheduleDueMessages({ now }, { pool: selfhost.pool as never, queue: selfhost.queue as never, edition: "selfhost" });
    const selfhostSelect = selfhost.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text;
    expect(selfhostSelect).toContain("r.workspace_rank <= 1000");
    expect(selfhostSelect).not.toContain("ELSE 100");
  });

  // An unpaid backlog must not crowd paying workspaces out of the 3000-row tick:
  // unlicensed rows sort after every other workspace's, and each one denied is
  // parked for the long payment_required retry, out of the due range.
  it("selects unlicensed cloud workspaces' due rows last and parks them for the long retry", async () => {
    expect(UNLICENSED_WORKSPACE_SQL).toBe(unlicensedWorkspaceSql("sub", "plan_w", "$1::timestamptz"));
    const rows = [
      due(),
      due({ id: "00000000-0000-4000-8000-000000000011", workspace_id: "00000000-0000-4000-8000-000000000012", email_account_id: "00000000-0000-4000-8000-000000000016", idempotency_key: "unlicensed:one", subscription_status: null, legacy_free_until: null, workspace_month: "0" }),
    ];
    const cloud = schedulerHarness(rows);

    await scheduleDueMessages({ now }, { pool: cloud.pool as never, queue: cloud.queue as never, edition: "cloud" });

    const cloudSelect = cloud.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text;
    expect(cloudSelect).toContain("JOIN workspaces plan_w ON plan_w.id=m.workspace_id");
    expect(cloudSelect).toMatch(new RegExp(`ORDER BY ${escapeRegExp(UNLICENSED_WORKSPACE_SQL)},r\\.workspace_rank,m\\.scheduled_at,m\\.id\\s+LIMIT 3000`));
    expect(cloud.queue.send).toHaveBeenCalledOnce();
    expect(cloud.queue.send).toHaveBeenCalledWith("email.send-message", expect.objectContaining({ idempotencyKey: "enrollment:step:one" }), expect.any(Object));
    const blocked = cloud.statements.find((statement) => statement.text.includes("blocked_reason=d.reason"));
    expect(blocked?.values).toEqual([[rows[1]!.id], ["payment_required"], [new Date(new Date(now).getTime() + PAYMENT_REQUIRED_RETRY_MS)]]);

    const selfhost = schedulerHarness([]);
    await scheduleDueMessages({ now }, { pool: selfhost.pool as never, queue: selfhost.queue as never, edition: "selfhost" });
    const selfhostSelect = selfhost.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text;
    expect(selfhostSelect).toMatch(/ORDER BY r\.workspace_rank,m\.scheduled_at,m\.id\s+LIMIT 3000/);
    expect(selfhostSelect).not.toContain("legacy_free_until > $1::timestamptz");
  });

  // Only the cloud tick size and order read the plan, so only cloud pays for
  // the workspace and subscription lookups on every due row.
  it("joins the plan rows into the due selection in cloud only", async () => {
    const cloudJoins = duePlanJoinsSql("cloud");
    expect(cloudJoins).toContain("JOIN workspaces plan_w ON plan_w.id=m.workspace_id");
    expect(cloudJoins).toContain("LEFT JOIN subscriptions sub ON sub.workspace_id=m.workspace_id");
    expect(duePlanJoinsSql("selfhost")).toBe("");
    // Every alias the cloud tick size and order read is joined; self-host reads none.
    for (const fragment of [perWorkspaceTickCapSql("cloud"), dueOrderSql("cloud")]) expect(fragment).toMatch(/\b(sub|plan_w)\./);
    for (const fragment of [perWorkspaceTickCapSql("selfhost"), dueOrderSql("selfhost")]) expect(fragment).not.toMatch(/\b(sub|plan_w)\./);

    const dueCte = (select: string) => select.slice(select.indexOf("due AS ("), select.indexOf("due_mailboxes AS"));
    const cloud = schedulerHarness([]);
    await scheduleDueMessages({ now }, { pool: cloud.pool as never, queue: cloud.queue as never, edition: "cloud" });
    const cloudDue = dueCte(cloud.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text);
    expect(cloudDue).toContain(cloudJoins);

    const selfhost = schedulerHarness([due({ subscription_status: null, legacy_free_until: null })]);
    await scheduleDueMessages({ now }, { pool: selfhost.pool as never, queue: selfhost.queue as never, edition: "selfhost" });
    const selfhostDue = dueCte(selfhost.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text);
    expect(selfhostDue).not.toContain("plan_w");
    expect(selfhostDue).not.toContain("subscriptions");
    expect(selfhostDue).toMatch(/JOIN messages m ON m\.id=r\.id\s+WHERE r\.workspace_rank <= 1000/);
    // The workspace gate still reads the subscription for canSend in both editions.
    expect(selfhost.statements.find((statement) => statement.text.includes("WITH ranked AS"))!.text).toContain("LEFT JOIN subscriptions sub ON sub.workspace_id=w.id");
    expect(selfhost.queue.send).toHaveBeenCalledOnce();
  });

  it("skips all scheduler work when the advisory lock is already held", async () => {
    const { lockClient, pool, queue } = schedulerHarness([due()], false);

    await scheduleDueMessages({ now }, { pool: pool as never, queue: queue as never, edition: "cloud" });

    expect(pool.query).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
    expect(lockClient.query).toHaveBeenCalledTimes(1);
    expect(lockClient.release).toHaveBeenCalledOnce();
  });
});
