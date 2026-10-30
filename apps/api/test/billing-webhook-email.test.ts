import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService, type PaymentFailedEmailInput, type PaymentSucceededEmailInput, type TransactionalEmailService } from "@inboxjoy/email";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerBillingRoutes } from "../src/modules/billing/index.js";

const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = "billing-email-webhook-test-secret";
const webhookKey = `whsec_${Buffer.from(webhookSecret).toString("base64")}`;

function signature(body: string, webhookId: string, timestamp: string): string {
  return `v1,${createHmac("sha256", webhookSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`;
}

function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function recordingTransactionalEmail(): TransactionalEmailService & {
  succeeded: PaymentSucceededEmailInput[];
  failed: PaymentFailedEmailInput[];
} {
  const succeeded: PaymentSucceededEmailInput[] = [];
  const failed: PaymentFailedEmailInput[] = [];
  return {
    ...disabledTransactionalEmailService,
    enabled: true,
    succeeded,
    failed,
    async sendWelcome() {},
    async sendPasswordReset() {},
    async sendSequenceTest() {},
    async sendTrialEnding() {},
    async sendPaymentSucceeded(input) {
      succeeded.push(input);
    },
    async sendPaymentFailed(input) {
      failed.push(input);
    },
    async sendMailboxAlert() {},
    async sendCampaignCompleted() {},
    async sendReplyReceived() {},
  };
}

describe.skipIf(!databaseUrl)("Dodo billing webhook — transactional emails", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "billing-email-webhook-auth-secret-at-least-32-characters",
    DODO_PAYMENTS_API_KEY: "dodo_test_key",
    DODO_PAYMENTS_WEBHOOK_KEY: webhookKey,
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    // Configured as in production, so existing subscribers' labels are checked
    // alongside the lifetime product.
    DODO_PRODUCT_LIFETIME: "pdt_test_lifetime",
  });

  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const webhookIds: string[] = [];

  async function seedOwner(workspaceId: string, ownerEmail: string, ownerName: string): Promise<void> {
    const userId = randomUUID();
    userIds.push(userId);
    await db.insert(schema.workspaces).values({ id: workspaceId, name: "Webhook email workspace", slug: `webhook-email-${randomUUID().slice(0, 8)}` });
    workspaceIds.push(workspaceId);
    await db.insert(schema.users).values({ id: userId, email: ownerEmail, normalizedEmail: ownerEmail.toLowerCase(), displayName: ownerName });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active" });
  }

  function buildApp(transactionalEmail: TransactionalEmailService): Promise<FastifyInstance> {
    const app = Fastify();
    return app.register(rawBody, { global: false, encoding: "utf8" }).then(() => {
      registerBillingRoutes(app, env, { db, runOperation: async () => ({}), transactionalEmail });
      return app.ready().then(() => app);
    });
  }

  afterAll(async () => {
    for (const webhookId of webhookIds) {
      await db.delete(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId));
    }
    for (const workspaceId of workspaceIds) {
      await db.delete(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
      await db.delete(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    for (const userId of userIds) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await pool.end();
  });

  it("sends payment-succeeded once on the first webhook and skips the replay", async () => {
    const workspaceId = randomUUID();
    await seedOwner(workspaceId, `owner-succeeded-${randomUUID()}@example.test`, "Succeeded Owner");
    const email = recordingTransactionalEmail();
    const app = await buildApp(email);

    const webhookId = `wh_succeeded_${randomUUID()}`;
    webhookIds.push(webhookId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "subscription.active",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: `sub_test_${randomUUID()}`,
        product_id: "pdt_test_yearly",
        status: "active",
        next_billing_date: "2026-10-15T00:00:00.000Z",
        cancel_at_next_billing_date: false,
        currency: "USD",
        recurring_pre_tax_amount: 2500,
        customer: { customer_id: `cus_test_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
        metadata: { workspaceId },
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
    expect(email.succeeded).toHaveLength(1);
    expect(email.succeeded[0]).toMatchObject({
      recipient: { email: expect.stringContaining("owner-succeeded-"), name: "Succeeded Owner" },
      planLabel: "paid plan",
      amountLabel: "$25.00",
      nextBillingDate: "15 October 2026",
    });

    const replay = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ received: true, duplicate: true });
    expect(email.succeeded).toHaveLength(1);

    await app.close();
  });

  it("sends payment-failed with the persisted grace-period end date", async () => {
    const workspaceId = randomUUID();
    await seedOwner(workspaceId, `owner-failed-${randomUUID()}@example.test`, "Failed Owner");
    const email = recordingTransactionalEmail();
    const app = await buildApp(email);

    const webhookId = `wh_failed_${randomUUID()}`;
    const subscriptionId = `sub_test_${randomUUID()}`;
    webhookIds.push(webhookId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      dodoSubscriptionId: subscriptionId,
      productId: "pdt_test_monthly",
      status: "active",
      providerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "payment.failed",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: subscriptionId,
        product_id: "pdt_test_monthly",
        customer: { customer_id: `cus_test_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
        metadata: { workspaceId },
      },
    });
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature(body, webhookId, timestamp),
    };

    const response = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(email.failed).toHaveLength(1);

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription?.status).toBe("on_hold");
    const expectedGraceEndsAt = longDate(new Date(subscription!.updatedAt.getTime() + 7 * 86_400_000));
    expect(email.failed[0]).toMatchObject({
      recipient: { email: expect.stringContaining("owner-failed-"), name: "Failed Owner" },
      planLabel: "paid plan",
      graceEndsAt: expectedGraceEndsAt,
    });

    await app.close();
  });

  it("sends no email when the transactional email service is disabled", async () => {
    const workspaceId = randomUUID();
    await seedOwner(workspaceId, `owner-disabled-${randomUUID()}@example.test`, "Disabled Owner");
    const calls: unknown[] = [];
    const spyDisabled: TransactionalEmailService = {
      ...disabledTransactionalEmailService,
      async sendPaymentSucceeded(input) {
        calls.push(input);
      },
      async sendPaymentFailed(input) {
        calls.push(input);
      },
    };
    const app = await buildApp(spyDisabled);

    const webhookId = `wh_disabled_${randomUUID()}`;
    webhookIds.push(webhookId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "subscription.active",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: `sub_test_${randomUUID()}`,
        product_id: "pdt_test_monthly",
        status: "active",
        next_billing_date: "2026-10-01T00:00:00.000Z",
        cancel_at_next_billing_date: false,
        currency: "USD",
        recurring_pre_tax_amount: 1000,
        customer: { customer_id: `cus_test_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
        metadata: { workspaceId },
      },
    });
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature(body, webhookId, timestamp),
    };

    const response = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });
    expect(calls).toHaveLength(0);

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription?.status).toBe("active");

    await app.close();
  });

  it("still returns success when email sending throws", async () => {
    const workspaceId = randomUUID();
    await seedOwner(workspaceId, `owner-throws-${randomUUID()}@example.test`, "Throws Owner");
    const throwingEmail: TransactionalEmailService = {
      ...disabledTransactionalEmailService,
      enabled: true,
      async sendWelcome() {},
      async sendPasswordReset() {},
      async sendSequenceTest() {},
      async sendTrialEnding() {},
      async sendPaymentSucceeded() {
        throw new Error("Azure Communication Services Email send ended with status Failed.");
      },
      async sendPaymentFailed() {
        throw new Error("Azure Communication Services Email send ended with status Failed.");
      },
      async sendMailboxAlert() {},
      async sendCampaignCompleted() {},
      async sendReplyReceived() {},
    };
    const app = await buildApp(throwingEmail);

    const webhookId = `wh_throws_${randomUUID()}`;
    webhookIds.push(webhookId);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      business_id: "bus_test",
      type: "subscription.active",
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: `sub_test_${randomUUID()}`,
        product_id: "pdt_test_monthly",
        status: "active",
        next_billing_date: "2026-10-01T00:00:00.000Z",
        cancel_at_next_billing_date: false,
        currency: "USD",
        recurring_pre_tax_amount: 1500,
        customer: { customer_id: `cus_test_${randomUUID()}`, email: "owner@example.com", name: "Owner" },
        metadata: { workspaceId },
      },
    });
    const headers = {
      "content-type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature(body, webhookId, timestamp),
    };

    const response = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", headers, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: false });

    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription?.status).toBe("active");

    await app.close();
  });
});
