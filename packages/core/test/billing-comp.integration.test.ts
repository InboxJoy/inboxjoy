import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  describeWorkspaceSubscription,
  expireCompSubscriptions,
  grantCompSubscription,
  hasSendingEntitlement,
  upsertDodoSubscription,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const subscriptionProductId = "pdt_test_subscription";
const otherProductId = "pdt_test_other";
const DAY = 86_400_000;

describe.skipIf(!databaseUrl)("billing comp subscriptions", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await pool.query("select 1");
  });

  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds.splice(0)) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createWorkspace(suffix: string) {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const ownerEmail = `comp-${suffix}@example.com`;
    await db.insert(schema.users).values({ id: userId, email: ownerEmail, normalizedEmail: ownerEmail, displayName: suffix });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: `Comp ${suffix}`, slug: `comp-${suffix}`, createdByUserId: userId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    createdWorkspaceIds.push(workspaceId);
    createdUserIds.push(userId);
    return { userId, workspaceId };
  }

  function dodoPayload(input: { dodoSubscriptionId: string; status: string; productId: string }) {
    return {
      subscription_id: input.dodoSubscriptionId,
      status: input.status,
      product_id: input.productId,
      customer: { customer_id: `cus_${input.dodoSubscriptionId}` },
      next_billing_date: new Date(Date.now() + 30 * DAY).toISOString(),
    };
  }

  it("grants a 12-month comp on a workspace with no subscription, and it is sending-entitled", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);
    const now = new Date("2026-01-01T00:00:00.000Z");

    const result = await grantCompSubscription(db, { workspaceId, months: 12, now });
    expect(result.granted).toBe(true);
    if (!result.granted) throw new Error("unreachable");

    const monthsOut = (result.endsAt.getTime() - now.getTime()) / DAY;
    expect(monthsOut).toBeGreaterThan(360);
    expect(monthsOut).toBeLessThan(370);

    const description = await describeWorkspaceSubscription(db, workspaceId);
    expect(description).toMatchObject({
      exists: true,
      status: "active",
      productId: null,
      hasDodoSubscription: false,
      isComp: true,
      cancelAtPeriodEnd: true,
    });
    expect(description.nextBillingDate?.toISOString()).toBe(result.endsAt.toISOString());

    expect(hasSendingEntitlement({ status: description.status, trialEnd: description.trialEnd, onHoldGraceEndsAt: null }, now, "cloud")).toBe(true);
  });

  it("refuses to grant a comp over a live Dodo subscription, but force overrides it", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);
    const dodoSubscriptionId = `sub_${suffix}`;
    await upsertDodoSubscription(db, workspaceId, dodoPayload({ dodoSubscriptionId, status: "active", productId: subscriptionProductId }), {
      providerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const refused = await grantCompSubscription(db, { workspaceId, months: 12, now: new Date("2026-01-02T00:00:00.000Z") });
    expect(refused).toEqual({ granted: false, reason: "live_dodo_subscription" });

    const forced = await grantCompSubscription(db, { workspaceId, months: 12, force: true, now: new Date("2026-01-02T00:00:00.000Z") });
    expect(forced.granted).toBe(true);

    const description = await describeWorkspaceSubscription(db, workspaceId);
    expect(description).toMatchObject({ status: "active", isComp: true, hasDodoSubscription: false });
  });

  it("is not overwritten by a late, older Dodo payload (e.g. a late subscription.expired for a previously cancelled sub)", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);
    const grantedAt = new Date("2026-02-01T00:00:00.000Z");

    const granted = await grantCompSubscription(db, { workspaceId, months: 1, now: grantedAt });
    expect(granted.granted).toBe(true);

    const staleUpsert = await upsertDodoSubscription(db, workspaceId, dodoPayload({ dodoSubscriptionId: `sub_${suffix}`, status: "expired", productId: subscriptionProductId }), {
      providerUpdatedAt: new Date(grantedAt.getTime() - 60 * 60 * 1000),
    });
    expect(staleUpsert.persisted).toBe(false);

    const description = await describeWorkspaceSubscription(db, workspaceId);
    expect(description).toMatchObject({ status: "active", isComp: true, hasDodoSubscription: false, productId: null });
  });

  it("is overwritten by a newer, live Dodo subscription (the customer became a real payer)", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);
    const grantedAt = new Date("2026-02-01T00:00:00.000Z");

    const granted = await grantCompSubscription(db, { workspaceId, months: 1, now: grantedAt });
    expect(granted.granted).toBe(true);

    const dodoSubscriptionId = `sub_${suffix}`;
    const freshUpsert = await upsertDodoSubscription(db, workspaceId, dodoPayload({ dodoSubscriptionId, status: "active", productId: otherProductId }), {
      providerUpdatedAt: new Date(grantedAt.getTime() + 60 * 60 * 1000),
    });
    expect(freshUpsert.persisted).toBe(true);

    const description = await describeWorkspaceSubscription(db, workspaceId);
    expect(description).toMatchObject({ status: "active", hasDodoSubscription: true, isComp: false, productId: otherProductId });
  });

  it("expires only comp rows past their end date, leaving real Dodo rows and unexpired comps alone", async () => {
    const expiredSuffix = randomUUID().slice(0, 8);
    const activeSuffix = randomUUID().slice(0, 8);
    const dodoSuffix = randomUUID().slice(0, 8);
    const { workspaceId: expiredCompWorkspaceId } = await createWorkspace(expiredSuffix);
    const { workspaceId: activeCompWorkspaceId } = await createWorkspace(activeSuffix);
    const { workspaceId: dodoWorkspaceId } = await createWorkspace(dodoSuffix);

    // Monthly comp granted 40 days ago: its end date (now + 1 month) is already in the past.
    await grantCompSubscription(db, { workspaceId: expiredCompWorkspaceId, months: 1, now: new Date(Date.now() - 40 * DAY) });
    // Yearly comp granted just now: not due to expire for ~12 months.
    await grantCompSubscription(db, { workspaceId: activeCompWorkspaceId, months: 12, now: new Date() });
    // A real Dodo-backed subscription with a next_billing_date in the past (e.g. a stale/overdue
    // renewal) must never be touched by comp expiry -- it has a dodo_subscription_id.
    await upsertDodoSubscription(db, dodoWorkspaceId, {
      subscription_id: `sub_${dodoSuffix}`,
      status: "active",
      product_id: subscriptionProductId,
      customer: { customer_id: `cus_${dodoSuffix}` },
      next_billing_date: new Date(Date.now() - 1 * DAY).toISOString(),
    }, { providerUpdatedAt: new Date() });

    const expiredCount = await expireCompSubscriptions(db);
    expect(expiredCount).toBe(1);

    const [expiredDescription, activeDescription, dodoDescription] = await Promise.all([
      describeWorkspaceSubscription(db, expiredCompWorkspaceId),
      describeWorkspaceSubscription(db, activeCompWorkspaceId),
      describeWorkspaceSubscription(db, dodoWorkspaceId),
    ]);

    expect(expiredDescription.status).toBe("expired");
    expect(activeDescription.status).toBe("active");
    expect(dodoDescription.status).toBe("active");
  });
});
