import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  grantCompSubscription,
  grantLifetimeLicense,
  operationByName,
  revokeLifetimeLicense,
  runOperation,
  upsertDodoSubscription,
  type BillingClient,
  type OperationContext,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const lifetimeProductId = "pdt_test_lifetime";
const subscriptionProductId = "pdt_test_subscription";

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("lifetime license billing", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let userId = "";
  let workspaceId = "";
  let ownerEmail = "";

  const billingClient: BillingClient = {
    createCheckoutSession: async () => ({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_lifetime" }),
    createCustomerPortal: async () => ({ link: "https://test.dodopayments.com/portal/test" }),
    retrieveSubscription: async () => ({}),
    listSubscriptions: async () => [],
    updateSubscription: async () => ({}),
  };

  function context(overrides: Partial<OperationContext> = {}): OperationContext {
    return {
      db,
      workspaceId,
      userId,
      env: {
        edition: "cloud",
        authSecret: "billing-test-auth-secret-at-least-32-characters",
        apiBaseUrl: "https://api.example.test",
        webBaseUrl: "https://app.example.test",
        dodoPaymentsApiKey: "dodo_test_key",
        dodoProductLifetime: lifetimeProductId,
      },
      billing: billingClient,
      ...overrides,
    };
  }

  function lifetimePayment(overrides: Record<string, unknown> = {}) {
    return {
      payment_id: `pay_${randomUUID()}`,
      status: "succeeded",
      subscription_id: null,
      product_cart: [{ product_id: lifetimeProductId, quantity: 1 }],
      customer: { customer_id: `cus_${randomUUID()}`, email: ownerEmail, name: "Lifetime Test" },
      metadata: { workspaceId },
      total_amount: 7900,
      currency: "USD",
      created_at: "2026-10-28T10:00:00.000Z",
      refund_status: null,
      ...overrides,
    };
  }

  async function storedSubscription() {
    const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId)).limit(1);
    return row;
  }

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    ownerEmail = `lifetime-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({ id: userId, name: "Lifetime Test", email: ownerEmail, emailVerified: true });
    await db.insert(schema.users).values({ id: userId, email: ownerEmail, normalizedEmail: ownerEmail, displayName: "Lifetime Test" });
    await db.insert(schema.workspaces).values({ id: workspaceId, name: `Lifetime ${suffix}`, slug: `lifetime-${suffix}`, createdByUserId: userId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
  });

  afterEach(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (userId) await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("grants a lifetime license that billing reports as paid with no renewal", async () => {
    const payment = lifetimePayment();
    await expect(grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment })).resolves.toEqual({ granted: true, dodoPaymentId: payment.payment_id });

    expect(await storedSubscription()).toMatchObject({
      status: "active",
      productId: lifetimeProductId,
      dodoSubscriptionId: null,
      dodoCustomerId: payment.customer.customer_id,
      nextBillingDate: null,
      metadata: { lifetime: true, dodoPaymentId: payment.payment_id },
    });
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({
      tier: "lifetime",
      status: "active",
      nextBillingDate: null,
      cancelAtPeriodEnd: false,
      freePlan: false,
      needsLicense: false,
      sendingEnabled: true,
      monthlySendLimit: null,
      hasCustomer: true,
    });
  });

  it("returns a fully refunded workspace to needing the license and never re-grants that payment", async () => {
    const payment = lifetimePayment();
    await grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment });

    await expect(revokeLifetimeLicense(db, { dodoPaymentId: payment.payment_id })).resolves.toBe(workspaceId);
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "none", status: "refunded", needsLicense: true, sendingEnabled: false, freePlan: false });

    // A replayed webhook or stale provider listing for the refunded payment changes nothing.
    await expect(grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment })).resolves.toMatchObject({ granted: false });
    expect((await storedSubscription())?.status).toBe("refunded");
    await expect(revokeLifetimeLicense(db, { dodoPaymentId: "pay_not_a_lifetime_purchase" })).resolves.toBeUndefined();

    // Buying again with a new payment restores the license.
    await expect(grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment: lifetimePayment() })).resolves.toMatchObject({ granted: true });
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "lifetime", needsLicense: false, freePlan: false });
  });

  it("replaces a lapsed subscription and is never replaced by a later subscription event", async () => {
    await upsertDodoSubscription(db, workspaceId, {
      subscription_id: `sub_${randomUUID()}`,
      product_id: subscriptionProductId,
      status: "cancelled",
      customer: { customer_id: "cus_previous" },
      updated_at: "2026-09-01T00:00:00.000Z",
    }, { eventType: "subscription.cancelled" });

    await grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment: lifetimePayment({ customer: { customer_id: "cus_previous" } }) });

    const replaced = await upsertDodoSubscription(db, workspaceId, {
      subscription_id: `sub_${randomUUID()}`,
      product_id: subscriptionProductId,
      status: "active",
      customer: { customer_id: "cus_previous" },
      updated_at: "2026-12-01T00:00:00.000Z",
    }, { eventType: "subscription.active" });
    expect(replaced.persisted).toBe(false);
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "lifetime", status: "active" });
  });

  it("refuses a comp over an active lifetime license unless forced", async () => {
    await grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment: lifetimePayment() });

    await expect(grantCompSubscription(db, { workspaceId, months: 12 })).resolves.toEqual({ granted: false, reason: "lifetime_license" });
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "lifetime" });
  });

  it("refuses checkout for a workspace that already holds a lifetime license", async () => {
    await grantLifetimeLicense(db, { workspaceId, productId: lifetimeProductId, payment: lifetimePayment() });
    const createCheckoutSession = vi.fn<BillingClient["createCheckoutSession"]>(async () => ({}));

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing: { ...billingClient, createCheckoutSession } }), { productKey: "lifetime" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("grants a paid lifetime purchase found while replacing an expired checkout intent", async () => {
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "lifetime",
      idempotencyKey: `billing-checkout:${randomUUID()}`,
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_old",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const payment = lifetimePayment();
    const listPayments = vi.fn<NonNullable<BillingClient["listPayments"]>>(async () => [payment]);
    const createCheckoutSession = vi.fn<BillingClient["createCheckoutSession"]>(async () => ({}));

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing: { ...billingClient, listPayments, createCheckoutSession } }), { productKey: "lifetime" }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    expect(listPayments).toHaveBeenCalledWith({ customerEmail: ownerEmail, productId: lifetimeProductId });
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(await storedSubscription()).toMatchObject({ status: "active", metadata: { lifetime: true, dodoPaymentId: payment.payment_id } });
    expect(await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("reconciles a lifetime purchase whose webhook is late", async () => {
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "lifetime",
      idempotencyKey: `billing-checkout:${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const payment = lifetimePayment();
    const listPayments = vi.fn<NonNullable<BillingClient["listPayments"]>>(async () => [payment]);

    await expect(runOperation(operation("billing.reconcile"), context({ billing: { ...billingClient, listPayments } }), {}))
      .resolves.toMatchObject({ tier: "lifetime", status: "active", freePlan: false, hasCustomer: true, reconciled: true });
    expect(await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId))).toHaveLength(0);

    // Once granted there is nothing left to refresh from the provider.
    listPayments.mockClear();
    await expect(runOperation(operation("billing.reconcile"), context({ billing: { ...billingClient, listPayments } }), {}))
      .resolves.toMatchObject({ tier: "lifetime", reconciled: false });
    expect(listPayments).not.toHaveBeenCalled();
  });

  it("does not reconcile refunded or another workspace's lifetime payments", async () => {
    const listPayments = vi.fn<NonNullable<BillingClient["listPayments"]>>(async () => [
      lifetimePayment({ refund_status: "full" }),
      lifetimePayment({ metadata: { workspaceId: randomUUID() } }),
    ]);

    // A workspace created after the legacy Free window shipped has no window,
    // so without a license it still needs one.
    await expect(runOperation(operation("billing.reconcile"), context({ billing: { ...billingClient, listPayments } }), {}))
      .resolves.toMatchObject({ tier: "none", freePlan: false, needsLicense: true, legacyFreeEndsAt: null, reconciled: false });
    expect(await storedSubscription()).toBeUndefined();
  });
});
