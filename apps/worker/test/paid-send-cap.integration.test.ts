import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PAID_WORKSPACE_TICK_CAP_SQL, perWorkspaceTickCapSql } from "../src/jobs/schedule-due-messages.js";

const databaseUrl = process.env.DATABASE_URL;

// schedule-due-messages.ts sizes the per-workspace tick cap in cloud using
// PAID_WORKSPACE_TICK_CAP_SQL (the entitlement rule, entitlingSubscriptionSql)
// against the real `subscriptions` row. Dodo billing never writes the legacy
// `subscriptions.plan` column, so every paying and comped workspace keeps
// `plan='free'` forever. This test runs the exact production SQL fragment
// against Postgres to prove the cap keys off status (+ trial end and on_hold
// grace window) instead of that dead column. Self-host gives everyone the paid
// tick size without asking the database.
describe.skipIf(!databaseUrl)("paid workspace tick cap", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = { user: randomUUID(), workspace: randomUUID() };
  const now = new Date("2026-09-01T12:00:00.000Z");

  const isPaidCap = async (subscription: { status: string; updatedAt?: Date; trialEnd?: Date } | null): Promise<boolean> => {
    await pool.query("DELETE FROM subscriptions WHERE workspace_id=$1", [ids.workspace]);
    if (subscription) {
      await pool.query(
        "INSERT INTO subscriptions (id,workspace_id,plan,status,trial_end,updated_at) VALUES ($1,$2,'free',$3,$4,$5)",
        [randomUUID(), ids.workspace, subscription.status, subscription.trialEnd ?? null, subscription.updatedAt ?? now],
      );
    }
    const result = await pool.query<{ paid: boolean }>(
      `SELECT (CASE WHEN ${PAID_WORKSPACE_TICK_CAP_SQL} THEN true ELSE false END) AS paid
       FROM workspaces w LEFT JOIN subscriptions sub ON sub.workspace_id=w.id
       WHERE w.id=$2`,
      [now, ids.workspace],
    );
    return result.rows[0]?.paid === true;
  };

  beforeAll(async () => {
    const email = `paid-send-cap-${ids.user}@example.com`;
    await pool.query("INSERT INTO auth_users (id,name,email,email_verified) VALUES ($1,'Paid Send Cap',$2,true)", [ids.user, email]);
    await pool.query("INSERT INTO users (id,email,normalized_email) VALUES ($1,$2,$2)", [ids.user, email]);
    await pool.query("INSERT INTO workspaces (id,name,slug,created_by_user_id) VALUES ($1,'Paid Send Cap',$2,$3)", [ids.workspace, `paid-send-cap-${ids.workspace}`, ids.user]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id=$1", [ids.workspace]);
    await pool.query("DELETE FROM users WHERE id=$1", [ids.user]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [ids.user]);
    await pool.end();
  });

  it("gets the default cap with no subscription row (new/free workspace)", async () => {
    expect(await isPaidCap(null)).toBe(false);
  });

  it("gets the paid cap when active, even with the legacy plan column left at 'free' (real paying/comped workspaces)", async () => {
    expect(await isPaidCap({ status: "active" })).toBe(true);
  });

  it("gets the paid cap while trialing before the trial ends, matching canSend's entitlement", async () => {
    expect(await isPaidCap({ status: "trialing", trialEnd: new Date(now.getTime() + 3 * 86_400_000) })).toBe(true);
  });

  it("gets the default cap once the trial has ended", async () => {
    expect(await isPaidCap({ status: "trialing", trialEnd: new Date(now.getTime() - 60_000) })).toBe(false);
  });

  it("gives every self-hosted workspace the paid cap and keeps the CASE in cloud", () => {
    expect(perWorkspaceTickCapSql("selfhost")).toBe("1000");
    expect(perWorkspaceTickCapSql("cloud")).toBe(`(CASE WHEN ${PAID_WORKSPACE_TICK_CAP_SQL} THEN 1000 ELSE 100 END)`);
  });

  it("gets the paid cap while on_hold inside the 7-day grace window", async () => {
    expect(await isPaidCap({ status: "on_hold", updatedAt: new Date(now.getTime() - 86_400_000) })).toBe(true);
  });

  it("gets the default cap once the on_hold grace window has expired", async () => {
    expect(await isPaidCap({ status: "on_hold", updatedAt: new Date(now.getTime() - 8 * 86_400_000) })).toBe(false);
  });

  it("gets the default cap when cancelled", async () => {
    expect(await isPaidCap({ status: "cancelled" })).toBe(false);
  });
});
