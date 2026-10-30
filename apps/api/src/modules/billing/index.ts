import { resolveEdition, type AppEnv } from "@inboxjoy/config";
import { dodoSubscriptionUpsertWhere, grantLifetimeLicense, isLifetimePayment, recordAffiliateCommission, revokeLifetimeLicense, reverseAffiliateCommission, upsertDodoSubscription, type BillingClient } from "@inboxjoy/core";
import { schema, type InboxJoyDb } from "@inboxjoy/db";
import type { TransactionalEmailRecipient, TransactionalEmailService } from "@inboxjoy/email";
import DodoPayments from "dodopayments";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { transactionalEmailFromEnv } from "../../auth.js";

type BillingModuleOptions = {
  db?: InboxJoyDb;
  client?: BillingClient;
  runOperation: (name: string, request: FastifyRequest, input: unknown) => Promise<unknown>;
  transactionalEmail?: TransactionalEmailService;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function providerEventTime(eventType: string, payload: Record<string, unknown>, subscriptionData: Record<string, unknown>, signatureTimestamp: string): Date {
  if (eventType.startsWith("payment.")) {
    return dateValue(payload.timestamp) ?? new Date(Number(signatureTimestamp) * 1000);
  }
  const subscriptionTimestamp = dateValue(subscriptionData.updated_at) ?? dateValue(subscriptionData.modified_at);
  if (subscriptionTimestamp) return subscriptionTimestamp;
  const envelopeTimestamp = dateValue(payload.timestamp);
  if (envelopeTimestamp) return envelopeTimestamp;
  return new Date(Number(signatureTimestamp) * 1000);
}

function signatureValues(header: string): string[] {
  return header.split(/\s+/).flatMap((value) => {
    const [version, signature] = value.split(",", 2);
    if (version === "v1" && signature) return [signature];
    return value && !value.includes(",") ? [value] : [];
  });
}

function manualWebhookValid(rawBody: string, webhookId: string, timestamp: string, signatureHeader: string, secret: string): boolean {
  const timestampSeconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) return false;
  const secretBytes = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret);
  const expected = Buffer.from(createHmac("sha256", secretBytes).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64"));
  return signatureValues(signatureHeader).some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Pre-tax amount in minor units for an affiliate commission. Prefers the
// settlement amount/currency (relevant for adaptive pricing, where the
// customer's payment currency can differ from the merchant's settlement
// currency) minus settlement tax; falls back to the raw total amount minus
// tax in the payment's own currency when settlement fields are absent.
// See dodopayments Payment type (settlement_amount/settlement_tax/
// settlement_currency vs. total_amount/tax/currency).
function preTaxPaymentAmount(data: Record<string, unknown>): { amountCents: number; currency: string } | null {
  const settlementAmount = numberValue(data.settlement_amount);
  const settlementCurrency = stringValue(data.settlement_currency);
  if (settlementAmount !== null && settlementCurrency) {
    const settlementTax = numberValue(data.settlement_tax) ?? 0;
    return { amountCents: Math.round(settlementAmount - settlementTax), currency: settlementCurrency.toUpperCase() };
  }

  const totalAmount = numberValue(data.total_amount);
  const currency = stringValue(data.currency);
  if (totalAmount !== null && currency) {
    const tax = numberValue(data.tax) ?? 0;
    return { amountCents: Math.round(totalAmount - tax), currency: currency.toUpperCase() };
  }

  return null;
}

function trialEnd(data: Record<string, unknown>): Date | null {
  const explicit = dateValue(data.trial_end) ?? dateValue(data.trial_end_date);
  if (explicit) return explicit;
  const createdAt = dateValue(data.created_at);
  const days = typeof data.trial_period_days === "number" ? data.trial_period_days : 0;
  return createdAt && days > 0 ? new Date(createdAt.getTime() + days * 86_400_000) : null;
}

// Mirrors the billing settings UI (apps/web/app/app/(product)/settings/billing/page.tsx),
// which labels the lifetime product "Lifetime license". The lifetime license is
// the only product on sale; anything else gets a neutral label.
function planLabelForProduct(productId: string | null | undefined, env: AppEnv): string {
  if (env.DODO_PRODUCT_LIFETIME && productId === env.DODO_PRODUCT_LIFETIME) return "Lifetime license";
  return "paid plan";
}

// Formats a minor-unit amount (e.g. cents) using the webhook payload's own currency.
// Returns undefined when the payload doesn't carry a reliable amount, so callers can
// skip sending rather than inventing a figure.
function formatAmountLabel(amount: unknown, currency: unknown): string | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return undefined;
  if (typeof currency !== "string" || !currency.trim()) return undefined;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
  } catch {
    return undefined;
  }
}

// e.g. "15 September 2026" — matches the format requested for billing emails.
function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

async function findWorkspaceOwner(db: InboxJoyDb, workspaceId: string): Promise<TransactionalEmailRecipient | undefined> {
  const [owner] = await db.select({ email: schema.users.email, name: schema.users.displayName })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(and(
      eq(schema.memberships.workspaceId, workspaceId),
      eq(schema.memberships.role, "owner"),
      eq(schema.memberships.status, "active"),
    ))
    .limit(1);
  return owner;
}

export function createDodoBillingClient(env: AppEnv): BillingClient | undefined {
  if (!env.DODO_PAYMENTS_API_KEY && !env.DODO_PAYMENTS_WEBHOOK_KEY) return undefined;
  const client = new DodoPayments({
    bearerToken: env.DODO_PAYMENTS_API_KEY ?? "webhook-verification-only",
    webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY,
    environment: env.DODO_PAYMENTS_ENVIRONMENT,
  });

  return {
    createCheckoutSession: (input, options) => client.checkoutSessions.create(input, options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined),
    createCustomerPortal: (customerId) => client.customers.customerPortal.create(customerId, {}),
    retrieveSubscription: (subscriptionId) => client.subscriptions.retrieve(subscriptionId),
    listSubscriptions: async (input) => {
      const customerIds: string[] = [];
      if (input.customerId) {
        customerIds.push(input.customerId);
      } else if (input.customerEmail) {
        for await (const customer of client.customers.list({ email: input.customerEmail, page_size: 100 })) {
          if (customer.email.toLowerCase() === input.customerEmail.toLowerCase()) customerIds.push(customer.customer_id);
        }
      }

      const subscriptions: unknown[] = [];
      for (const customerId of customerIds) {
        for await (const subscription of client.subscriptions.list({ customer_id: customerId, page_size: 100 })) {
          subscriptions.push(subscription);
        }
      }
      return subscriptions;
    },
    listPayments: async (input) => {
      const customerIds: string[] = [];
      if (input.customerId) {
        customerIds.push(input.customerId);
      } else if (input.customerEmail) {
        for await (const customer of client.customers.list({ email: input.customerEmail, page_size: 100 })) {
          if (customer.email.toLowerCase() === input.customerEmail.toLowerCase()) customerIds.push(customer.customer_id);
        }
      }

      const payments: unknown[] = [];
      for (const customerId of customerIds) {
        for await (const payment of client.payments.list({ customer_id: customerId, product_id: input.productId, status: "succeeded", page_size: 100 })) {
          payments.push(payment);
        }
      }
      return payments;
    },
    retrievePayment: (paymentId) => client.payments.retrieve(paymentId),
    updateSubscription: (subscriptionId, input) => client.subscriptions.update(subscriptionId, input),
    unwrapWebhook: (rawBody, headers) => client.webhooks.unwrap(rawBody, { headers }),
  };
}

export function registerBillingRoutes(app: FastifyInstance, env: AppEnv, options: BillingModuleOptions): void {
  const transactionalEmail = options.transactionalEmail ?? transactionalEmailFromEnv(env);

  // Both editions read the plan (self-host reports tier "selfhost").
  app.get("/v1/billing", async (request) => options.runOperation("billing.get", request, {}));

  // Self-host has no Dodo: checkout, portal, cancel, reconcile and the Dodo
  // webhook are not registered there and answer 404.
  if (resolveEdition(env) !== "cloud") return;

  app.post<{ Body: { productKey?: unknown } }>("/v1/billing/checkout", async (request, reply) => {
    if (request.workspaceRole !== "owner") return reply.code(403).send({ error: "Only workspace owners can change billing." });
    // First-party analytics cookie set by the Piqo tracker; validated in the operation.
    const piqoVisitorId = request.headers.cookie?.match(/(?:^|;\s*)piqo_visitor=([^;]*)/)?.[1];
    return options.runOperation("billing.checkoutStart", request, { productKey: request.body?.productKey, piqoVisitorId });
  });

  app.post("/v1/billing/reconcile", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (request.workspaceRole !== "owner") return reply.code(403).send({ error: "Only workspace owners can change billing." });
    return options.runOperation("billing.reconcile", request, {});
  });

  app.post("/v1/billing/portal", async (request, reply) => {
    if (request.workspaceRole !== "owner") return reply.code(403).send({ error: "Only workspace owners can change billing." });
    return options.runOperation("billing.portalLink", request, {});
  });

  app.post<{ Body: { atPeriodEnd?: unknown } }>("/v1/billing/cancel", async (request, reply) => {
    if (request.workspaceRole !== "owner") return reply.code(403).send({ error: "Only workspace owners can change billing." });
    return options.runOperation("billing.cancel", request, { atPeriodEnd: request.body?.atPeriodEnd });
  });

  app.post<{
    Headers: { "webhook-signature"?: string; "webhook-timestamp"?: string; "webhook-id"?: string };
    Body: unknown;
  }>("/v1/webhooks/dodo", { config: { rawBody: true } }, async (request, reply) => {
    if (!env.DODO_PAYMENTS_WEBHOOK_KEY) return reply.code(503).send({ error: "Webhook integration is disabled." });
    if (!options.db) return reply.code(503).send({ error: "Webhook storage is unavailable." });

    const rawBody = typeof request.rawBody === "string" ? request.rawBody : request.rawBody?.toString("utf8");
    const webhookId = request.headers["webhook-id"];
    const timestamp = request.headers["webhook-timestamp"];
    const signature = request.headers["webhook-signature"];
    if (!rawBody || !webhookId || !timestamp || !signature) return reply.code(401).send({ error: "Invalid webhook signature." });

    let payload: Record<string, unknown>;
    try {
      if (options.client?.unwrapWebhook) {
        payload = record(options.client.unwrapWebhook(rawBody, {
          "webhook-id": webhookId,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
        }));
      } else {
        if (!manualWebhookValid(rawBody, webhookId, timestamp, signature, env.DODO_PAYMENTS_WEBHOOK_KEY)) {
          return reply.code(401).send({ error: "Invalid webhook signature." });
        }
        payload = record(JSON.parse(rawBody));
      }
    } catch {
      return reply.code(401).send({ error: "Invalid webhook signature." });
    }

    const eventType = stringValue(payload.type) ?? "unknown";
    const data = record(payload.data);
    const subscriptionData = record(data.subscription ?? data);
    const metadata = record(subscriptionData.metadata ?? data.metadata ?? payload.metadata);
    const dodoSubscriptionId = stringValue(subscriptionData.subscription_id);
    const providerUpdatedAt = providerEventTime(eventType, payload, subscriptionData, timestamp);
    let workspaceId = stringValue(metadata.workspaceId) ?? stringValue(metadata.workspace_id);
    if (!workspaceId && dodoSubscriptionId) {
      const [existing] = await options.db.select({ workspaceId: schema.subscriptions.workspaceId }).from(schema.subscriptions).where(eq(schema.subscriptions.dodoSubscriptionId, dodoSubscriptionId)).limit(1);
      workspaceId = existing?.workspaceId;
    }

    // A one-time payment's cart decides whether it bought the lifetime license.
    // If the webhook omits it, read the payment back from Dodo before the
    // transaction rather than holding it open on a network call.
    let lifetimePayment: Record<string, unknown> | undefined;
    if (eventType === "payment.succeeded" && env.DODO_PRODUCT_LIFETIME && workspaceId && !dodoSubscriptionId) {
      let payment = data;
      const paymentId = stringValue(data.payment_id);
      if (!Array.isArray(data.product_cart) && paymentId && options.client?.retrievePayment) {
        try {
          payment = record(await options.client.retrievePayment(paymentId));
        } catch (error) {
          request.log.error({ err: error, webhookId, eventType, paymentId }, "Failed to read Dodo payment for lifetime license check");
          return reply.code(503).send({ error: "Payment lookup is unavailable." });
        }
      }
      if (isLifetimePayment(payment, env.DODO_PRODUCT_LIFETIME)) lifetimePayment = payment;
    }

    let duplicate = false;
    let pendingPaymentSucceeded: { workspaceId: string; productId: string | null; amountLabel: string; nextBillingDate: Date | null } | undefined;
    let pendingPaymentFailed: { workspaceId: string; productId: string | null; graceEndsAt: Date } | undefined;

    await options.db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.processedWebhookEvents).values({ id: randomUUID(), webhookId, type: eventType }).onConflictDoNothing({ target: schema.processedWebhookEvents.webhookId }).returning({ webhookId: schema.processedWebhookEvents.webhookId });
      if (!created) {
        duplicate = true;
        return;
      }

      if (eventType === "payment.succeeded") {
        request.log.info({ eventType, webhookId }, "Dodo payment webhook received");

        if (lifetimePayment && workspaceId && env.DODO_PRODUCT_LIFETIME) {
          const [workspaceExists] = await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
          if (!workspaceExists) {
            request.log.warn({ eventType, webhookId, workspaceId }, "Dodo lifetime payment references a workspace that was deleted; skipping license grant");
          } else {
            const { granted, dodoPaymentId } = await grantLifetimeLicense(tx, { workspaceId, productId: env.DODO_PRODUCT_LIFETIME, payment: lifetimePayment });
            request.log.info({ eventType, webhookId, workspaceId, dodoPaymentId, granted }, "Dodo lifetime license payment processed");
            if (granted) {
              await tx.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
              const amountLabel = formatAmountLabel(lifetimePayment.total_amount, lifetimePayment.currency);
              if (amountLabel) pendingPaymentSucceeded = { workspaceId, productId: env.DODO_PRODUCT_LIFETIME, amountLabel, nextBillingDate: null };
            }
          }
        }

        // Affiliate commissions never gate or alter the existing subscription
        // bookkeeping above (there is none for payment.succeeded today) --
        // this is purely additive and failures here must not affect the
        // webhook's idempotent-success response.
        if (workspaceId) {
          const dodoPaymentId = stringValue(data.payment_id);
          const amount = preTaxPaymentAmount(data);
          const paidAt = dateValue(data.created_at) ?? providerUpdatedAt;
          if (dodoPaymentId && amount) {
            try {
              const commissionResult = await recordAffiliateCommission(tx, {
                referredWorkspaceId: workspaceId,
                dodoPaymentId,
                amountCents: amount.amountCents,
                currency: amount.currency,
                paidAt,
              });
              request.log.info({ eventType, webhookId, workspaceId, commissionResult }, "Dodo payment webhook: affiliate commission processed");
            } catch (error) {
              request.log.error({ err: error, webhookId, eventType, workspaceId }, "Failed to record affiliate commission");
            }
          } else {
            request.log.info({ eventType, webhookId, workspaceId, hasPaymentId: Boolean(dodoPaymentId), hasAmount: Boolean(amount) }, "Dodo payment webhook is missing fields needed for an affiliate commission; skipping");
          }
        }
        return;
      }

      if (eventType === "refund.succeeded") {
        request.log.info({ eventType, webhookId }, "Dodo refund webhook received");
        const refundedPaymentId = stringValue(data.payment_id);
        // A full refund ends a lifetime license; a partial one (a goodwill credit) keeps it.
        if (refundedPaymentId && data.is_partial !== true) {
          const revokedWorkspaceId = await revokeLifetimeLicense(tx, { dodoPaymentId: refundedPaymentId });
          if (revokedWorkspaceId) request.log.info({ eventType, webhookId, refundedPaymentId, workspaceId: revokedWorkspaceId }, "Lifetime license revoked after full refund");
        }
        if (refundedPaymentId) {
          try {
            const reversal = await reverseAffiliateCommission(tx, { dodoPaymentId: refundedPaymentId });
            request.log.info({ eventType, webhookId, refundedPaymentId, reversed: reversal.reversed }, "Dodo refund webhook: affiliate commission reversal processed");
            if (reversal.alreadyPaid) {
              // The affiliate was already paid out on this commission before the
              // refund arrived. Nothing here can claw that back automatically --
              // flag it loudly so someone follows up manually. Never notify the
              // affiliate's own workspace about this.
              request.log.error({
                eventType,
                webhookId,
                refundedPaymentId,
                commissionId: reversal.alreadyPaid.commissionId,
                commissionCents: reversal.alreadyPaid.commissionCents,
                currency: reversal.alreadyPaid.currency,
                affiliateWorkspaceId: reversal.alreadyPaid.affiliateWorkspaceId,
              }, "Refund received for an affiliate commission that was already paid out; manual clawback needed");
            }
          } catch (error) {
            request.log.error({ err: error, webhookId, eventType, refundedPaymentId }, "Failed to reverse affiliate commission");
          }
        }
        return;
      }

      if (eventType === "dispute.lost") {
        const disputedPaymentId = stringValue(data.payment_id);
        if (disputedPaymentId) {
          const revokedWorkspaceId = await revokeLifetimeLicense(tx, { dodoPaymentId: disputedPaymentId });
          request.log.info({ eventType, webhookId, disputedPaymentId, workspaceId: revokedWorkspaceId ?? null }, "Dodo lost-dispute webhook processed");
        }
        return;
      }

      if (eventType === "payment.failed") {
        request.log.info({ eventType, webhookId }, "Dodo payment webhook received");
        if (!workspaceId || !dodoSubscriptionId) {
          request.log.warn({ eventType, webhookId, workspaceId, dodoSubscriptionId }, "Dodo payment webhook is missing its workspace join metadata");
          return;
        }

        const [workspaceExists] = await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
        if (!workspaceExists) {
          request.log.warn({ eventType, webhookId, workspaceId, dodoSubscriptionId }, "Dodo webhook references a workspace that was deleted; skipping subscription write");
          return;
        }

        const customer = record(subscriptionData.customer);
        const now = new Date();
        const payloadCancelAtPeriodEnd = typeof subscriptionData.cancel_at_next_billing_date === "boolean"
          ? subscriptionData.cancel_at_next_billing_date
          : null;
        const values = {
          id: randomUUID(),
          workspaceId,
          dodoCustomerId: stringValue(customer.customer_id) ?? null,
          dodoSubscriptionId,
          productId: stringValue(subscriptionData.product_id) ?? null,
          status: "failed",
          nextBillingDate: dateValue(subscriptionData.next_billing_date),
          trialEnd: trialEnd(subscriptionData),
          cancelAtPeriodEnd: payloadCancelAtPeriodEnd ?? false,
          metadata: subscriptionData,
          providerUpdatedAt,
          updatedAt: now,
        };
        const [persisted] = await tx.insert(schema.subscriptions).values(values).onConflictDoUpdate({
          target: schema.subscriptions.workspaceId,
          set: {
            dodoCustomerId: sql`COALESCE(excluded.dodo_customer_id, ${schema.subscriptions.dodoCustomerId})`,
            dodoSubscriptionId: values.dodoSubscriptionId,
            productId: sql`COALESCE(excluded.product_id, ${schema.subscriptions.productId})`,
            status: sql`CASE WHEN ${schema.subscriptions.status} IN ('active', 'on_hold') THEN 'on_hold' ELSE 'failed' END`,
            nextBillingDate: sql`COALESCE(excluded.next_billing_date, ${schema.subscriptions.nextBillingDate})`,
            trialEnd: sql`COALESCE(excluded.trial_end, ${schema.subscriptions.trialEnd})`,
            cancelAtPeriodEnd: sql`COALESCE(${payloadCancelAtPeriodEnd}, ${schema.subscriptions.cancelAtPeriodEnd})`,
            metadata: values.metadata,
            providerUpdatedAt: values.providerUpdatedAt,
            updatedAt: sql`CASE WHEN ${schema.subscriptions.status} = 'on_hold' THEN ${schema.subscriptions.updatedAt} ELSE ${values.updatedAt} END`,
          },
          where: dodoSubscriptionUpsertWhere(),
        }).returning({ productId: schema.subscriptions.productId, status: schema.subscriptions.status, updatedAt: schema.subscriptions.updatedAt });

        if (!persisted) {
          const [stored] = await tx.select({ providerUpdatedAt: schema.subscriptions.providerUpdatedAt }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId)).limit(1);
          request.log.info({ eventType, webhookId, workspaceId, storedTimestamp: stored?.providerUpdatedAt?.toISOString() ?? null, incomingTimestamp: providerUpdatedAt.toISOString() }, "Dropped stale Dodo subscription webhook");
        }

        // The grace period always runs from when the subscription first went on hold
        // (the CASE above keeps the original updatedAt across repeated failures), so
        // this reads back whatever was actually persisted rather than recomputing it.
        if (persisted?.status === "on_hold") {
          pendingPaymentFailed = {
            workspaceId,
            productId: persisted.productId,
            graceEndsAt: new Date(persisted.updatedAt.getTime() + 7 * 86_400_000),
          };
        }
        return;
      }

      const subscriptionEvents = new Set([
        "subscription.active",
        "subscription.renewed",
        "subscription.on_hold",
        "subscription.failed",
        "subscription.plan_changed",
        "subscription.cancelled",
        "subscription.expired",
        "subscription.paused",
        "subscription.unpaused",
        "subscription.updated",
      ]);
      if (!subscriptionEvents.has(eventType)) return;
      if (!workspaceId || !dodoSubscriptionId) {
        request.log.warn({ eventType, webhookId, workspaceId, dodoSubscriptionId }, "Dodo subscription webhook is missing its workspace join metadata");
        return;
      }

      const [workspaceExists] = await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
      if (!workspaceExists) {
        request.log.warn({ eventType, webhookId, workspaceId, dodoSubscriptionId }, "Dodo webhook references a workspace that was deleted; skipping subscription write");
        return;
      }

      const persisted = await upsertDodoSubscription(tx, workspaceId, subscriptionData, { eventType, providerUpdatedAt });

      if (!persisted.persisted) {
        const [stored] = await tx.select({ providerUpdatedAt: schema.subscriptions.providerUpdatedAt }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId)).limit(1);
        request.log.info({ eventType, webhookId, workspaceId, storedTimestamp: stored?.providerUpdatedAt?.toISOString() ?? null, incomingTimestamp: providerUpdatedAt.toISOString() }, "Dropped stale Dodo subscription webhook");
      }

      if (persisted.persisted && (persisted.status === "active" || persisted.status === "trialing")) {
        await tx.delete(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
      }

      if (persisted.persisted && persisted.status === "active") {
        const amountLabel = formatAmountLabel(subscriptionData.recurring_pre_tax_amount, subscriptionData.currency);
        // No reliable amount on the payload — skip the email rather than guessing a figure.
        if (amountLabel) {
          pendingPaymentSucceeded = { workspaceId, productId: persisted.productId, amountLabel, nextBillingDate: persisted.nextBillingDate };
        }
      }
    });

    if (!duplicate) request.log.info({ eventType, workspaceId: workspaceId ?? null }, "Dodo webhook processed");

    if (!duplicate && transactionalEmail.enabled) {
      if (pendingPaymentSucceeded) {
        const succeeded = pendingPaymentSucceeded;
        try {
          const owner = await findWorkspaceOwner(options.db, succeeded.workspaceId);
          if (owner) {
            await transactionalEmail.sendPaymentSucceeded({
              recipient: owner,
              planLabel: planLabelForProduct(succeeded.productId, env),
              amountLabel: succeeded.amountLabel,
              ...(succeeded.nextBillingDate ? { nextBillingDate: formatLongDate(succeeded.nextBillingDate) } : {}),
            });
          }
        } catch (error) {
          request.log.error({ err: error, webhookId, eventType }, "Failed to send Dodo payment-succeeded email");
        }
      }

      if (pendingPaymentFailed) {
        const failed = pendingPaymentFailed;
        try {
          const owner = await findWorkspaceOwner(options.db, failed.workspaceId);
          if (owner) {
            await transactionalEmail.sendPaymentFailed({
              recipient: owner,
              planLabel: planLabelForProduct(failed.productId, env),
              graceEndsAt: formatLongDate(failed.graceEndsAt),
            });
          }
        } catch (error) {
          request.log.error({ err: error, webhookId, eventType }, "Failed to send Dodo payment-failed email");
        }
      }
    }

    return { received: true, duplicate };
  });
}
