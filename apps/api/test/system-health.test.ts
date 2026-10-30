import { loadAppEnv } from "@inboxjoy/config";
import type { BillingClient } from "@inboxjoy/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const billingClient: BillingClient = {
  async createCheckoutSession() {
    return {};
  },
  async createCustomerPortal() {
    return {};
  },
  async retrieveSubscription() {
    return {};
  },
  async listSubscriptions() {
    return [];
  },
  async updateSubscription() {
    return {};
  },
};

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return loadAppEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    LOG_LEVEL: "silent",
    AUTH_SECRET: "system-health-test-secret-at-least-32-characters",
    ...overrides,
  });
}

describe("system health", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("reports billing as configured only for complete live credentials", async () => {
    const app = await buildApp({
      env: testEnv({
        DODO_PAYMENTS_API_KEY: "api-key",
        DODO_PRODUCT_LIFETIME: "lifetime-product",
        DODO_PAYMENTS_WEBHOOK_KEY: "webhook-key",
        DODO_PAYMENTS_ENVIRONMENT: "live_mode",
      }),
      dodo: billingClient,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", billingConfigured: true });
  });

  it.each([
    { DODO_PAYMENTS_ENVIRONMENT: "live_mode" },
    {
      DODO_PAYMENTS_API_KEY: "api-key",
      DODO_PRODUCT_LIFETIME: "lifetime-product",
      DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    },
    {
      DODO_PAYMENTS_API_KEY: "api-key",
      DODO_PRODUCT_LIFETIME: "lifetime-product",
      DODO_PAYMENTS_ENVIRONMENT: "live_mode",
    },
    {
      // Without the lifetime product, checkout can't work.
      DODO_PAYMENTS_API_KEY: "api-key",
      DODO_PAYMENTS_WEBHOOK_KEY: "webhook-key",
      DODO_PAYMENTS_ENVIRONMENT: "live_mode",
    },
  ])("reports incomplete or test-mode billing without failing health", async (dodoEnv) => {
    const app = await buildApp({ env: testEnv(dodoEnv), dodo: billingClient });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", billingConfigured: false });
  });

  it("coerces a positive API database pool ceiling", () => {
    expect(testEnv({ DATABASE_POOL_MAX: "7" }).DATABASE_POOL_MAX).toBe(7);
    expect(() => testEnv({ DATABASE_POOL_MAX: "0" })).toThrow();
  });

  it("returns the worker readiness reason from the configured check", async () => {
    const app = await buildApp({
      env: testEnv(),
      dodo: billingClient,
      readyCheck: async () => ({ ready: false, reason: "no_worker_heartbeat" }),
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false, reason: "no_worker_heartbeat" });
  });
});
