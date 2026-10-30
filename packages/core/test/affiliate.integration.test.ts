import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AFFILIATE_DEFAULT_COMMISSION_PERCENT,
  attributeReferral,
  ensureAffiliateCode,
  markAffiliateCommissionsPaid,
  operationByName,
  recordAffiliateCommission,
  reverseAffiliateCommission,
  runOperation,
  setAffiliateCommission,
  type OperationContext,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("affiliate program", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];
  // affiliate_refunded_payments has no workspace FK (it has to survive the
  // commission/referral rows it marks), so it needs its own cleanup.
  const createdPaymentIds: string[] = [];

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
    const paymentIds = createdPaymentIds.splice(0);
    if (paymentIds.length) {
      await db.delete(schema.affiliateRefundedPayments).where(inArray(schema.affiliateRefundedPayments.dodoPaymentId, paymentIds));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createWorkspace(suffix: string, ownerEmail = `affiliate-${suffix}@example.com`) {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(schema.users).values({ id: userId, email: ownerEmail, normalizedEmail: ownerEmail, displayName: suffix });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: `Affiliate ${suffix}`, slug: `affiliate-${suffix}`, createdByUserId: userId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    createdWorkspaceIds.push(workspaceId);
    createdUserIds.push(userId);
    return { userId, workspaceId };
  }

  function context(workspaceId: string, userId: string): OperationContext {
    return {
      db,
      workspaceId,
      userId,
      env: { edition: "selfhost", authSecret: "affiliate-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" },
    };
  }

  it("creates an affiliate code lazily and is idempotent across repeated calls", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);

    const first = await ensureAffiliateCode(db, workspaceId);
    const second = await ensureAffiliateCode(db, workspaceId);

    expect(first.code).toMatch(/^[a-z0-9]{8}$/);
    expect(second.code).toBe(first.code);
    expect(second.commissionPercent).toBe(AFFILIATE_DEFAULT_COMMISSION_PERCENT);

    const rows = await db.select().from(schema.affiliateCodes).where(eq(schema.affiliateCodes.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("ignores a self-referral", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);
    const { code } = await ensureAffiliateCode(db, workspaceId);

    const result = await attributeReferral(db, { code, referredWorkspaceId: workspaceId });

    expect(result).toBe("ignored");
    const referrals = await db.select().from(schema.affiliateReferrals).where(eq(schema.affiliateReferrals.affiliateWorkspaceId, workspaceId));
    expect(referrals).toHaveLength(0);
  });

  it("ignores a duplicate referral for the same referred workspace", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const referredSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { workspaceId: referredWorkspaceId } = await createWorkspace(referredSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);

    const first = await attributeReferral(db, { code, referredWorkspaceId });
    const second = await attributeReferral(db, { code, referredWorkspaceId });

    expect(first).toBe("attributed");
    expect(second).toBe("ignored");
    const referrals = await db.select().from(schema.affiliateReferrals).where(eq(schema.affiliateReferrals.referredWorkspaceId, referredWorkspaceId));
    expect(referrals).toHaveLength(1);
  });

  it("ignores a referral when the referred workspace's owner already belongs to the affiliate workspace", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);

    // The referred workspace's owner is a second, distinct user who is also a
    // member of the affiliate workspace (e.g. a teammate spinning up a second workspace).
    const sharedUserId = randomUUID();
    const referredWorkspaceId = randomUUID();
    const sharedSuffix = randomUUID().slice(0, 8);
    await db.insert(schema.users).values({ id: sharedUserId, email: `shared-${sharedSuffix}@example.com`, normalizedEmail: `shared-${sharedSuffix}@example.com`, displayName: "Shared" });
    await db.insert(schema.workspaces).values({ id: referredWorkspaceId, name: `Referred ${sharedSuffix}`, slug: `referred-${sharedSuffix}`, createdByUserId: sharedUserId });
    await db.insert(schema.memberships).values([
      { id: randomUUID(), workspaceId: referredWorkspaceId, userId: sharedUserId, role: "owner", status: "active", joinedAt: new Date() },
      { id: randomUUID(), workspaceId: affiliateWorkspaceId, userId: sharedUserId, role: "member", status: "active", joinedAt: new Date() },
    ]);
    createdWorkspaceIds.push(referredWorkspaceId);
    createdUserIds.push(sharedUserId);

    const result = await attributeReferral(db, { code, referredWorkspaceId });

    expect(result).toBe("ignored");
  });

  it("records a commission idempotently per dodo payment id and reverses it", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const referredSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { workspaceId: referredWorkspaceId } = await createWorkspace(referredSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);
    await attributeReferral(db, { code, referredWorkspaceId });

    const dodoPaymentId = `pay_${randomUUID()}`;
    createdPaymentIds.push(dodoPaymentId);
    const paidAt = new Date("2026-01-01T00:00:00.000Z");

    const first = await recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId, amountCents: 10_000, currency: "USD", paidAt });
    const duplicate = await recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId, amountCents: 10_000, currency: "USD", paidAt });

    expect(first).toBe("recorded");
    expect(duplicate).toBe("skipped");

    const commissions = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, dodoPaymentId));
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({
      commissionPercent: AFFILIATE_DEFAULT_COMMISSION_PERCENT,
      commissionCents: Math.floor((10_000 * AFFILIATE_DEFAULT_COMMISSION_PERCENT) / 100),
      status: "pending",
    });

    const reversed = await reverseAffiliateCommission(db, { dodoPaymentId });
    expect(reversed).toMatchObject({ reversed: true, alreadyPaid: null });
    const reversedAgain = await reverseAffiliateCommission(db, { dodoPaymentId });
    expect(reversedAgain).toMatchObject({ reversed: true, alreadyPaid: null });

    const [afterReverse] = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, dodoPaymentId));
    expect(afterReverse?.status).toBe("reversed");
  });

  it("does not reverse a commission that is already marked paid, and reports it for manual clawback", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const referredSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { workspaceId: referredWorkspaceId } = await createWorkspace(referredSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);
    await attributeReferral(db, { code, referredWorkspaceId });
    const dodoPaymentId = `pay_${randomUUID()}`;
    createdPaymentIds.push(dodoPaymentId);
    // Paid 40 days ago so the 30-day hold has passed and the payout actually marks it paid.
    await recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId, amountCents: 5_000, currency: "USD", paidAt: new Date(Date.now() - 40 * 86_400_000) });
    const payout = await markAffiliateCommissionsPaid(db, { workspaceId: affiliateWorkspaceId });
    expect(payout.commissionCount).toBe(1);

    const reversed = await reverseAffiliateCommission(db, { dodoPaymentId });

    expect(reversed.reversed).toBe(false);
    expect(reversed.alreadyPaid).toMatchObject({ commissionCents: 1_500, currency: "USD", affiliateWorkspaceId });
    const [row] = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, dodoPaymentId));
    expect(row?.status).toBe("paid");
  });

  it("reverses a commission up front when the refund arrives before the payment, leaving the same referral state as the in-order flow", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const referredSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { workspaceId: referredWorkspaceId } = await createWorkspace(referredSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);
    await attributeReferral(db, { code, referredWorkspaceId });

    const dodoPaymentId = `pay_${randomUUID()}`;
    createdPaymentIds.push(dodoPaymentId);
    const paidAt = new Date();

    // The refund webhook lands first: no commission row exists yet, so this is a no-op update,
    // but it must still leave the marker behind for the late payment to find.
    const reversedBeforeRecorded = await reverseAffiliateCommission(db, { dodoPaymentId });
    expect(reversedBeforeRecorded).toMatchObject({ reversed: false, alreadyPaid: null });

    const recordResult = await recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId, amountCents: 4_000, currency: "USD", paidAt });
    expect(recordResult).toBe("recorded_reversed");

    const [commission] = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, dodoPaymentId));
    expect(commission?.status).toBe("reversed");

    // Same referral outcome as the in-order flow (payment records it paid, refund only touches the commission).
    const [referral] = await db.select().from(schema.affiliateReferrals).where(eq(schema.affiliateReferrals.referredWorkspaceId, referredWorkspaceId));
    expect(referral?.status).toBe("paid");
    expect(referral?.firstPaidAt).not.toBeNull();
  });

  it("skips a commission once the payment falls outside the effective commission window", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const referredSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { workspaceId: referredWorkspaceId } = await createWorkspace(referredSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);
    await attributeReferral(db, { code, referredWorkspaceId });
    await setAffiliateCommission(db, { workspaceId: affiliateWorkspaceId, percent: null, months: 1 });

    const firstPaidAt = new Date("2026-01-01T00:00:00.000Z");
    const withinWindow = new Date("2026-01-20T00:00:00.000Z");
    const afterWindow = new Date("2026-03-15T00:00:00.000Z");

    await expect(recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId: `pay_${randomUUID()}`, amountCents: 1_000, currency: "USD", paidAt: firstPaidAt })).resolves.toBe("recorded");
    await expect(recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId: `pay_${randomUUID()}`, amountCents: 1_000, currency: "USD", paidAt: withinWindow })).resolves.toBe("recorded");
    await expect(recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId: `pay_${randomUUID()}`, amountCents: 1_000, currency: "USD", paidAt: afterWindow })).resolves.toBe("skipped");
  });

  it("applies a per-affiliate commission percent override when recording a commission", async () => {
    const affiliateSuffix = randomUUID().slice(0, 8);
    const referredSuffix = randomUUID().slice(0, 8);
    const { workspaceId: affiliateWorkspaceId } = await createWorkspace(affiliateSuffix);
    const { workspaceId: referredWorkspaceId } = await createWorkspace(referredSuffix);
    const { code } = await ensureAffiliateCode(db, affiliateWorkspaceId);
    await attributeReferral(db, { code, referredWorkspaceId });
    await setAffiliateCommission(db, { workspaceId: affiliateWorkspaceId, percent: 50, months: 6 });

    const dodoPaymentId = `pay_${randomUUID()}`;
    await recordAffiliateCommission(db, { referredWorkspaceId, dodoPaymentId, amountCents: 20_000, currency: "USD", paidAt: new Date() });

    const [row] = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, dodoPaymentId));
    expect(row).toMatchObject({ commissionPercent: 50, commissionCents: 10_000 });
  });

  it("rejects an out-of-range commission override", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { workspaceId } = await createWorkspace(suffix);

    await expect(setAffiliateCommission(db, { workspaceId, percent: 101, months: null })).rejects.toThrow();
    await expect(setAffiliateCommission(db, { workspaceId, percent: null, months: 0 })).rejects.toThrow();
  });

  it("keeps affiliate.get scoped to the calling workspace", async () => {
    const suffixA = randomUUID().slice(0, 8);
    const suffixB = randomUUID().slice(0, 8);
    const { workspaceId: workspaceIdA, userId: userIdA } = await createWorkspace(suffixA);
    const { workspaceId: workspaceIdB, userId: userIdB } = await createWorkspace(suffixB);
    const { code: codeA } = await ensureAffiliateCode(db, workspaceIdA);
    await attributeReferral(db, { code: codeA, referredWorkspaceId: workspaceIdB });
    await recordAffiliateCommission(db, { referredWorkspaceId: workspaceIdB, dodoPaymentId: `pay_${randomUUID()}`, amountCents: 8_000, currency: "USD", paidAt: new Date() });

    const resultA = await runOperation(operation("affiliate.get"), context(workspaceIdA, userIdA), {});
    const resultB = await runOperation(operation("affiliate.get"), context(workspaceIdB, userIdB), {});

    expect(resultA.code).toBe(codeA);
    expect(resultA.signups).toBe(1);
    expect(resultA.earnedCents).toBeGreaterThan(0);

    // Workspace B was referred, not an affiliate: it has its own (different) code and no earnings of its own.
    expect(resultB.code).not.toBe(codeA);
    expect(resultB.signups).toBe(0);
    expect(resultB.earnedCents).toBe(0);
  });
});
