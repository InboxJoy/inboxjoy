import { loadAppEnv } from "@inboxjoy/config";
import { attributeReferral, listAffiliatePayoutsDue, operations, runOperation } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService } from "@inboxjoy/email";
import { eq, inArray } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerBillingRoutes } from "../src/modules/billing/index.js";

const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = "affiliate-commission-webhook-test-secret";
const webhookKey = `whsec_${Buffer.from(webhookSecret).toString("base64")}`;

function signature(body: string, webhookId: string, timestamp: string): string {
  return `v1,${createHmac("sha256", webhookSecret).update(`${webhookId}.${timestamp}.${body}`).digest("base64")}`;
}

describe.skipIf(!databaseUrl)("Dodo billing webhook — affiliate commissions", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "affiliate-commission-webhook-auth-secret-at-least-32-chars",
    DODO_PAYMENTS_WEBHOOK_KEY: webhookKey,
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  });
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const webhookIds: string[] = [];
  // affiliate_refunded_payments has no workspace FK (it has to survive the
  // commission/referral rows it marks), so it needs its own cleanup.
  const paymentIds: string[] = [];
  let app: FastifyInstance;

  const affiliateGetOp = operations.find((operation) => operation.name === "affiliate.get");
  if (!affiliateGetOp) throw new Error('"affiliate.get" was not found in the @inboxjoy/core operations registry.');

  async function createWorkspaceWithOwner(prefix: string): Promise<{ workspaceId: string; userId: string }> {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const email = `${prefix}-${randomUUID()}@example.com`;
    userIds.push(userId);
    workspaceIds.push(workspaceId);
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email.toLowerCase() });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: `${prefix} workspace`,
      slug: `${prefix}-${randomUUID().slice(0, 8)}`,
      createdByUserId: userId,
    });
    await db.insert(schema.memberships).values({
      id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date(),
    });
    return { workspaceId, userId };
  }

  async function affiliateCode(workspaceId: string, userId: string): Promise<string> {
    const result = await runOperation(affiliateGetOp!, {
      db,
      workspaceId,
      userId,
      env: { edition: "selfhost", authSecret: env.AUTH_SECRET ?? "", apiBaseUrl: env.API_BASE_URL },
    }, {});
    const code = (result as { code?: unknown }).code;
    if (typeof code !== "string" || !code) throw new Error(`"affiliate.get" did not return a usable code: ${JSON.stringify(result)}`);
    return code;
  }

  async function payoutsDueFor(workspaceId: string): Promise<{ dueCents: number; commissionCount: number; currency: string } | undefined> {
    // Look past the 30-day hold so a just-recorded commission counts as due.
    const rows = await listAffiliatePayoutsDue(db, new Date(Date.now() + 31 * 86_400_000));
    return rows.find((row) => row.workspaceId === workspaceId);
  }

  async function sendWebhook(payload: Record<string, unknown>): Promise<void> {
    const webhookId = `wh_affiliate_${randomUUID()}`;
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
    expect(response.json()).toMatchObject({ received: true });
  }

  beforeAll(async () => {
    app = Fastify();
    await app.register(rawBody, { global: false, encoding: "utf8" });
    registerBillingRoutes(app, env, { db, runOperation: async () => ({}), transactionalEmail: disabledTransactionalEmailService });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const webhookId of webhookIds) {
      await db.delete(schema.processedWebhookEvents).where(eq(schema.processedWebhookEvents.webhookId, webhookId));
    }
    if (paymentIds.length) {
      await db.delete(schema.affiliateRefundedPayments).where(inArray(schema.affiliateRefundedPayments.dodoPaymentId, paymentIds));
    }
    if (workspaceIds.length) {
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
    }
    if (userIds.length) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await pool.end();
  });

  it("records exactly one commission when payment.succeeded is replayed with a different webhook-id but the same payment id, and refund.succeeded reverses it", async () => {
    const affiliate = await createWorkspaceWithOwner("affiliate-commission");
    const referred = await createWorkspaceWithOwner("affiliate-referred");
    const code = await affiliateCode(affiliate.workspaceId, affiliate.userId);

    const attribution = await attributeReferral(db, { code, referredWorkspaceId: referred.workspaceId });
    expect(attribution).toBe("attributed");

    const paymentId = `pay_${randomUUID()}`;
    paymentIds.push(paymentId);
    const paymentPayload = {
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        settlement_amount: 10_000,
        settlement_tax: 500,
        settlement_currency: "usd",
        total_amount: 10_000,
        tax: 500,
        currency: "usd",
        metadata: { workspaceId: referred.workspaceId },
      },
    };

    await sendWebhook(paymentPayload);
    const dueAfterFirst = await payoutsDueFor(affiliate.workspaceId);
    expect(dueAfterFirst, "expected a payout due row for the affiliate after the first payment.succeeded").toBeDefined();
    expect(dueAfterFirst!.commissionCount).toBe(1);

    // Same payment_id, different webhook-id -- recordAffiliateCommission's own
    // idempotency (keyed by dodoPaymentId) must prevent a second commission,
    // independent of the webhook-level processedWebhookEvents dedup.
    await sendWebhook(paymentPayload);
    const dueAfterReplay = await payoutsDueFor(affiliate.workspaceId);
    expect(dueAfterReplay, "expected the payout due row to still exist after the replay").toBeDefined();
    expect(dueAfterReplay!.commissionCount).toBe(1);
    expect(dueAfterReplay!.dueCents).toBe(dueAfterFirst!.dueCents);

    await sendWebhook({
      type: "refund.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        refund_id: `refund_${randomUUID()}`,
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        status: "succeeded",
        metadata: {},
      },
    });

    const dueAfterRefund = await payoutsDueFor(affiliate.workspaceId);
    expect(dueAfterRefund === undefined || dueAfterRefund.commissionCount === 0).toBe(true);

    // The in-order flow (payment, then refund) must also leave a refund marker
    // behind, the same as the out-of-order flow does -- it is what makes a
    // replayed or re-ordered pair of webhooks idempotent either way.
    const marker = await db.select().from(schema.affiliateRefundedPayments).where(eq(schema.affiliateRefundedPayments.dodoPaymentId, paymentId));
    expect(marker).toHaveLength(1);
  });

  it("reverses the commission up front when refund.succeeded arrives before payment.succeeded for the same payment id", async () => {
    const affiliate = await createWorkspaceWithOwner("affiliate-out-of-order");
    const referred = await createWorkspaceWithOwner("affiliate-out-of-order-referred");
    const code = await affiliateCode(affiliate.workspaceId, affiliate.userId);
    await attributeReferral(db, { code, referredWorkspaceId: referred.workspaceId });

    const paymentId = `pay_${randomUUID()}`;
    paymentIds.push(paymentId);

    await sendWebhook({
      type: "refund.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        refund_id: `refund_${randomUUID()}`,
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        status: "succeeded",
        metadata: {},
      },
    });

    await sendWebhook({
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        settlement_amount: 6_000,
        settlement_tax: 0,
        settlement_currency: "usd",
        total_amount: 6_000,
        tax: 0,
        currency: "usd",
        metadata: { workspaceId: referred.workspaceId },
      },
    });

    const rows = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, paymentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("reversed");

    // Never payable, even looking well past the 30-day hold.
    const dueAfterHold = await payoutsDueFor(affiliate.workspaceId);
    expect(dueAfterHold === undefined || dueAfterHold.commissionCount === 0).toBe(true);
  });

  it("leaves an already-paid commission untouched when its refund arrives late, and still returns 200", async () => {
    const affiliate = await createWorkspaceWithOwner("affiliate-already-paid");
    const referred = await createWorkspaceWithOwner("affiliate-already-paid-referred");
    const code = await affiliateCode(affiliate.workspaceId, affiliate.userId);
    await attributeReferral(db, { code, referredWorkspaceId: referred.workspaceId });

    const paymentId = `pay_${randomUUID()}`;
    paymentIds.push(paymentId);

    await sendWebhook({
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        settlement_amount: 7_500,
        settlement_tax: 0,
        settlement_currency: "usd",
        total_amount: 7_500,
        tax: 0,
        currency: "usd",
        metadata: { workspaceId: referred.workspaceId },
      },
    });

    // Simulate the commission having already been paid out (the admin CLI's
    // mark-paid path) before the refund webhook shows up.
    await db.update(schema.affiliateCommissions).set({ status: "paid", paidAt: new Date() }).where(eq(schema.affiliateCommissions.dodoPaymentId, paymentId));

    // sendWebhook itself asserts a 200 + { received: true } response.
    await sendWebhook({
      type: "refund.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        refund_id: `refund_${randomUUID()}`,
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        status: "succeeded",
        metadata: {},
      },
    });

    const [row] = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, paymentId));
    expect(row?.status).toBe("paid");
  });

  it("is idempotent when refund.succeeded is replayed with a different webhook-id for the same payment id", async () => {
    const affiliate = await createWorkspaceWithOwner("affiliate-refund-replay");
    const referred = await createWorkspaceWithOwner("affiliate-refund-replay-referred");
    const code = await affiliateCode(affiliate.workspaceId, affiliate.userId);
    await attributeReferral(db, { code, referredWorkspaceId: referred.workspaceId });

    const paymentId = `pay_${randomUUID()}`;
    paymentIds.push(paymentId);

    await sendWebhook({
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        settlement_amount: 4_200,
        settlement_tax: 0,
        settlement_currency: "usd",
        total_amount: 4_200,
        tax: 0,
        currency: "usd",
        metadata: { workspaceId: referred.workspaceId },
      },
    });

    const refundPayload = {
      type: "refund.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        refund_id: `refund_${randomUUID()}`,
        payment_id: paymentId,
        created_at: new Date().toISOString(),
        status: "succeeded",
        metadata: {},
      },
    };

    // Each sendWebhook call mints its own webhook-id, so this replays the
    // refund under a different webhook-id but the same payment_id.
    await sendWebhook(refundPayload);
    await sendWebhook(refundPayload);

    const rows = await db.select().from(schema.affiliateCommissions).where(eq(schema.affiliateCommissions.dodoPaymentId, paymentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("reversed");

    const markers = await db.select().from(schema.affiliateRefundedPayments).where(eq(schema.affiliateRefundedPayments.dodoPaymentId, paymentId));
    expect(markers).toHaveLength(1);
  });

  it("records nothing for a payment from a workspace that was never referred", async () => {
    const nonReferred = await createWorkspaceWithOwner("affiliate-non-referred");
    const dueBefore = await listAffiliatePayoutsDue(db);

    await sendWebhook({
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        payment_id: `pay_${randomUUID()}`,
        created_at: new Date().toISOString(),
        settlement_amount: 5_000,
        settlement_tax: 250,
        settlement_currency: "usd",
        total_amount: 5_000,
        tax: 250,
        currency: "usd",
        metadata: { workspaceId: nonReferred.workspaceId },
      },
    });

    const dueAfter = await listAffiliatePayoutsDue(db);
    expect(dueAfter).toEqual(dueBefore);
  });
});
