import { createDb, createPgPool } from "@inboxjoy/db";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { followUpSendJitterMs, grantCompSubscription, grantLifetimeLicense, PAYMENT_REQUIRED_RETRY_MS, releasePlanBlockedSends, upsertDodoSubscription } from "../src/index.js";
import { refreshPendingOnResume } from "../src/resume-pending.js";

const databaseUrl = process.env.DATABASE_URL;
const lifetimeProductId = "pdt_test_lifetime";

// Campaign email the plan gate parked (payment_required, legacy Free's
// free_monthly_cap) must go out soon after the workspace gets a license, a comp
// or an entitling Dodo subscription, not on the date the gate last pushed it to.
describe.skipIf(!databaseUrl)("plan-blocked sends after a purchase", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let ids: Record<"user" | "workspace" | "other" | "mailbox" | "contact" | "sequence" | "version" | "step" | "enrollment", string>;
  const nextMonth = () => new Date(Date.now() + 20 * 86_400_000);

  async function message(values: { workspaceId?: string; stepId?: string; status?: string; blockedReason: string | null; scheduledAt: Date }): Promise<string> {
    const id = randomUUID();
    const workspaceId = values.workspaceId ?? ids.workspace;
    await pool.query(`INSERT INTO messages (id,workspace_id,enrollment_id,sequence_step_id,email_account_id,contact_id,status,idempotency_key,scheduled_at,
        recipient_email,normalized_recipient_email,subject,body_hash,tracking_token,metadata,blocked_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'release-lead@example.com','release-lead@example.com','Hello','hash',$10,'{}'::jsonb,$11)`,
    [id, workspaceId, ids.enrollment, values.stepId ?? ids.step, ids.mailbox, ids.contact, values.status ?? "scheduled", `release:${id}`, values.scheduledAt, randomUUID().replaceAll("-", ""), values.blockedReason]);
    return id;
  }

  async function stored(id: string) {
    const result = await pool.query<{ scheduled_at: Date; blocked_reason: string | null }>("SELECT scheduled_at,blocked_reason FROM messages WHERE id=$1", [id]);
    return result.rows[0]!;
  }

  beforeEach(async () => {
    ids = { user: randomUUID(), workspace: randomUUID(), other: randomUUID(), mailbox: randomUUID(), contact: randomUUID(), sequence: randomUUID(), version: randomUUID(), step: randomUUID(), enrollment: randomUUID() };
    const email = `release-${ids.user}@example.com`;
    await pool.query("INSERT INTO auth_users (id,name,email,email_verified) VALUES ($1,'Release',$2,true)", [ids.user, email]);
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, email]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id) VALUES ($1,'Release',$2,$4),($3,'Release other',$5,$4)", [ids.workspace, `release-${ids.workspace}`, ids.other, ids.user, `release-${ids.other}`]);
    await pool.query(`INSERT INTO email_accounts (id,workspace_id,user_id,provider,composio_connected_account_id,email,normalized_email,alias,status,daily_limit,hourly_limit)
      VALUES ($1,$2,$3,'gmail',$4,'release-sender@example.com','release-sender@example.com','release','active',40,10)`, [ids.mailbox, ids.workspace, ids.user, `release-${ids.mailbox}`]);
    await pool.query("INSERT INTO contacts (id,workspace_id,email,normalized_email,status) VALUES ($1,$2,'release-lead@example.com','release-lead@example.com','enrolled')", [ids.contact, ids.workspace]);
    await pool.query("INSERT INTO sequences (id,workspace_id,name,status,created_by_user_id) VALUES ($1,$2,'Release','active',$3)", [ids.sequence, ids.workspace, ids.user]);
    await pool.query("INSERT INTO sequence_versions (id,workspace_id,sequence_id,version,status,created_by_user_id) VALUES ($1,$2,$3,1,'active',$4)", [ids.version, ids.workspace, ids.sequence, ids.user]);
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,1,0,'Hello','Hello')", [ids.step, ids.workspace, ids.version]);
    await pool.query(`INSERT INTO enrollments (id,workspace_id,contact_id,sequence_id,sequence_version_id,email_account_id,status,next_step_order)
      VALUES ($1,$2,$3,$4,$5,$6,'active',1)`, [ids.enrollment, ids.workspace, ids.contact, ids.sequence, ids.version, ids.mailbox]);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [[ids.workspace, ids.other]]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [ids.user]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("brings parked plan-blocked messages back to now and leaves everything else alone", async () => {
    const now = new Date();
    const paymentRequired = await message({ blockedReason: "payment_required", scheduledAt: new Date(now.getTime() + PAYMENT_REQUIRED_RETRY_MS) });
    const monthlyCap = await message({ blockedReason: "free_monthly_cap", scheduledAt: nextMonth() });
    const retryable = await message({ status: "retryable", blockedReason: "free_monthly_cap", scheduledAt: nextMonth() });
    const warmup = await message({ blockedReason: "warmup_limit", scheduledAt: nextMonth() });
    const future = await message({ blockedReason: null, scheduledAt: nextMonth() });
    const alreadyDue = await message({ blockedReason: "payment_required", scheduledAt: new Date(now.getTime() - 60_000) });
    const cancelled = await message({ status: "cancelled", blockedReason: "payment_required", scheduledAt: nextMonth() });

    await expect(releasePlanBlockedSends(db, ids.workspace, now)).resolves.toBe(3);

    for (const id of [paymentRequired, monthlyCap, retryable]) {
      expect(await stored(id)).toEqual({ scheduled_at: now, blocked_reason: null });
    }
    expect(await stored(warmup)).toMatchObject({ blocked_reason: "warmup_limit" });
    expect((await stored(warmup)).scheduled_at.getTime()).toBeGreaterThan(now.getTime());
    expect((await stored(future)).scheduled_at.getTime()).toBeGreaterThan(now.getTime());
    expect(await stored(alreadyDue)).toMatchObject({ blocked_reason: "payment_required" });
    expect(await stored(cancelled)).toMatchObject({ blocked_reason: "payment_required" });
    await expect(releasePlanBlockedSends(db, ids.other, now)).resolves.toBe(0);
  });

  it("releases them when a lifetime license is granted, once", async () => {
    const parked = await message({ blockedReason: "free_monthly_cap", scheduledAt: nextMonth() });
    const payment = { payment_id: `pay_${randomUUID()}`, status: "succeeded", created_at: new Date().toISOString(), customer: { customer_id: `cus_${randomUUID()}` }, product_cart: [{ product_id: lifetimeProductId }] };

    await expect(grantLifetimeLicense(db, { workspaceId: ids.workspace, productId: lifetimeProductId, payment })).resolves.toMatchObject({ granted: true });
    expect(await stored(parked)).toMatchObject({ blocked_reason: null });
    expect((await stored(parked)).scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("releases them when a comp is granted", async () => {
    const parked = await message({ blockedReason: "payment_required", scheduledAt: new Date(Date.now() + PAYMENT_REQUIRED_RETRY_MS) });

    await expect(grantCompSubscription(db, { workspaceId: ids.workspace, months: 1 })).resolves.toMatchObject({ granted: true });
    expect(await stored(parked)).toMatchObject({ blocked_reason: null });
    expect((await stored(parked)).scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("releases them when an old Dodo subscription recovers to active, and not before", async () => {
    const dodoSubscriptionId = `sub_${randomUUID()}`;
    // On hold past its 7-day grace: the workspace is unlicensed and its email is parked.
    await pool.query(`INSERT INTO subscriptions (id,workspace_id,status,dodo_subscription_id,provider_updated_at,updated_at)
      VALUES ($1,$2,'on_hold',$3,$4,$5)`, [randomUUID(), ids.workspace, dodoSubscriptionId, new Date(Date.now() - 8 * 86_400_000), new Date(Date.now() - 8 * 86_400_000)]);
    const parked = await message({ blockedReason: "payment_required", scheduledAt: new Date(Date.now() + PAYMENT_REQUIRED_RETRY_MS) });
    const payload = (status: string, at: Date) => ({ subscription_id: dodoSubscriptionId, status, updated_at: at.toISOString(), customer: { customer_id: `cus_${ids.workspace}` }, product_id: "pdt_old_monthly", metadata: { workspaceId: ids.workspace } });

    const cancelled = await upsertDodoSubscription(db, ids.workspace, payload("cancelled", new Date(Date.now() - 60_000)), { eventType: "subscription.cancelled" });
    expect(cancelled.persisted).toBe(true);
    expect(await stored(parked)).toMatchObject({ blocked_reason: "payment_required" });

    const recovered = await db.transaction((tx) => upsertDodoSubscription(tx, ids.workspace, payload("active", new Date()), { eventType: "subscription.active" }));
    expect(recovered).toMatchObject({ persisted: true, status: "active" });
    expect(await stored(parked)).toMatchObject({ blocked_reason: null });
    expect((await stored(parked)).scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  // A follow-up the gate parked, then rescheduled by a resume after its wait
  // was edited, is timed by the sequence again: buying later must not send it
  // days early.
  it("never pulls forward a follow-up that a resume rescheduled from the sequence", async () => {
    const followUpStep = randomUUID();
    await pool.query("INSERT INTO sequence_steps (id,workspace_id,sequence_version_id,step_order,delay_days,subject,body_text) VALUES ($1,$2,$3,2,3,'Follow up','Follow up')", [followUpStep, ids.workspace, ids.version]);
    const sentAt = new Date(Date.now() - 86_400_000);
    const first = await message({ status: "accepted", blockedReason: null, scheduledAt: sentAt });
    await pool.query("UPDATE messages SET accepted_at=$2 WHERE id=$1", [first, sentAt]);
    const followUp = await message({ stepId: followUpStep, blockedReason: "payment_required", scheduledAt: new Date(Date.now() + PAYMENT_REQUIRED_RETRY_MS) });

    const now = new Date();
    await expect(refreshPendingOnResume(db, { workspaceId: ids.workspace, sequenceId: ids.sequence, enrollmentIds: [ids.enrollment], now })).resolves.toMatchObject({ rescheduled: 1 });
    const dueAt = new Date(sentAt.getTime() + 3 * 86_400_000 + followUpSendJitterMs(`${ids.enrollment}:2`));
    expect(await stored(followUp)).toEqual({ scheduled_at: dueAt, blocked_reason: null });

    await expect(releasePlanBlockedSends(db, ids.workspace, new Date())).resolves.toBe(0);
    expect(await stored(followUp)).toEqual({ scheduled_at: dueAt, blocked_reason: null });
  });

  // Runs the shipped SQL inside a transaction that is rolled back, so stamping
  // every other workspace in the shared test database never leaks out.
  it("0042 stamps a 30-day legacy Free window on every existing workspace, entitled or not", async () => {
    const migration = await readFile(new URL("../../db/migrations/0042_legacy_free_until.sql", import.meta.url), "utf8");
    // Entitled workspaces are stamped too: the gate checks the entitlement
    // first, and one that lapses inside the window falls back to the Free rules
    // instead of going straight to payment_required.
    const cases: Array<[string, string | null, string]> = [
      ["none", null, "stamped"],
      ["active", "active", "stamped"],
      ["trialing", "trialing", "stamped"],
      ["trial ended", "trialing", "stamped"],
      ["on_hold in grace", "on_hold", "stamped"],
      ["on_hold past grace", "on_hold", "stamped"],
      ["cancelled", "cancelled", "stamped"],
      ["refunded", "refunded", "stamped"],
    ];
    const workspaceIds = cases.map(() => randomUUID());
    const parkedOnPaid = await message({ blockedReason: "free_monthly_cap", scheduledAt: nextMonth() });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [index, [label, status]] of cases.entries()) {
        await client.query("INSERT INTO workspaces (id,name,slug,created_by_user_id) VALUES ($1,$2,$3,$4)", [workspaceIds[index], `0042 ${label}`, `m0042-${workspaceIds[index]}`, ids.user]);
        if (!status) continue;
        const trialEnd = label === "trialing" ? new Date(Date.now() + 86_400_000) : label === "trial ended" ? new Date(Date.now() - 60_000) : null;
        const updatedAt = label === "on_hold past grace" ? new Date(Date.now() - 8 * 86_400_000) : new Date();
        await client.query("INSERT INTO subscriptions (id,workspace_id,status,trial_end,updated_at) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), workspaceIds[index], status, trialEnd, updatedAt]);
      }
      const alreadyStamped = new Date("2027-01-01T00:00:00.000Z");
      await client.query("UPDATE workspaces SET legacy_free_until=$2 WHERE id=$1", [ids.other, alreadyStamped]);
      await client.query("INSERT INTO subscriptions (id,workspace_id,status) VALUES ($1,$2,'active')", [randomUUID(), ids.workspace]);

      // now() is fixed for the transaction, so this is exactly what the migration writes.
      const { now: before, stamp } = (await client.query<{ now: Date; stamp: Date }>("SELECT now() AS now, now() + interval '30 days' AS stamp")).rows[0]!;
      await client.query(migration);
      await client.query(migration);

      const rows = await client.query<{ id: string; legacy_free_until: Date | null }>("SELECT id,legacy_free_until FROM workspaces WHERE id = ANY($1::uuid[])", [[...workspaceIds, ids.other]]);
      const byId = new Map(rows.rows.map((row) => [row.id, row.legacy_free_until]));
      for (const [index, [label, , expected]] of cases.entries()) {
        const stamped = byId.get(workspaceIds[index]!);
        if (expected === "stamped") expect(stamped, label).toEqual(stamp);
        else expect(stamped, label).toBeNull();
      }
      // The entitled workspace that owns the parked message is stamped as well.
      const owner = await client.query<{ legacy_free_until: Date | null }>("SELECT legacy_free_until FROM workspaces WHERE id=$1", [ids.workspace]);
      expect(owner.rows[0]?.legacy_free_until).toEqual(stamp);
      // Re-running never moves a date already stamped.
      expect(byId.get(ids.other)).toEqual(alreadyStamped);
      // An entitled workspace's message parked by the old Free cap becomes due now.
      const released = await client.query<{ scheduled_at: Date; blocked_reason: string | null }>("SELECT scheduled_at,blocked_reason FROM messages WHERE id=$1", [parkedOnPaid]);
      expect(released.rows[0]).toEqual({ scheduled_at: before, blocked_reason: null });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
