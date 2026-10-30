import rateLimit from "@fastify/rate-limit";
import { loadAppEnv } from "@inboxjoy/config";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBillingRoutes } from "../src/modules/billing/index.js";

const env = loadAppEnv({
  NODE_ENV: "test",
  INBOXJOY_EDITION: "cloud",
  DATABASE_URL: "postgresql://localhost/inboxjoy_test",
  API_BASE_URL: "https://api.example.test",
  WEB_BASE_URL: "https://app.example.test",
  AUTH_SECRET: "billing-route-test-secret-at-least-32-characters",
});

async function billingApp(role: "owner" | "member") {
  const app = Fastify({ logger: false });
  const runOperation = vi.fn(async () => ({
    tier: "lifetime",
    status: "active",
    nextBillingDate: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    configured: true,
    hasCustomer: true,
    reconciled: true,
  }));
  app.decorateRequest("workspaceRole", role);
  await app.register(rateLimit, { global: false });
  registerBillingRoutes(app, env, { runOperation });
  await app.ready();
  return { app, runOperation };
}

describe("billing reconciliation route", () => {
  const apps: Awaited<ReturnType<typeof billingApp>>["app"][] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("runs billing.reconcile for an owner and rejects a member", async () => {
    const owner = await billingApp("owner");
    const member = await billingApp("member");
    apps.push(owner.app, member.app);

    const response = await owner.app.inject({ method: "POST", url: "/v1/billing/reconcile" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tier: "lifetime", status: "active", reconciled: true });
    expect(owner.runOperation).toHaveBeenCalledWith("billing.reconcile", expect.anything(), {});

    const forbidden = await member.app.inject({ method: "POST", url: "/v1/billing/reconcile" });
    expect(forbidden.statusCode).toBe(403);
    expect(member.runOperation).not.toHaveBeenCalled();
  });

  it("limits reconciliation polling to 12 requests per minute per IP", async () => {
    const owner = await billingApp("owner");
    apps.push(owner.app);

    for (let requestNumber = 0; requestNumber < 12; requestNumber += 1) {
      expect((await owner.app.inject({ method: "POST", url: "/v1/billing/reconcile" })).statusCode).toBe(200);
    }
    expect((await owner.app.inject({ method: "POST", url: "/v1/billing/reconcile" })).statusCode).toBe(429);
  });
});
