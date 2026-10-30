import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDb } from "@inboxjoy/db";
import { FREE_PLAN_MONTHLY_SEND_LIMIT, grantLifetimeLicense, PAYMENT_REQUIRED_RETRY_MS, type Edition } from "@inboxjoy/core";

import { scheduleDueMessages } from "../src/jobs/schedule-due-messages.js";
import { claimMessage } from "../src/jobs/send-message.js";

const databaseUrl = process.env.DATABASE_URL;

// The plan gate, checked against the
// real tables on both worker SQL paths: the scheduler tick and the send claim
// (guardrail section 3). Cloud: entitled sends with no cap and no footer;
// legacy Free (workspaces.legacy_free_until in the future) keeps the old
// monthly cap and the "Sent via InboxJoy" footer; anything else is
// payment_required, rechecked every 6 hours (PAYMENT_REQUIRED_RETRY_MS) and
// released at once when the license is bought. Self-host is always entitled. A claim-time denial never
// creates a send attempt.
describe.skipIf(!databaseUrl)("plan gate on both worker paths", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDb(pool);
  const ids = {
    user: randomUUID(),
    workspace: randomUUID(),
    mailbox: randomUUID(),
    bulkMailbox: randomUUID(),
    contact: randomUUID(),
    sequence: randomUUID(),
    version: randomUUID(),
    step: randomUUID(),
    enrollment: randomUUID(),
    message: randomUUID(),
  };
  const idempotencyKey = `payment-gate:${ids.message}`;
  const days = (count: number) => count * 86_400_000;

  const claim = async (edition: Edition) => {
    const client = await pool.connect();
    try {
      return await claimMessage(client, { workspaceId: ids.workspace, enrollmentId: ids.enrollment, sequenceStepId: ids.step, idempotencyKey }, { edition });
    } finally {
      client.release();
    }
  };
  // Back to a due, never-attempted message; the stored Message-ID is dropped so
  // each case shows the one its own edition generates.
  const resetMessage = (scheduledAtSql = "now()-interval '1 minute'") => pool.query(`UPDATE messages SET status='scheduled',blocked_reason=NULL,scheduled_at=${scheduledAtSql},
    claimed_at=NULL,claim_expires_at=NULL,metadata=metadata - 'providerRfcMessageId' - 'providerAttemptedAt' WHERE id=$1`, [ids.message]);
  const setPlan = async (plan: { subscription?: { status: string; trialEnd?: Date | null; metadata?: Record<string, unknown> } | null; legacyFreeUntil?: Date | null }) => {
    await pool.query("DELETE FROM subscriptions WHERE workspace_id=$1", [ids.workspace]);
    if (plan.subscription) {
      await pool.query("INSERT INTO subscriptions (id,workspace_id,status,trial_end,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [randomUUID(), ids.workspace, plan.subscription.status, plan.subscription.trialEnd ?? null, JSON.stringify(plan.subscription.metadata ?? {})]);
    }
    await pool.query("UPDATE workspaces SET legacy_free_until=$2 WHERE id=$1", [ids.workspace, plan.legacyFreeUntil ?? null]);
  };
  const stored = async () => (await pool.query<{ status: string; blocked_reason: string | null; scheduled_at: Date }>("SELECT status,blocked_reason,scheduled_at FROM messages WHERE id=$1", [ids.message])).rows[0]!;
  const attempts = async () => (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM send_attempts WHERE message_id=$1", [ids.message])).rows[0]!.count;

  // Fills this month's campaign sends from a second mailbox so mailbox caps stay clear.
  const fillMonth = async (acceptedAtSql: string, count = FREE_PLAN_MONTHLY_SEND_LIMIT, values: unknown[] = []) => {
    await pool.query("DELETE FROM messages WHERE workspace_id=$1 AND email_account_id=$2", [ids.workspace, ids.bulkMailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,accepted_at,
        recipient_email,normalized_recipient_email,subject,body_hash,tracking_token,metadata)
      SELECT gen_random_uuid(),$1::uuid,$2,$3,$4,$5,'accepted','free-plan-bulk:' || $1::text || ':' || g,now(),${acceptedAtSql},
        'gate-lead@example.com','gate-lead@example.com','Hello','hash',md5(random()::text || g),'{}'::jsonb
      FROM generate_series(1,$6::int) g`, [ids.workspace, ids.enrollment, ids.step, ids.bulkMailbox, ids.contact, count, ...values]);
  };
  const clearMonth = () => pool.query("DELETE FROM messages WHERE workspace_id=$1 AND email_account_id=$2", [ids.workspace, ids.bulkMailbox]);

  beforeAll(async () => {
    const email = `payment-gate-${ids.user}@example.com`;
    await pool.query("DELETE FROM provider_circuit WHERE provider='outlook'");
    await pool.query("INSERT INTO auth_users (id,name,email,email_verified) VALUES ($1,'Payment Gate',$2,true)", [ids.user, email]);
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, email]);
    // A high workspace daily cap keeps workspace_daily_cap out of the way of the bulk month.
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id,postal_address,daily_send_cap) VALUES ($1,'Payment Gate',$2,$3,'123 Main St',100000)", [ids.workspace, `payment-gate-${ids.workspace}`, ids.user]);
    await pool.query("INSERT INTO memberships (id,workspace_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')", [randomUUID(), ids.workspace, ids.user]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'outlook',$4,'gate-sender@sender.example','gate-sender@sender.example','payment-gate','active',40,10)`, [ids.mailbox, ids.workspace, ids.user, `payment-gate-${ids.mailbox}`]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'outlook',$4,'gate-bulk@example.com','gate-bulk@example.com','payment-gate-bulk','active',40,10)`, [ids.bulkMailbox, ids.workspace, ids.user, `payment-gate-${ids.bulkMailbox}`]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,'gate-lead@example.com','gate-lead@example.com','enrolled')", [ids.contact, ids.workspace]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'Payment Gate','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("UPDATE sequences SET current_version_id=$2 WHERE id=$1", [ids.sequence, ids.version]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,1,0,'Hello','Hello')", [ids.step, ids.workspace, ids.version]);
    await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
      VALUES ($1,$2,$3,$4,$5,$6,'active',1)`, [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, ids.mailbox]);
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,
      recipient_email,normalized_recipient_email,subject,body_hash,tracking_token,metadata) VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,now()-interval '1 minute','gate-lead@example.com','gate-lead@example.com','Hello','hash',$8,$9::jsonb)`,
    [ids.message, ids.workspace, ids.enrollment, ids.step, ids.mailbox, ids.contact, idempotencyKey, randomUUID().replaceAll("-", ""), JSON.stringify({ bodyText: "Hello" })]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [ids.workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [ids.user]);
    await pool.end();
  });

  describe("claim path", () => {
    it.each([
      ["a new workspace with no subscription", null],
      ["a cancelled subscription", { status: "cancelled" }],
      ["a refunded lifetime license", { status: "refunded", metadata: { lifetime: true } }],
      ["an expired trial", { status: "trialing", trialEnd: new Date(Date.now() - 60_000) }],
    ])("blocks %s in cloud with payment_required, rechecked in 6 hours, with no send attempt", async (_label, subscription) => {
      await clearMonth();
      await setPlan({ subscription });
      await resetMessage();
      const attemptsBefore = await attempts();
      const before = Date.now();

      const result = await claim("cloud");

      expect(result).toMatchObject({ deniedReason: "payment_required" });
      expect(result.message).toBeUndefined();
      const row = await stored();
      expect(row).toMatchObject({ status: "scheduled", blocked_reason: "payment_required" });
      expect(row.scheduled_at.getTime()).toBeGreaterThanOrEqual(before + PAYMENT_REQUIRED_RETRY_MS - 60_000);
      expect(row.scheduled_at.getTime()).toBeLessThanOrEqual(Date.now() + PAYMENT_REQUIRED_RETRY_MS + 60_000);
      expect(await attempts()).toBe(attemptsBefore);
    });

    it("blocks a legacy Free workspace whose window has ended", async () => {
      await clearMonth();
      await setPlan({ legacyFreeUntil: new Date(Date.now() - 60_000) });
      await resetMessage();

      expect(await claim("cloud")).toMatchObject({ deniedReason: "payment_required" });
    });

    it("lets legacy Free claim under the cap with the Sent via InboxJoy footer", async () => {
      await clearMonth();
      await setPlan({ legacyFreeUntil: new Date(Date.now() + days(10)) });
      await resetMessage();

      const result = await claim("cloud");

      expect(result.deniedReason).toBeUndefined();
      expect(result.message?.id).toBe(ids.message);
      expect(result.message?.sent_via).toBe(true);
      expect(result.message?.metadata?.providerRfcMessageId).toBe(`<${ids.message}@messages.inboxjoy.online>`);
    });

    it("parks legacy Free at the cap until the month resets or the window ends, whichever comes first", async () => {
      await fillMonth("now()");
      const now = new Date();
      const monthResetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      for (const legacyFreeUntil of [new Date(monthResetsAt.getTime() - 60_000), new Date(monthResetsAt.getTime() + days(5))]) {
        await setPlan({ legacyFreeUntil });
        await resetMessage();
        const attemptsBefore = await attempts();

        const result = await claim("cloud");

        expect(result).toMatchObject({ deniedReason: "free_monthly_cap" });
        const row = await stored();
        expect(row).toMatchObject({ status: "scheduled", blocked_reason: "free_monthly_cap" });
        expect(row.scheduled_at.toISOString()).toBe((legacyFreeUntil < monthResetsAt ? legacyFreeUntil : monthResetsAt).toISOString());
        expect(await attempts()).toBe(attemptsBefore);
      }
    });

    it("does not count last month's sends toward the legacy Free limit", async () => {
      await fillMonth("date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second'");
      await setPlan({ legacyFreeUntil: new Date(Date.now() + days(10)) });
      await resetMessage();

      const result = await claim("cloud");

      expect(result.deniedReason).toBeUndefined();
      expect(result.message?.id).toBe(ids.message);
    });

    it.each([
      ["a lifetime license", { status: "active", metadata: { lifetime: true } }],
      ["a comp", { status: "active", metadata: { comp: true } }],
      ["a trial before its end", { status: "trialing", trialEnd: new Date(Date.now() + days(3)) }],
    ])("lets %s claim past the legacy Free limit without the footer", async (_label, subscription) => {
      await fillMonth("now()");
      await setPlan({ subscription, legacyFreeUntil: new Date(Date.now() + days(10)) });
      await resetMessage();

      const result = await claim("cloud");

      expect(result.deniedReason).toBeUndefined();
      expect(result.message?.id).toBe(ids.message);
      expect(result.message?.sent_via).toBe(false);
    });

    it("treats every self-hosted workspace as entitled and uses the mailbox's domain for the Message-ID", async () => {
      await fillMonth("now()");
      await setPlan({ subscription: { status: "cancelled" }, legacyFreeUntil: new Date(Date.now() - days(1)) });
      await resetMessage();

      const result = await claim("selfhost");

      expect(result.deniedReason).toBeUndefined();
      expect(result.message?.sent_via).toBe(false);
      expect(result.message?.metadata?.providerRfcMessageId).toBe(`<${ids.message}@sender.example>`);
    });

    it.each([
      ["payment_required", "now()+interval '6 hours'"],
      ["free_monthly_cap", "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 month'"],
    ])("sends a message parked with %s as soon as the lifetime license is bought", async (reason, parkedUntilSql) => {
      await clearMonth();
      await setPlan({ subscription: null });
      await resetMessage(parkedUntilSql);
      await pool.query("UPDATE messages SET blocked_reason=$2 WHERE id=$1", [ids.message, reason]);
      expect(await claim("cloud")).toEqual({});

      const payment = { payment_id: `pay_${randomUUID()}`, status: "succeeded", product_cart: [{ product_id: "pdt_test_lifetime" }], customer: { customer_id: `cus_${randomUUID()}` } };
      await expect(grantLifetimeLicense(db, { workspaceId: ids.workspace, productId: "pdt_test_lifetime", payment })).resolves.toMatchObject({ granted: true });

      const result = await claim("cloud");
      expect(result.deniedReason).toBeUndefined();
      expect(result.message?.id).toBe(ids.message);
    });
  });

  // The tick runs at a fixed instant in the past: it only sees this test's
  // message (due by then) and its expired-claim sweep matches nothing elsewhere.
  describe("scheduler path", () => {
    const tickNow = new Date("2001-06-15T12:00:00.000Z");
    const tick = async (edition: Edition) => {
      const queue = { send: vi.fn().mockResolvedValue("job-id") };
      await scheduleDueMessages({ now: tickNow.toISOString(), workspaceId: ids.workspace }, { pool, queue: queue as never, edition });
      return queue.send.mock.calls.filter(([, payload]) => (payload as { idempotencyKey: string }).idempotencyKey === idempotencyKey).length;
    };
    const dueAtTick = () => resetMessage(`'${new Date(tickNow.getTime() - 60_000).toISOString()}'::timestamptz`);

    it("parks an unlicensed cloud workspace with payment_required for 6 hours", async () => {
      await clearMonth();
      await setPlan({ subscription: null });
      await dueAtTick();

      expect(await tick("cloud")).toBe(0);
      expect(await stored()).toEqual({ status: "scheduled", blocked_reason: "payment_required", scheduled_at: new Date(tickNow.getTime() + PAYMENT_REQUIRED_RETRY_MS) });
    });

    it("parks legacy Free at the cap until the window ends when that comes before the month resets", async () => {
      await fillMonth("$7::timestamptz", FREE_PLAN_MONTHLY_SEND_LIMIT, [tickNow]);
      const legacyFreeUntil = new Date(tickNow.getTime() + days(3));
      await setPlan({ legacyFreeUntil });
      await dueAtTick();

      expect(await tick("cloud")).toBe(0);
      expect(await stored()).toEqual({ status: "scheduled", blocked_reason: "free_monthly_cap", scheduled_at: legacyFreeUntil });
    });

    it.each([
      ["legacy Free under the cap", "cloud", { legacyFreeUntil: new Date(tickNow.getTime() + days(3)) }],
      ["a lifetime license", "cloud", { subscription: { status: "active", metadata: { lifetime: true } } }],
      ["a self-hosted workspace with no subscription", "selfhost", { subscription: null }],
    ] as const)("enqueues %s", async (_label, edition, plan) => {
      await clearMonth();
      await setPlan(plan);
      await dueAtTick();

      expect(await tick(edition)).toBe(1);
      expect((await stored()).blocked_reason).toBeNull();
    });
  });
});
