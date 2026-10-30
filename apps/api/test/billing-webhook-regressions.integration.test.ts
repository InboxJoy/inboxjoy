import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService } from "@inboxjoy/email";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerBillingRoutes } from "../src/modules/billing/index.js";

const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = "billing-regression-webhook-test-secret";
const webhookKey = `whsec_${Buffer.from(webhookSecret).toString("base64")}`;

function signature(body: string, webhookId: string, timestamp: string): string {
  return `v1,${createHmac("sha256", webhookSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`;
}

describe.skipIf(!databaseUrl)("Dodo billing webhook regressions", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const workspaceIds: string[] = [];
  const webhookIds: string[] = [];
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "billing-regression-auth-secret-at-least-32-characters",
    DODO_PAYMENTS_WEBHOOK_KEY: webhookKey,
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  });
  let app: FastifyInstance;

  async function createWorkspace(): Promise<string> {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: "Billing regression workspace",
      slug: `billing-regression-${randomUUID().slice(0, 8)}`,
    });
    return workspaceId;
  }

  async function sendWebhook(payload: Record<string, unknown>): Promise<void> {
    const webhookId = `wh_regression_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload);
    webhookIds.push(webhookId);
    const response = await app.inject({
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
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });
  }

  beforeAll(async () => {
    app = Fastify();
    await app.register(rawBody, { global: false, encoding: "utf8" });
    registerBillingRoutes(app, env, {
      db,
      runOperation: async () => ({}),
      transactionalEmail: disabledTransactionalEmailService,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const webhookId of webhookIds) {
      await db.delete(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId));
    }
    for (const workspaceId of workspaceIds) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    await pool.end();
  });

  it.each(["active", "on_hold", "trialing"] as const)("does not let an old subscription replace a newer %s workspace subscription", async (status) => {
    const workspaceId = await createWorkspace();
    const newerSubscriptionId = "sub_newer_" + randomUUID();
    await db.insert(schema.subscriptions).values({
      id: randomUUID(), workspaceId, dodoSubscriptionId: newerSubscriptionId,
      productId: "pdt_test_yearly", status,
      providerUpdatedAt: new Date("2030-01-10T00:00:00.000Z"),
    });

    await sendWebhook({
      type: "subscription.cancelled",
      data: {
        subscription_id: "sub_old_" + randomUUID(),
        product_id: "pdt_test_monthly",
        status: "cancelled",
        updated_at: "2030-01-20T00:00:00.000Z",
        metadata: { workspaceId },
      },
    });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ dodoSubscriptionId: newerSubscriptionId, productId: "pdt_test_yearly", status });
  });

  it("lets a newer live subscription replace a different live subscription", async () => {
    const workspaceId = await createWorkspace();
    const oldSubscriptionId = "sub_live_old_" + randomUUID();
    const newSubscriptionId = "sub_live_new_" + randomUUID();
    await db.insert(schema.subscriptions).values({
      id: randomUUID(), workspaceId, dodoSubscriptionId: oldSubscriptionId,
      productId: "pdt_test_monthly", status: "active",
      providerUpdatedAt: new Date("2030-01-10T00:00:00.000Z"),
    });

    await sendWebhook({
      type: "subscription.active",
      data: {
        subscription_id: newSubscriptionId,
        product_id: "pdt_test_yearly",
        status: "active",
        updated_at: "2030-01-20T00:00:00.000Z",
        metadata: { workspaceId },
      },
    });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ dodoSubscriptionId: newSubscriptionId, productId: "pdt_test_yearly", status: "active" });
  });

  it("lets a live subscription replace a cancelled subscription", async () => {
    const workspaceId = await createWorkspace();
    const oldSubscriptionId = "sub_cancelled_old_" + randomUUID();
    const newSubscriptionId = "sub_live_new_" + randomUUID();
    await db.insert(schema.subscriptions).values({
      id: randomUUID(), workspaceId, dodoSubscriptionId: oldSubscriptionId,
      productId: "pdt_test_monthly", status: "cancelled",
      providerUpdatedAt: new Date("2030-01-10T00:00:00.000Z"),
    });

    await sendWebhook({
      type: "subscription.active",
      data: {
        subscription_id: newSubscriptionId,
        product_id: "pdt_test_yearly",
        status: "active",
        updated_at: "2030-01-20T00:00:00.000Z",
        metadata: { workspaceId },
      },
    });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ dodoSubscriptionId: newSubscriptionId, productId: "pdt_test_yearly", status: "active" });
  });

  it("stores a first payment failure as failed without granting grace", async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = `sub_initial_failure_${randomUUID()}`;

    await sendWebhook({
      type: "payment.failed",
      timestamp: "2030-01-03T00:00:00.000Z",
      data: {
        subscription_id: subscriptionId,
        product_id: "pdt_test_yearly",
        updated_at: "2030-01-01T00:00:00.000Z",
        metadata: { workspaceId },
      },
    });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({
      dodoSubscriptionId: subscriptionId,
      status: "failed",
      providerUpdatedAt: new Date("2030-01-03T00:00:00.000Z"),
    });
  });

  it("accepts an equal-time renewal failure, uses the envelope time, and preserves cancellation data", async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = `sub_renewal_failure_${randomUUID()}`;
    const nextBillingDate = new Date("2030-02-01T00:00:00.000Z");
    const trialEnd = new Date("2029-12-31T00:00:00.000Z");
    const providerUpdatedAt = new Date("2030-01-03T00:00:00.000Z");
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      dodoSubscriptionId: subscriptionId,
      productId: "pdt_test_yearly",
      status: "active",
      nextBillingDate,
      trialEnd,
      cancelAtPeriodEnd: true,
      providerUpdatedAt,
    });

    await sendWebhook({
      type: "payment.failed",
      timestamp: providerUpdatedAt.toISOString(),
      data: {
        subscription_id: subscriptionId,
        updated_at: "2030-01-01T00:00:00.000Z",
        metadata: { workspaceId },
      },
    });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({
      status: "on_hold",
      productId: "pdt_test_yearly",
      nextBillingDate,
      trialEnd,
      cancelAtPeriodEnd: true,
      providerUpdatedAt,
    });
  });

  it("keeps the on-hold grace anchor and stored fields across sparse equal-time updates", async () => {
    const workspaceId = await createWorkspace();
    const subscriptionId = `sub_on_hold_${randomUUID()}`;
    const heldAt = new Date("2020-12-20T00:00:00.000Z");
    const providerUpdatedAt = new Date("2030-01-03T00:00:00.000Z");
    const nextBillingDate = new Date("2030-02-01T00:00:00.000Z");
    const trialEnd = new Date("2029-12-31T00:00:00.000Z");
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      dodoSubscriptionId: subscriptionId,
      productId: "pdt_test_yearly",
      status: "on_hold",
      nextBillingDate,
      trialEnd,
      providerUpdatedAt,
      metadata: { marker: "before" },
      updatedAt: heldAt,
    });

    await sendWebhook({
      type: "subscription.updated",
      timestamp: "2030-01-04T00:00:00.000Z",
      data: {
        subscription_id: subscriptionId,
        status: "on_hold",
        updated_at: providerUpdatedAt.toISOString(),
        metadata: { workspaceId },
        marker: "after",
      },
    });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({
      status: "on_hold",
      productId: "pdt_test_yearly",
      nextBillingDate,
      trialEnd,
      providerUpdatedAt,
      updatedAt: heldAt,
      metadata: expect.objectContaining({ marker: "after" }),
    });

    await sendWebhook({
      type: "subscription.active",
      timestamp: "2030-01-04T00:00:00.000Z",
      data: {
        subscription_id: subscriptionId,
        status: "active",
        updated_at: "2030-01-04T00:00:00.000Z",
        metadata: { workspaceId },
      },
    });

    const [reactivated] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.updatedAt.getTime()).toBeGreaterThan(heldAt.getTime());
  });
});
