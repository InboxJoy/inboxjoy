import { loadAppEnv } from "@inboxjoy/config";
import type { BillingClient } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = "billing-webhook-test-secret";
const webhookKey = `whsec_${Buffer.from(webhookSecret).toString("base64")}`;

function signature(body: string, webhookId: string, timestamp: string): string {
  return `v1,${createHmac("sha256", webhookSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`;
}

describe.skipIf(!databaseUrl)("Dodo billing webhook", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const workspaceId = randomUUID();
  const processedWebhookIds: string[] = [];
  const updateSubscriptionCalls: Array<{ subscriptionId: string; input: unknown }> = [];
  const checkoutMetadata: unknown[] = [];
  let failNextCancellation = false;
  const dodo: BillingClient = {
    createCheckoutSession: async (input) => {
      checkoutMetadata.push(input.metadata);
      return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_api" };
    },
    createCustomerPortal: async () => ({}),
    retrieveSubscription: async () => ({}),
    listSubscriptions: async () => [],
    updateSubscription: async (subscriptionId, input) => {
      updateSubscriptionCalls.push({ subscriptionId, input });
      if (failNextCancellation) throw new Error("Dodo Payments is unavailable");
      return {};
    },
  };
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "billing-webhook-auth-secret-at-least-32-characters",
    // Billing operations exist only in the managed edition.
    INBOXJOY_EDITION: "cloud",
    DODO_PAYMENTS_API_KEY: "dodo_test_key",
    DODO_PAYMENTS_WEBHOOK_KEY: webhookKey,
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    DODO_PRODUCT_LIFETIME: "pdt_test_lifetime",
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await db.insert(schema.workspaces).values({ id: workspaceId, name: "Webhook workspace", slug: `webhook-${randomUUID().slice(0, 8)}` });
    app = await buildApp({ env, db, dodo });
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    for (const webhookId of processedWebhookIds) {
      await db.delete(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId));
    }
    await pool.end();
  });

  it("upserts an active subscription and deduplicates the same webhook id", async () => {
    const webhookId = `wh_test_${randomUUID()}`;
    processedWebhookIds.push(webhookId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "subscription.active",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: `sub_test_${randomUUID()}`,
        product_id: "pdt_test_monthly",
        status: "active",
        next_billing_date: "2026-09-30T00:00:00.000Z",
        cancel_at_next_billing_date: false,
        customer: { customer_id: `cus_test_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
        // Checkout metadata also carries the analytics visitor id; the workspace join ignores it.
        metadata: { workspaceId, piqo_visitor_id: "0123456789abcdef" },
      },
    });
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature(body, webhookId, timestamp),
    };

    const first = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true, duplicate: false });
    const [created] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(created).toMatchObject({ productId: "pdt_test_monthly", status: "active", cancelAtPeriodEnd: false });

    await db.update(schema.subscriptions).set({ status: "paused" }).where(eq(schema.subscriptions.workspaceId, workspaceId));
    const duplicate = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ received: true, duplicate: true });
    const [unchanged] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(unchanged?.status).toBe("paused");
    expect(await db.select().from(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId))).toHaveLength(1);
  });

  it("rejects unsigned and invalidly signed webhook requests", async () => {
    const body = JSON.stringify({ type: "subscription.active", data: {} });
    const unsigned = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers: { "content-type": "application/json" }, payload: body });
    expect(unsigned.statusCode).toBe(401);

    const webhookId = `wh_bad_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/webhooks/dodo",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": "v1,not-a-valid-signature",
      },
      payload: body,
    });
    expect(invalid.statusCode).toBe(401);
  });

  it("orders subscription changes by provider event time and permits a newer reactivation", async () => {
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    const subscriptionId = `sub_ordering_${randomUUID()}`;
    const send = async (eventType: "subscription.active" | "subscription.cancelled", eventTime: string) => {
      const webhookId = `wh_ordering_${randomUUID()}`;
      processedWebhookIds.push(webhookId);
      const signatureTimestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        business_id: "bus_test",
        type: eventType,
        timestamp: eventTime,
        data: {
          subscription_id: subscriptionId,
          product_id: "pdt_test_monthly",
          status: eventType === "subscription.active" ? "active" : "cancelled",
          cancel_at_next_billing_date: eventType === "subscription.cancelled",
          customer: { customer_id: `cus_test_${randomUUID()}` },
          metadata: { workspaceId },
        },
      });
      return app.inject({
        method: "POST",
        url: "/v1/webhooks/dodo",
        headers: {
          "content-type": "application/json",
          "webhook-id": webhookId,
          "webhook-timestamp": signatureTimestamp,
          "webhook-signature": signature(body, webhookId, signatureTimestamp),
        },
        payload: body,
      });
    };

    expect((await send("subscription.cancelled", "2030-01-02T00:00:00.000Z")).statusCode).toBe(200);
    expect((await send("subscription.active", "2030-01-01T00:00:00.000Z")).statusCode).toBe(200);
    let [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ status: "cancelled", providerUpdatedAt: new Date("2030-01-02T00:00:00.000Z") });

    expect((await send("subscription.active", "2030-01-03T00:00:00.000Z")).statusCode).toBe(200);
    [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ status: "active", providerUpdatedAt: new Date("2030-01-03T00:00:00.000Z") });
  });

  it("forwards the Piqo visitor cookie to checkout metadata and drops a malformed one", async () => {
    const attributed = await createAuthenticatedSession(app, "Attributed Checkout Owner");
    const unattributed = await createAuthenticatedSession(app, "Unattributed Checkout Owner");
    checkoutMetadata.length = 0;

    const withCookie = await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: { cookie: `${attributed.cookie}; piqo_visitor=0123456789abcdef` }, payload: { productKey: "lifetime" } });
    const withMalformedCookie = await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: { cookie: `piqo_visitor=<script>; ${unattributed.cookie}` }, payload: { productKey: "lifetime" } });

    try {
      expect(withCookie.statusCode).toBe(200);
      expect(withMalformedCookie.statusCode).toBe(200);
      expect(checkoutMetadata).toEqual([
        { workspaceId: attributed.workspaceId, piqo_visitor_id: "0123456789abcdef" },
        { workspaceId: unattributed.workspaceId },
      ]);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, attributed.workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, unattributed.workspaceId));
    }
  });

  it("cancels the Dodo subscription before deleting a workspace", async () => {
    const session = await createAuthenticatedSession(app, "Delete With Subscription Owner");
    const dodoSubscriptionId = `sub_delete_${randomUUID()}`;
    await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId: session.workspaceId, dodoSubscriptionId, status: "active" });
    updateSubscriptionCalls.length = 0;

    const workspace = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/workspace" });
    const workspaceName = workspace.json().workspace.name as string;

    const response = await app.inject({ method: "DELETE", headers: { cookie: session.cookie }, url: "/v1/workspace", payload: { confirmation: workspaceName } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted: true, workspaceId: session.workspaceId });
    expect(updateSubscriptionCalls).toEqual([{ subscriptionId: dodoSubscriptionId, input: { status: "cancelled", cancel_reason: "cancelled_by_customer" } }]);
    expect(await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId))).toHaveLength(0);
  });

  it("leaves the workspace intact when the Dodo cancellation call fails", async () => {
    const session = await createAuthenticatedSession(app, "Delete Cancel Failure Owner");
    const dodoSubscriptionId = `sub_delete_fail_${randomUUID()}`;
    await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId: session.workspaceId, dodoSubscriptionId, status: "active" });
    updateSubscriptionCalls.length = 0;
    failNextCancellation = true;

    try {
      const workspace = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/workspace" });
      const workspaceName = workspace.json().workspace.name as string;

      const response = await app.inject({ method: "DELETE", headers: { cookie: session.cookie }, url: "/v1/workspace", payload: { confirmation: workspaceName } });
      expect(response.statusCode).toBe(503);
      expect(updateSubscriptionCalls).toEqual([{ subscriptionId: dodoSubscriptionId, input: { status: "cancelled", cancel_reason: "cancelled_by_customer" } }]);
      expect(await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId))).toHaveLength(1);
    } finally {
      failNextCancellation = false;
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    }
  });

  it("deletes a workspace without contacting Dodo when it has no subscription", async () => {
    const session = await createAuthenticatedSession(app, "Delete Without Subscription Owner");
    updateSubscriptionCalls.length = 0;

    const workspace = await app.inject({ method: "GET", headers: { cookie: session.cookie }, url: "/v1/workspace" });
    const workspaceName = workspace.json().workspace.name as string;

    const response = await app.inject({ method: "DELETE", headers: { cookie: session.cookie }, url: "/v1/workspace", payload: { confirmation: workspaceName } });
    expect(response.statusCode).toBe(200);
    expect(updateSubscriptionCalls).toEqual([]);
    expect(await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId))).toHaveLength(0);
  });
});
