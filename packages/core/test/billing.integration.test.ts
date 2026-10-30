import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FREE_PLAN_CONTACT_LIMIT, FREE_PLAN_MONTHLY_SEND_LIMIT, operationByName, runOperation, ZodError, type BillingClient, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
// Dodo subscription products (the retired Monthly/Yearly plans) still exercise
// the dormant subscription webhook and reconcile paths.
const subscriptionProductId = "pdt_test_subscription";
const otherSubscriptionProductId = "pdt_test_subscription_other";
const lifetimeProductId = "pdt_test_lifetime";

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe("billing configuration guard", () => {
  it("returns a clean reconcile result and guards provider-dependent billing operations when the API key is unset", async () => {
    const context = {
      db: {
        // One row serves both lookups: the membership role and a lapsed subscription.
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ role: "owner", status: "cancelled", updatedAt: new Date() }] }) }) }),
        // The free plan's monthly send count.
        execute: async () => ({ rows: [{ sends: "0" }] }),
      } as unknown as OperationContext["db"],
      workspaceId: randomUUID(),
      userId: randomUUID(),
      env: {
        edition: "cloud",
        authSecret: "billing-test-auth-secret-at-least-32-characters",
        apiBaseUrl: "https://api.example.test",
        webBaseUrl: "https://app.example.test",
        dodoPaymentsApiKey: undefined,
        dodoProductLifetime: lifetimeProductId,
      },
      billing: {
        createCheckoutSession: async () => ({}),
        createCustomerPortal: async () => ({}),
        retrieveSubscription: async () => ({}),
        listSubscriptions: async () => [],
        updateSubscription: async () => ({}),
      } satisfies BillingClient,
    } satisfies OperationContext;
    const inputs: Record<string, unknown> = {
      "billing.checkoutStart": { productKey: "lifetime" },
      "billing.portalLink": {},
      "billing.cancel": { atPeriodEnd: true },
    };

    for (const [name, input] of Object.entries(inputs)) {
      await expect(runOperation(operation(name), context, input)).rejects.toMatchObject({ code: "billing_unconfigured" });
    }

    // Unconfigured cloud billing still reports the real plan: a lapsed
    // subscription with no legacy Free window needs the license.
    await expect(runOperation(operation("billing.get"), context, {})).resolves.toMatchObject({ tier: "none", edition: "cloud", status: "cancelled", configured: false, sendingEnabled: false, needsLicense: true, legacyFreeEndsAt: null, freePlan: false, monthlySendLimit: null, canManage: true });
    await expect(runOperation(operation("billing.reconcile"), context, {})).resolves.toEqual({
      tier: "none",
      edition: "cloud",
      status: "cancelled",
      nextBillingDate: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      configured: false,
      hasCustomer: false,
      sendingEnabled: false,
      canManage: true,
      needsLicense: true,
      legacyFreeEndsAt: null,
      freePlan: false,
      monthlySendLimit: null,
      sendsThisMonth: 0,
      monthlyResetsAt: expect.any(String),
      reconciled: false,
    });
  });
});

// A database stand-in for billing.get: one select row serves both the
// membership role and the subscription, execute serves the month count and
// the legacy Free window.
function planContext(input: { edition: "cloud" | "selfhost"; subscription?: Record<string, unknown> | null; sends?: number; legacyFreeUntil?: Date | null }) {
  const row = { role: "owner", ...(input.subscription === null ? {} : { status: "cancelled", updatedAt: new Date(), ...input.subscription }) };
  let selects = 0;
  return {
    db: {
      // First select is the membership role, the second the subscription row.
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (selects++ === 0 || input.subscription !== null ? [row] : []) }) }) }),
      execute: async () => ({ rows: [{ sends: String(input.sends ?? 0), legacy_free_until: input.legacyFreeUntil?.toISOString() ?? null }] }),
    } as unknown as OperationContext["db"],
    workspaceId: randomUUID(),
    userId: randomUUID(),
    env: { edition: input.edition, authSecret: "billing-test-auth-secret-at-least-32-characters", apiBaseUrl: "https://api.example.test" },
  } satisfies OperationContext;
}

describe("billing.get plan states", () => {
  const future = new Date(Date.now() + 10 * 86_400_000);

  it("reports self-host as always entitled with nothing to buy", async () => {
    const context = planContext({ edition: "selfhost", subscription: null, sends: FREE_PLAN_MONTHLY_SEND_LIMIT * 3 });
    await expect(runOperation(operation("billing.get"), context, {})).resolves.toMatchObject({
      tier: "selfhost", edition: "selfhost", configured: false, hasCustomer: false, sendingEnabled: true,
      needsLicense: false, legacyFreeEndsAt: null, freePlan: false, monthlySendLimit: null, canManage: true,
    });
  });

  it.each(["billing.checkoutStart", "billing.portalLink", "billing.cancel", "billing.reconcile"])("refuses %s in self-host with not_available", async (name) => {
    const context = { ...planContext({ edition: "selfhost" }), billing: { createCheckoutSession: async () => ({}), createCustomerPortal: async () => ({}), retrieveSubscription: async () => ({}), listSubscriptions: async () => [], updateSubscription: async () => ({}) } };
    const input = name === "billing.checkoutStart" ? { productKey: "lifetime" } : name === "billing.cancel" ? { atPeriodEnd: true } : {};
    await expect(runOperation(operation(name), { ...context, env: { ...context.env, dodoPaymentsApiKey: "dodo_test_key", dodoProductLifetime: lifetimeProductId, webBaseUrl: "https://app.example.test" } }, input)).rejects.toMatchObject({ code: "not_available" });
  });

  it("reports a new cloud workspace as needing the license", async () => {
    const context = planContext({ edition: "cloud", subscription: null });
    await expect(runOperation(operation("billing.get"), context, {})).resolves.toMatchObject({
      tier: "none", edition: "cloud", status: "none", sendingEnabled: false, needsLicense: true, legacyFreeEndsAt: null, freePlan: false, monthlySendLimit: null,
    });
  });

  it("reports legacy Free with its cap and end date, and stops sending at the cap", async () => {
    const underCap = planContext({ edition: "cloud", subscription: null, sends: FREE_PLAN_MONTHLY_SEND_LIMIT - 1, legacyFreeUntil: future });
    await expect(runOperation(operation("billing.get"), underCap, {})).resolves.toMatchObject({
      tier: "free", status: "free", sendingEnabled: true, needsLicense: true, legacyFreeEndsAt: future.toISOString(),
      freePlan: true, monthlySendLimit: FREE_PLAN_MONTHLY_SEND_LIMIT, sendsThisMonth: FREE_PLAN_MONTHLY_SEND_LIMIT - 1,
    });
    const atCap = planContext({ edition: "cloud", subscription: null, sends: FREE_PLAN_MONTHLY_SEND_LIMIT, legacyFreeUntil: future });
    await expect(runOperation(operation("billing.get"), atCap, {})).resolves.toMatchObject({ tier: "free", sendingEnabled: false, needsLicense: true });
  });

  it("reports an ended legacy Free window as needing the license, keeping the date", async () => {
    const ended = new Date(Date.now() - 86_400_000);
    const context = planContext({ edition: "cloud", subscription: null, legacyFreeUntil: ended });
    await expect(runOperation(operation("billing.get"), context, {})).resolves.toMatchObject({ tier: "none", sendingEnabled: false, needsLicense: true, legacyFreeEndsAt: ended.toISOString(), freePlan: false });
  });

  it.each([
    ["lifetime", { status: "active", metadata: { lifetime: true } }],
    ["comp", { status: "active", metadata: { comp: true } }],
  ])("reports a %s workspace as entitled with no cap, even inside a legacy window", async (tier, subscription) => {
    const context = planContext({ edition: "cloud", subscription, sends: FREE_PLAN_MONTHLY_SEND_LIMIT * 2, legacyFreeUntil: future });
    await expect(runOperation(operation("billing.get"), context, {})).resolves.toMatchObject({
      tier, sendingEnabled: true, needsLicense: false, legacyFreeEndsAt: null, freePlan: false, monthlySendLimit: null,
    });
  });

  // Migration 0042 stamps every existing workspace, so one entitled only for
  // now reports nothing to buy while entitled and falls back to legacy Free,
  // not straight to needing the license, when that lapses inside the window.
  it.each([
    ["a trial", { status: "trialing", trialEnd: new Date(Date.now() + 86_400_000) }, { status: "trialing", trialEnd: new Date(Date.now() - 60_000) }],
    ["on_hold in its grace", { status: "on_hold", updatedAt: new Date(Date.now() - 86_400_000) }, { status: "on_hold", updatedAt: new Date(Date.now() - 8 * 86_400_000) }],
    ["an expiring comp", { status: "active", metadata: { comp: true } }, { status: "expired", metadata: { comp: true } }],
  ])("reports %s inside a legacy window as entitled, then as legacy Free once it lapses", async (_label, entitled, lapsed) => {
    await expect(runOperation(operation("billing.get"), planContext({ edition: "cloud", subscription: entitled, legacyFreeUntil: future }), {})).resolves.toMatchObject({
      tier: "comp", sendingEnabled: true, needsLicense: false, legacyFreeEndsAt: null, freePlan: false,
    });
    await expect(runOperation(operation("billing.get"), planContext({ edition: "cloud", subscription: lapsed, legacyFreeUntil: future }), {})).resolves.toMatchObject({
      tier: "free", sendingEnabled: true, needsLicense: true, legacyFreeEndsAt: future.toISOString(), freePlan: true,
    });
  });
});

describe("billing checkout input", () => {
  it.each(["monthly", "yearly"])("rejects the retired %s product key before any billing work", async (productKey) => {
    let checkoutCalls = 0;
    const context = {
      // Input validation runs before the handler, so the database is never touched.
      db: {} as OperationContext["db"],
      workspaceId: randomUUID(),
      userId: randomUUID(),
      env: {
        edition: "cloud",
        authSecret: "billing-test-auth-secret-at-least-32-characters",
        apiBaseUrl: "https://api.example.test",
        webBaseUrl: "https://app.example.test",
        dodoPaymentsApiKey: "dodo_test_key",
        dodoProductLifetime: lifetimeProductId,
      },
      billing: {
        createCheckoutSession: async () => { checkoutCalls += 1; return {}; },
        createCustomerPortal: async () => ({}),
        retrieveSubscription: async () => ({}),
        listSubscriptions: async () => [],
        updateSubscription: async () => ({}),
      } satisfies BillingClient,
    } satisfies OperationContext;

    // runOperation surfaces the ZodError; the API maps it to BAD_INPUT (HTTP 400).
    const error = await runOperation(operation("billing.checkoutStart"), context, { productKey }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues).toEqual([expect.objectContaining({ code: "invalid_value", path: ["productKey"] })]);
    expect(checkoutCalls).toBe(0);
  });
});

describe.skipIf(!databaseUrl)("billing core operations", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let userId = "";
  let memberUserId = "";
  let workspaceId = "";
  let ownerEmail = "";

  const billingClient: BillingClient = {
    createCheckoutSession: async () => ({ checkout_url: "https://test.checkout.dodopayments.com/session/cks_test" }),
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

  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    userId = randomUUID();
    workspaceId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    ownerEmail = `billing-${suffix}@example.com`;
    await db.insert(schema.authUsers).values({
      id: userId,
      name: "Billing Test",
      email: ownerEmail,
      emailVerified: true,
    });
    await db.insert(schema.users).values({
      id: userId,
      email: ownerEmail,
      normalizedEmail: ownerEmail,
      displayName: "Billing Test",
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: `Billing ${suffix}`,
      slug: `billing-${suffix}`,
      createdByUserId: userId,
      postalAddress: "123 Main St\nAustin, TX 78701",
    });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
  });

  afterEach(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (memberUserId) await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (userId) await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
    memberUserId = "";
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns a checkout URL and includes the workspace id in checkout metadata", async () => {
    let checkoutInput: Parameters<BillingClient["createCheckoutSession"]>[0] | undefined;
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (input) => {
        checkoutInput = input;
        return { session_id: "cks_test", checkout_url: "https://test.checkout.dodopayments.com/session/cks_test" };
      },
    };

    const result = await runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" });

    expect(result).toEqual({ checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_test" });
    expect(checkoutInput?.metadata).toEqual({ workspaceId });
    expect(checkoutInput?.subscription_data).toBeUndefined();
    expect(checkoutInput?.return_url).toBe("https://app.example.test/app?billing=success");
    expect(checkoutInput?.cancel_url).toBe("https://app.example.test/app?checkout=cancelled");
  });

  it("forwards a valid Piqo visitor id in checkout metadata and keys the request on it", async () => {
    const calls: Array<{ metadata: unknown; key: string | undefined }> = [];
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (input, options) => {
        calls.push({ metadata: input.metadata, key: options?.idempotencyKey });
        return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_attributed" };
      },
    };

    const result = await runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime", piqoVisitorId: "0123456789abcdef" });

    expect(result).toEqual({ checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_attributed" });
    const [intent] = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(calls).toEqual([{ metadata: { workspaceId, piqo_visitor_id: "0123456789abcdef" }, key: `${intent!.idempotencyKey}:0123456789abcdef` }]);
    expect(intent).toMatchObject({ checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_attributed" });
  });

  it.each(["", "not-a-visitor-id", "0123456789ABCDEF", "0123456789abcdef0", "0123456789abcde\n"])("drops the malformed Piqo visitor id %j and still starts checkout", async (piqoVisitorId) => {
    const calls: Array<{ metadata: unknown; key: string | undefined }> = [];
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (input, options) => {
        calls.push({ metadata: input.metadata, key: options?.idempotencyKey });
        return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_unattributed" };
      },
    };

    const result = await runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime", piqoVisitorId });

    expect(result).toEqual({ checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_unattributed" });
    const [intent] = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(calls).toEqual([{ metadata: { workspaceId }, key: intent!.idempotencyKey }]);
  });

  it("reuses one persisted checkout intent across concurrent requests", async () => {
    const keys: string[] = [];
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (_input, options) => {
        keys.push(options?.idempotencyKey ?? "missing");
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_deduped" };
      },
    };

    const results = await Promise.all([
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" }),
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" }),
    ]);

    expect(results).toEqual([
      { checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_deduped" },
      { checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_deduped" },
    ]);
    expect(new Set(keys).size).toBe(1);
    const [intent] = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intent).toMatchObject({ productKey: "lifetime", checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_deduped" });
  });

  it("hands every concurrent checkout call the same URL even when two browsers supply different piqoVisitorId values", async () => {
    // Different visitor ids legitimately produce different idempotency keys (the visitor id
    // is part of the Dodo request body), so each browser creates its own session here. The
    // bug this guards: first-writer-wins must still persist and return just one of them.
    const urlByKey = new Map<string, string>();
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (_input, options) => {
        const key = options?.idempotencyKey ?? "missing";
        await new Promise((resolve) => setTimeout(resolve, 25));
        const url = `https://test.checkout.dodopayments.com/session/${key}`;
        urlByKey.set(key, url);
        return { checkout_url: url };
      },
    };

    const results = await Promise.all([
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime", piqoVisitorId: "0123456789abcdef" }),
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime", piqoVisitorId: "fedcba9876543210" }),
    ]);

    expect(urlByKey.size).toBe(2);
    expect(results[0]).toEqual(results[1]);
    expect([...urlByKey.values()]).toContain(results[0]!.checkoutUrl);
    const [intent] = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intent?.checkoutUrl).toBe(results[0]!.checkoutUrl);
  });

  it("returns the cached checkout URL for a repeated product", async () => {
    let checkoutCalls = 0;
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async () => {
        checkoutCalls += 1;
        return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_cached" };
      },
    };

    const first = await runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" });
    const second = await runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" });

    expect(first).toEqual({ checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_cached" });
    expect(second).toEqual(first);
    expect(checkoutCalls).toBe(1);
  });

  it("replaces a legacy monthly checkout intent when a lifetime checkout is requested", async () => {
    // Intents created before the lifetime license still say "monthly" or "yearly".
    // Even an unexpired one must not be reused for a lifetime request.
    const legacyKey = `billing-checkout:${randomUUID()}`;
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "monthly",
      idempotencyKey: legacyKey,
      checkoutUrl: `https://test.checkout.dodopayments.com/session/${subscriptionProductId}`,
      expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    });
    const keys: string[] = [];
    let reconciliations = 0;
    const checkoutStartedAt = Date.now();
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async (input) => {
        reconciliations += 1;
        expect(input).toEqual({ customerEmail: ownerEmail });
        return [];
      },
      createCheckoutSession: async (input, options) => {
        keys.push(options?.idempotencyKey ?? "missing");
        const productId = input.product_cart[0]?.product_id;
        return { checkout_url: `https://test.checkout.dodopayments.com/session/${productId}` };
      },
    };

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" })).resolves.toEqual({
      checkoutUrl: `https://test.checkout.dodopayments.com/session/${lifetimeProductId}`,
    });

    expect(reconciliations).toBe(1);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(legacyKey);
    const intents = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ productKey: "lifetime", idempotencyKey: keys[0], checkoutUrl: `https://test.checkout.dodopayments.com/session/${lifetimeProductId}` });
    expect(intents[0]!.expiresAt.getTime()).toBeGreaterThanOrEqual(checkoutStartedAt + 30 * 60 * 1000);
    expect(intents[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
  });

  it("rejects a lifetime checkout and persists a legacy monthly subscription the provider reports as live", async () => {
    const subscriptionId = `sub_switch_${randomUUID()}`;
    let checkoutCalls = 0;
    // A monthly checkout started before the lifetime license completed at the
    // provider, but its webhook has not arrived.
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "monthly",
      idempotencyKey: `billing-checkout:${randomUUID()}`,
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_monthly",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    });
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async (input) => {
        expect(input).toEqual({ customerEmail: ownerEmail });
        return [{
          subscription_id: subscriptionId, product_id: subscriptionProductId, status: "active",
          updated_at: "2026-09-20T00:00:00.000Z", created_at: "2026-09-19T00:00:00.000Z",
          customer: { customer_id: `cus_switch_${randomUUID()}`, email: ownerEmail }, metadata: { workspaceId },
        }];
      },
      createCheckoutSession: async () => { checkoutCalls += 1; return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_lifetime" }; },
    };

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This workspace already has a plan. Change it from the billing portal.",
    });

    expect(checkoutCalls).toBe(0);
    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ dodoSubscriptionId: subscriptionId, status: "active", productId: subscriptionProductId });
    expect(await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("issues a fresh checkout intent for the same plan after the TTL", async () => {
    const oldIdempotencyKey = `billing-checkout:${randomUUID()}`;
    const createdAt = new Date(Date.now() - 31 * 60 * 1000);
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "lifetime",
      idempotencyKey: oldIdempotencyKey,
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_stale",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
    });
    let reconciliations = 0;
    let replacementKey: string | undefined;
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async () => { reconciliations += 1; return []; },
      createCheckoutSession: async (_input, options) => {
        replacementKey = options?.idempotencyKey;
        return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_fresh" };
      },
    };

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" })).resolves.toEqual({
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_fresh",
    });

    expect(reconciliations).toBe(1);
    expect(replacementKey).toBeDefined();
    expect(replacementKey).not.toBe(oldIdempotencyKey);
    const intents = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ productKey: "lifetime", idempotencyKey: replacementKey, checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_fresh" });
    expect(intents[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("issues one fresh checkout session for concurrent same-plan requests after the TTL", async () => {
    const oldIdempotencyKey = `billing-checkout:${randomUUID()}`;
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "lifetime",
      idempotencyKey: oldIdempotencyKey,
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_stale",
      expiresAt: new Date(Date.now() - 1_000),
    });
    const keys: string[] = [];
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (_input, options) => {
        keys.push(options?.idempotencyKey ?? "missing");
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { checkout_url: `https://test.checkout.dodopayments.com/session/${options?.idempotencyKey}` };
      },
    };

    const [first, second] = await Promise.all([
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" }),
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" }),
    ]);

    expect(second).toEqual(first);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBe(oldIdempotencyKey);
    const intents = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ productKey: "lifetime", idempotencyKey: keys[0], checkoutUrl: `https://test.checkout.dodopayments.com/session/${keys[0]}` });
  });

  it("replaces a legacy checkout intent exactly once when lifetime checkouts race", async () => {
    // Only the lifetime license is sold now, so the cross-plan race left is
    // concurrent lifetime requests replacing an unexpired legacy intent.
    const urlFor = (productId: string | undefined) => `https://test.checkout.dodopayments.com/session/${productId}`;
    const legacyKey = `billing-checkout:${randomUUID()}`;
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "yearly",
      idempotencyKey: legacyKey,
      checkoutUrl: urlFor(otherSubscriptionProductId),
      expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    });
    const keys: string[] = [];
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (input, options) => {
        keys.push(options?.idempotencyKey ?? "missing");
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { checkout_url: urlFor(input.product_cart[0]?.product_id) };
      },
    };

    const results = await Promise.all([
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" }),
      runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" }),
    ]);

    expect(results).toEqual([{ checkoutUrl: urlFor(lifetimeProductId) }, { checkoutUrl: urlFor(lifetimeProductId) }]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBe(legacyKey);
    const intents = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    // The surviving intent carries the lifetime session, never the legacy plan's.
    expect(intents[0]).toMatchObject({ productKey: "lifetime", idempotencyKey: keys[0], checkoutUrl: urlFor(lifetimeProductId) });
  });

  it("does not let a stale legacy checkout intent row block a lifetime checkout", async () => {
    // Abandoned monthly rows like this already exist in production; no cleanup may be needed.
    const staleKey = `billing-checkout:${randomUUID()}`;
    const createdAt = new Date(Date.now() - 3 * 86_400_000);
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "monthly",
      idempotencyKey: staleKey,
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_abandoned",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
    });
    const keys: string[] = [];
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (input, options) => {
        keys.push(options?.idempotencyKey ?? "missing");
        return { checkout_url: `https://test.checkout.dodopayments.com/session/${input.product_cart[0]?.product_id}/${keys.length}` };
      },
    };

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" })).resolves.toEqual({
      checkoutUrl: `https://test.checkout.dodopayments.com/session/${lifetimeProductId}/1`,
    });
    // The replacement is an ordinary lifetime intent: a repeat request reuses it.
    await expect(runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" })).resolves.toEqual({
      checkoutUrl: `https://test.checkout.dodopayments.com/session/${lifetimeProductId}/1`,
    });

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(staleKey);
    const intents = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ productKey: "lifetime", idempotencyKey: keys[0], checkoutUrl: `https://test.checkout.dodopayments.com/session/${lifetimeProductId}/1` });
  });

  it("does not overwrite a fresh intent created while expired-intent reconciliation is in flight", async () => {
    const oldIdempotencyKey = `billing-checkout:${randomUUID()}`;
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId,
      productKey: "yearly",
      idempotencyKey: oldIdempotencyKey,
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_old",
      expiresAt: new Date(Date.now() - 1_000),
    });
    let reconciliationStarted!: () => void;
    let finishReconciliation!: () => void;
    const started = new Promise<void>((resolve) => { reconciliationStarted = resolve; });
    const waitForReconciliation = new Promise<void>((resolve) => { finishReconciliation = resolve; });
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async () => {
        reconciliationStarted();
        await waitForReconciliation;
        return [];
      },
      createCheckoutSession: async () => { throw new Error("must reuse the fresh intent"); },
    };

    const result = runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" });
    await started;
    const freshKey = `billing-checkout:${randomUUID()}`;
    const freshUrl = "https://test.checkout.dodopayments.com/session/cks_fresh";
    await db.update(schema.billingCheckoutIntents).set({
      productKey: "lifetime",
      idempotencyKey: freshKey,
      checkoutUrl: freshUrl,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    finishReconciliation();

    await expect(result).resolves.toEqual({ checkoutUrl: freshUrl });
    const [intent] = await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId));
    expect(intent).toMatchObject({ productKey: "lifetime", idempotencyKey: freshKey, checkoutUrl: freshUrl });
  });

  it("reconciles an expired checkout intent before starting a replacement", async () => {
    const oldSubscriptionId = "sub_expired_intent_" + randomUUID();
    const newSubscriptionId = "sub_completed_intent_" + randomUUID();
    const customerId = "cus_intent_" + randomUUID();
    await db.insert(schema.subscriptions).values({
      id: randomUUID(), workspaceId, dodoCustomerId: customerId,
      dodoSubscriptionId: oldSubscriptionId, productId: subscriptionProductId,
      status: "cancelled", providerUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await db.insert(schema.billingCheckoutIntents).values({
      workspaceId, productKey: "monthly", idempotencyKey: "billing-checkout:" + randomUUID(),
      checkoutUrl: "https://test.checkout.dodopayments.com/session/cks_expired",
      expiresAt: new Date(Date.now() - 1_000),
    });
    let checkoutCalls = 0;
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async (input) => {
        expect(input).toEqual({ customerId });
        return [{
          subscription_id: newSubscriptionId, product_id: otherSubscriptionProductId, status: "active",
          updated_at: "2026-09-20T00:00:00.000Z", created_at: "2026-09-19T00:00:00.000Z",
          customer: { customer_id: customerId }, metadata: { workspaceId },
        }];
      },
      createCheckoutSession: async () => { checkoutCalls += 1; return { checkout_url: "https://test.checkout.dodopayments.com/session/should-not-exist" }; },
    };

    await expect(runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(checkoutCalls).toBe(0);
    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ dodoSubscriptionId: newSubscriptionId, status: "active", productId: otherSubscriptionProductId });
    expect(await db.select().from(schema.billingCheckoutIntents).where(eq(schema.billingCheckoutIntents.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("starts lifetime checkout without a trial", async () => {
    let checkoutInput: Parameters<BillingClient["createCheckoutSession"]>[0] | undefined;
    const billing: BillingClient = {
      ...billingClient,
      createCheckoutSession: async (input) => {
        checkoutInput = input;
        return { checkout_url: "https://test.checkout.dodopayments.com/session/cks_lifetime" };
      },
    };

    await runOperation(operation("billing.checkoutStart"), context({ billing }), { productKey: "lifetime" });

    expect(checkoutInput?.product_cart).toEqual([{ product_id: lifetimeProductId, quantity: 1 }]);
    expect(checkoutInput?.subscription_data).toBeUndefined();
  });

  it.each(["active", "trialing", "on_hold", "paused"] as const)("rejects a second checkout for an existing %s subscription", async (status) => {
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      productId: subscriptionProductId,
      status,
    });

    await expect(runOperation(operation("billing.checkoutStart"), context(), { productKey: "lifetime" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This workspace already has a plan. Change it from the billing portal.",
    });
  });

  it("reports a billing customer for cancelled subscriptions", async () => {
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      productId: subscriptionProductId,
      status: "cancelled",
      dodoCustomerId: `cus_${randomUUID()}`,
    });

    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "none", needsLicense: true, hasCustomer: true });
  });

  it("reconciles a first provider subscription found through the owner's email", async () => {
    const subscriptionId = `sub_reconcile_${randomUUID()}`;
    let listInput: Parameters<BillingClient["listSubscriptions"]>[0] | undefined;
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async (input) => {
        listInput = input;
        return [{
          subscription_id: subscriptionId,
          product_id: subscriptionProductId,
          status: "active",
          created_at: "2026-09-18T10:00:00.000Z",
          previous_billing_date: "2026-09-18T10:05:00.000Z",
          next_billing_date: "2026-10-18T10:05:00.000Z",
          trial_period_days: 0,
          cancel_at_next_billing_date: false,
          customer: { customer_id: `cus_reconcile_${randomUUID()}`, email: ownerEmail },
          metadata: { workspaceId },
        }];
      },
    };

    await expect(runOperation(operation("billing.reconcile"), context({ billing }), {})).resolves.toMatchObject({
      tier: "comp",
      status: "active",
      configured: true,
      hasCustomer: true,
      reconciled: true,
    });
    expect(listInput).toEqual({ customerEmail: ownerEmail });
    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({
      dodoSubscriptionId: subscriptionId,
      productId: subscriptionProductId,
      status: "active",
      providerUpdatedAt: new Date("2026-09-18T10:05:00.000Z"),
    });
  });

  it("keeps an active row when retrieved provider truth is older", async () => {
    const subscriptionId = `sub_stale_${randomUUID()}`;
    const storedProviderTime = new Date("2026-09-18T12:00:00.000Z");
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      dodoCustomerId: `cus_stale_${randomUUID()}`,
      dodoSubscriptionId: subscriptionId,
      productId: subscriptionProductId,
      status: "active",
      providerUpdatedAt: storedProviderTime,
    });
    const billing: BillingClient = {
      ...billingClient,
      retrieveSubscription: async (requestedId) => {
        expect(requestedId).toBe(subscriptionId);
        return {
          subscription_id: subscriptionId,
          product_id: otherSubscriptionProductId,
          status: "cancelled",
          updated_at: "2026-09-18T11:00:00.000Z",
          created_at: "2026-09-01T00:00:00.000Z",
          cancelled_at: "2026-09-18T11:00:00.000Z",
          cancel_at_next_billing_date: true,
          customer: { customer_id: `cus_retrieved_${randomUUID()}` },
          metadata: { workspaceId },
        };
      },
    };

    await expect(runOperation(operation("billing.reconcile"), context({ billing }), {})).resolves.toMatchObject({
      tier: "comp",
      status: "active",
      reconciled: false,
    });
    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ status: "active", productId: subscriptionProductId, providerUpdatedAt: storedProviderTime });
  });

  it("discovers a replacement subscription when the stored subscription is terminal", async () => {
    const oldSubscriptionId = "sub_terminal_" + randomUUID();
    const newSubscriptionId = "sub_replacement_" + randomUUID();
    const customerId = "cus_terminal_" + randomUUID();
    await db.insert(schema.subscriptions).values({
      id: randomUUID(), workspaceId, dodoCustomerId: customerId,
      dodoSubscriptionId: oldSubscriptionId, productId: subscriptionProductId,
      status: "expired", providerUpdatedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    const billing: BillingClient = {
      ...billingClient,
      retrieveSubscription: async () => { throw new Error("terminal subscription should be searched by customer"); },
      listSubscriptions: async (input) => {
        expect(input).toEqual({ customerId });
        return [{
          subscription_id: newSubscriptionId, product_id: otherSubscriptionProductId, status: "active",
          updated_at: "2026-09-20T00:00:00.000Z", created_at: "2026-09-19T00:00:00.000Z",
          customer: { customer_id: customerId }, metadata: { workspaceId },
        }];
      },
    };

    await expect(runOperation(operation("billing.reconcile"), context({ billing }), {})).resolves.toMatchObject({ tier: "comp", status: "active", reconciled: true });
    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription).toMatchObject({ dodoSubscriptionId: newSubscriptionId, status: "active" });
  });

  it("does not reconcile a different workspace subscription from a shared customer listing", async () => {
    const storedSubscriptionId = "sub_owned_" + randomUUID();
    const sharedCustomerId = "cus_shared_" + randomUUID();
    await db.insert(schema.subscriptions).values({
      id: randomUUID(), workspaceId, dodoCustomerId: sharedCustomerId,
      dodoSubscriptionId: storedSubscriptionId, productId: subscriptionProductId,
      status: "expired", providerUpdatedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async () => [{
        subscription_id: "sub_other_workspace_" + randomUUID(),
        product_id: otherSubscriptionProductId,
        status: "active",
        updated_at: "2026-09-20T00:00:00.000Z",
        customer: { customer_id: sharedCustomerId },
        metadata: { workspaceId: randomUUID() },
      }],
    };

    await expect(runOperation(operation("billing.reconcile"), context({ billing }), {})).resolves.toMatchObject({ status: "expired", reconciled: false });
    const [subscription] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, workspaceId));
    expect(subscription?.dodoSubscriptionId).toBe(storedSubscriptionId);
  });

  it("returns the current unlicensed state when no provider subscription is found", async () => {
    const billing: BillingClient = {
      ...billingClient,
      listSubscriptions: async () => [],
    };

    await expect(runOperation(operation("billing.reconcile"), context({ billing }), {})).resolves.toEqual({
      tier: "none",
      edition: "cloud",
      status: "none",
      nextBillingDate: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      configured: true,
      hasCustomer: false,
      sendingEnabled: false,
      canManage: true,
      needsLicense: true,
      legacyFreeEndsAt: null,
      freePlan: false,
      monthlySendLimit: null,
      sendsThisMonth: 0,
      monthlyResetsAt: expect.any(String),
      reconciled: false,
    });
  });

  it("rejects billing cancellation from a member-role OAuth operation context", async () => {
    memberUserId = randomUUID();
    const email = `billing-member-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.users).values({ id: memberUserId, email, normalizedEmail: email, displayName: "Billing Member" });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId: memberUserId, role: "member", status: "active", joinedAt: new Date() });

    await expect(runOperation(operation("billing.cancel"), context({ userId: memberUserId }), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports paid access as comp unless it is a lifetime license", async () => {
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      productId: "pdt_unknown",
      status: "active",
    });

    // Neither a lifetime license nor a comp: still paid, reported as comp, with a warning.
    const warn = vi.fn();
    await expect(runOperation(operation("billing.get"), context({ logger: { info: vi.fn(), warn } }), {})).resolves.toMatchObject({ tier: "comp", status: "active" });
    expect(warn).toHaveBeenCalledWith({ productId: "pdt_unknown" }, expect.stringContaining("comp"));

    warn.mockClear();
    await db.update(schema.subscriptions).set({ productId: null, metadata: { comp: true }, updatedAt: new Date() }).where(eq(schema.subscriptions.workspaceId, workspaceId));
    await expect(runOperation(operation("billing.get"), context({ logger: { info: vi.fn(), warn } }), {})).resolves.toMatchObject({ tier: "comp", status: "active" });
    expect(warn).not.toHaveBeenCalled();

    await db.update(schema.subscriptions).set({ productId: lifetimeProductId, metadata: { lifetime: true, dodoPaymentId: "pay_tier_test" }, updatedAt: new Date() }).where(eq(schema.subscriptions.workspaceId, workspaceId));
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "lifetime", status: "active" });
  });

  it("returns the subscription trial end", async () => {
    const trialEnd = new Date("2026-09-15T12:00:00.000Z");
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      productId: subscriptionProductId,
      status: "active",
      trialEnd,
    });

    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ trialEnd: trialEnd.toISOString() });
  });

  it("expires paid access seven days after a subscription enters on-hold", async () => {
    await db.insert(schema.subscriptions).values({
      id: randomUUID(),
      workspaceId,
      productId: subscriptionProductId,
      status: "on_hold",
      updatedAt: new Date(Date.now() - 8 * 86_400_000),
    });

    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({ tier: "none", status: "on_hold", needsLicense: true, freePlan: false, sendingEnabled: false });
  });

  // tier, needsLicense and sendingEnabled must match canSend()'s sendingPlan for
  // every state; with no sends yet this month legacy Free can still send.
  it.each([
    ["no subscription", null, false],
    ["comp grant with no product", { productId: null, status: "active" }, true],
    ["active paid", { productId: subscriptionProductId, status: "active" }, true],
    ["trialing before trial end", { productId: subscriptionProductId, status: "trialing", trialEnd: new Date(Date.now() + 3 * 86_400_000) }, true],
    ["trialing after trial end", { productId: subscriptionProductId, status: "trialing", trialEnd: new Date(Date.now() - 60_000) }, false],
    ["on_hold within grace", { productId: subscriptionProductId, status: "on_hold", updatedAt: new Date(Date.now() - 2 * 86_400_000) }, true],
    ["on_hold past grace", { productId: subscriptionProductId, status: "on_hold", updatedAt: new Date(Date.now() - 8 * 86_400_000) }, false],
    ["cancelled", { productId: subscriptionProductId, status: "cancelled" }, false],
    ["refunded lifetime license", { productId: lifetimeProductId, status: "refunded", metadata: { lifetime: true, dodoPaymentId: "pay_refunded" } }, false],
    ["pending checkout", { productId: subscriptionProductId, status: "pending" }, false],
  ] as const)("reports the plan for %s, without and with a legacy Free window", async (_label, row, entitled) => {
    if (row) await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId, ...row });

    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({
      tier: entitled ? "comp" : "none",
      edition: "cloud",
      configured: true,
      sendingEnabled: entitled,
      needsLicense: !entitled,
      legacyFreeEndsAt: null,
      freePlan: false,
      monthlySendLimit: null,
      sendsThisMonth: 0,
      canManage: true,
    });

    const legacyFreeUntil = new Date(Date.now() + 20 * 86_400_000);
    await db.update(schema.workspaces).set({ legacyFreeUntil }).where(eq(schema.workspaces.id, workspaceId));
    await expect(runOperation(operation("billing.get"), context(), {})).resolves.toMatchObject({
      tier: entitled ? "comp" : "free",
      sendingEnabled: true,
      needsLicense: !entitled,
      legacyFreeEndsAt: entitled ? null : legacyFreeUntil.toISOString(),
      freePlan: !entitled,
      monthlySendLimit: entitled ? null : FREE_PLAN_MONTHLY_SEND_LIMIT,
    });
  });

  it("reports a self-hosted workspace as entitled whatever its rows say", async () => {
    await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId, productId: subscriptionProductId, status: "cancelled", dodoCustomerId: `cus_${randomUUID()}` });
    const selfhost = context({ env: { ...context().env, edition: "selfhost" } });
    await expect(runOperation(operation("billing.get"), selfhost, {})).resolves.toMatchObject({
      tier: "selfhost", edition: "selfhost", configured: false, hasCustomer: false, sendingEnabled: true, needsLicense: false, freePlan: false, monthlySendLimit: null,
    });
    await expect(runOperation(operation("billing.reconcile"), selfhost, {})).rejects.toMatchObject({ code: "not_available" });
  });

  it("tells members they cannot manage billing", async () => {
    memberUserId = randomUUID();
    const email = `billing-viewer-${randomUUID().slice(0, 8)}@example.com`;
    await db.insert(schema.users).values({ id: memberUserId, email, normalizedEmail: email, displayName: "Billing Viewer" });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId: memberUserId, role: "member", status: "active", joinedAt: new Date() });

    await expect(runOperation(operation("billing.get"), context({ userId: memberUserId }), {})).resolves.toMatchObject({ needsLicense: true, canManage: false });
  });

  it("enforces the contact cap for legacy Free only, at the exact boundary", async () => {
    const sequenceId = randomUUID();
    const versionId = randomUUID();
    const stepId = randomUUID();
    const mailboxId = randomUUID();
    const contactIds = Array.from({ length: FREE_PLAN_CONTACT_LIMIT + 2 }, () => randomUUID());

    const senderEmail = `sender-${randomUUID()}@example.com`;
    await db.insert(schema.emailAccounts).values({
      id: mailboxId,
      workspaceId,
      userId,
      provider: "gmail",
      composioConnectedAccountId: `billing-${randomUUID()}`,
      email: senderEmail,
      normalizedEmail: senderEmail,
      alias: `billing-${randomUUID().slice(0, 8)}`,
      status: "active",
    });
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId, name: "Billing gate", status: "active", createdByUserId: userId });
    await db.insert(schema.sequenceVersions).values({ id: versionId, workspaceId, sequenceId, version: 1, status: "active", snapshot: { description: "Billing gate" }, createdByUserId: userId });
    await db.update(schema.sequences).set({ currentVersionId: versionId }).where(eq(schema.sequences.id, sequenceId));
    await db.insert(schema.sequenceSteps).values({ id: stepId, workspaceId, sequenceVersionId: versionId, stepOrder: 1, subject: "Hello", bodyText: "Hello" });
    await db.insert(schema.contacts).values(contactIds.map((contactId, index) => ({
      id: contactId,
      workspaceId,
      email: `billing-contact-${index}-${workspaceId}@example.com`,
      normalizedEmail: `billing-contact-${index}-${workspaceId}@example.com`,
      status: "active",
    })));
    await db.insert(schema.enrollments).values(contactIds.slice(0, FREE_PLAN_CONTACT_LIMIT - 1).map((contactId) => ({
      id: randomUUID(),
      workspaceId,
      contactId,
      sequenceId,
      sequenceVersionId: versionId,
      emailAccountId: mailboxId,
      status: "scheduled" as const,
    })));

    const enroll = (contactId: string) => runOperation(operation("sequences.enroll"), context(), { id: sequenceId, leadIds: [contactId], inboxId: mailboxId });

    await db.update(schema.workspaces).set({ legacyFreeUntil: new Date(Date.now() + 20 * 86_400_000) }).where(eq(schema.workspaces.id, workspaceId));
    await expect(enroll(contactIds[FREE_PLAN_CONTACT_LIMIT - 1]!)).resolves.toMatchObject({ enrolled: 1 });
    await expect(enroll(contactIds[FREE_PLAN_CONTACT_LIMIT]!)).rejects.toMatchObject({ code: "plan_limit", details: { limit: FREE_PLAN_CONTACT_LIMIT } });

    // Unlicensed (window over) has no contact cap: its sends wait on the license instead.
    await db.update(schema.workspaces).set({ legacyFreeUntil: new Date(Date.now() - 60_000) }).where(eq(schema.workspaces.id, workspaceId));
    await expect(enroll(contactIds[FREE_PLAN_CONTACT_LIMIT]!)).resolves.toMatchObject({ enrolled: 1 });

    await db.insert(schema.subscriptions).values({ id: randomUUID(), workspaceId, productId: lifetimeProductId, status: "active", metadata: { lifetime: true, dodoPaymentId: "pay_contact_cap" } });
    await db.update(schema.workspaces).set({ legacyFreeUntil: new Date(Date.now() + 20 * 86_400_000) }).where(eq(schema.workspaces.id, workspaceId));
    await expect(enroll(contactIds[FREE_PLAN_CONTACT_LIMIT + 1]!)).resolves.toMatchObject({ enrolled: 1 });
  });
});
