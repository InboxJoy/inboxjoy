import { loadAppEnv } from "@inboxjoy/config";
import type { BillingClient } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = "billing-lifetime-webhook-test-secret";
const webhookKey = `whsec_${Buffer.from(webhookSecret).toString("base64")}`;
const lifetimeProductId = "pdt_test_lifetime";

function signature(body: string, webhookId: string, timestamp: string): string {
  return `v1,${createHmac("sha256", webhookSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`;
}

describe.skipIf(!databaseUrl)("Dodo lifetime license webhooks", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const processedWebhookIds: string[] = [];
  let workspaceId = "";
  const retrievePayment = vi.fn<NonNullable<BillingClient["retrievePayment"]>>();
  const dodo: BillingClient = {
    createCheckoutSession: async () => ({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_api" }),
    createCustomerPortal: async () => ({}),
    retrieveSubscription: async () => ({}),
    listSubscriptions: async () => [],
    updateSubscription: async () => ({}),
    retrievePayment,
  };
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "billing-lifetime-auth-secret-at-least-32-characters",
    DODO_PAYMENTS_API_KEY: "dodo_test_key",
    DODO_PAYMENTS_WEBHOOK_KEY: webhookKey,
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    DODO_PRODUCT_LIFETIME: lifetimeProductId,
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  function lifetimePayment(overrides: Record<string, unknown> = {}) {
    return {
      payment_id: `pay_${randomUUID()}`,
      status: "succeeded",
      subscription_id: null,
      product_cart: [{ product_id: lifetimeProductId, quantity: 1 }],
      customer: { customer_id: `cus_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
      metadata: { workspaceId },
      total_amount: 7900,
      currency: "USD",
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  async function deliver(type: string, data: Record<string, unknown>) {
    const webhookId = `wh_lifetime_${randomUUID()}`;
    processedWebhookIds.push(webhookId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ business_id: "bus_test", type, timestamp: new Date().toISOString(), data });
    return app.inject({
      method: "POST",
      url: "/v1/webhooks/dodo",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature(body, webhookId, timestamp),
      },
      payload: body,
    });
  }

  async function storedSubscription() {
    const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId)).limit(1);
    return row;
  }

  beforeAll(async () => {
    app = await buildApp({ env, db, dodo });
  });

  beforeEach(async () => {
    workspaceId = randomUUID();
    retrievePayment.mockReset();
    await db.insert(schema.workspaces).values({ id: workspaceId, name: "Lifetime webhook workspace", slug: `lifetime-webhook-${randomUUID().slice(0, 8)}` });
  });

  afterEach(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  afterAll(async () => {
    await app?.close();
    for (const webhookId of processedWebhookIds) {
      await db.delete(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId));
    }
    await pool.end();
  });

  it("grants the lifetime license when its one-time payment succeeds", async () => {
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "lifetime",
      idempotencyKey: `billing-checkout:${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const payment = lifetimePayment();

    const response = await deliver("payment.succeeded", payment);

    expect(response.statusCode).toBe(200);
    expect(await storedSubscription()).toMatchObject({
      status: "active",
      productId: lifetimeProductId,
      dodoSubscriptionId: null,
      dodoCustomerId: payment.customer.customer_id,
      nextBillingDate: null,
      metadata: { lifetime: true, dodoPaymentId: payment.payment_id },
    });
    expect(await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId))).toHaveLength(0);
    expect(retrievePayment).not.toHaveBeenCalled();
  });

  it("reads the payment back from Dodo when the webhook omits its cart", async () => {
    const payment = lifetimePayment();
    retrievePayment.mockResolvedValue(payment);
    const { product_cart: _cart, ...withoutCart } = payment;

    const response = await deliver("payment.succeeded", withoutCart);

    expect(response.statusCode).toBe(200);
    expect(retrievePayment).toHaveBeenCalledWith(payment.payment_id);
    expect(await storedSubscription()).toMatchObject({ status: "active", metadata: { lifetime: true, dodoPaymentId: payment.payment_id } });
  });

  it("asks Dodo to retry when the payment lookup fails", async () => {
    retrievePayment.mockRejectedValue(new Error("Dodo Payments is unavailable"));
    const { product_cart: _cart, ...withoutCart } = lifetimePayment();

    const response = await deliver("payment.succeeded", withoutCart);

    expect(response.statusCode).toBe(503);
    expect(await storedSubscription()).toBeUndefined();
    const webhookId = processedWebhookIds.at(-1)!;
    expect(await db.select().from(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId))).toHaveLength(0);
  });

  it("ignores subscription renewal payments and other products", async () => {
    await deliver("payment.succeeded", lifetimePayment({ subscription_id: `sub_${randomUUID()}` }));
    await deliver("payment.succeeded", lifetimePayment({ product_cart: [{ product_id: "pdt_test_other", quantity: 1 }] }));

    expect(await storedSubscription()).toBeUndefined();
  });

  it("keeps the license after a partial refund and ends it after a full refund", async () => {
    const payment = lifetimePayment();
    await deliver("payment.succeeded", payment);

    await deliver("refund.succeeded", { refund_id: `ref_${randomUUID()}`, payment_id: payment.payment_id, is_partial: true, status: "succeeded", amount: 1000, currency: "USD" });
    expect((await storedSubscription())?.status).toBe("active");

    await deliver("refund.succeeded", { refund_id: `ref_${randomUUID()}`, payment_id: payment.payment_id, is_partial: false, status: "succeeded", amount: 7900, currency: "USD" });
    expect((await storedSubscription())?.status).toBe("refunded");
  });

  it("ends the license when Dodo loses a dispute on its payment", async () => {
    const payment = lifetimePayment();
    await deliver("payment.succeeded", payment);

    const response = await deliver("dispute.lost", { dispute_id: `dp_${randomUUID()}`, payment_id: payment.payment_id, amount: "7900", currency: "USD", dispute_status: "dispute_lost" });

    expect(response.statusCode).toBe(200);
    expect((await storedSubscription())?.status).toBe("refunded");
  });
});
