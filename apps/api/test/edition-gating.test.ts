import { loadAppEnv, resolveSetupToken, resolveSignupMode } from "@inboxjoy/config";
import { OpError } from "@inboxjoy/core";
import type { InboxJoyDb } from "@inboxjoy/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { admitSignup, invitedWorkspaceForToken, setupTokenMatches } from "../src/auth.js";

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return loadAppEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    LOG_LEVEL: "silent",
    AUTH_SECRET: "edition-gating-test-secret-at-least-32-characters",
    DODO_PAYMENTS_WEBHOOK_KEY: "webhook-key",
    ...overrides,
  });
}

const setupToken = "setup-token-0123456789abcdefghij";

const dodoRoutes = [
  { method: "POST", url: "/v1/billing/checkout" },
  { method: "POST", url: "/v1/billing/reconcile" },
  { method: "POST", url: "/v1/billing/portal" },
  { method: "POST", url: "/v1/billing/cancel" },
  { method: "POST", url: "/v1/webhooks/dodo" },
] as const;

const affiliateRoutes = [
  { method: "GET", url: "/v1/affiliate" },
  { method: "GET", url: "/v1/affiliate/referrals" },
  { method: "POST", url: "/v1/public/affiliate/click" },
] as const;

describe("SIGNUP_MODE", () => {
  it("defaults to open on cloud and invite on self-host", () => {
    expect(resolveSignupMode({ INBOXJOY_EDITION: "cloud", NODE_ENV: "production", SIGNUP_MODE: undefined })).toBe("open");
    expect(resolveSignupMode({ INBOXJOY_EDITION: "selfhost", NODE_ENV: "production", SIGNUP_MODE: undefined })).toBe("invite");
    expect(resolveSignupMode({ INBOXJOY_EDITION: undefined, NODE_ENV: "development", SIGNUP_MODE: undefined })).toBe("invite");
  });

  it("keeps the shared test database open unless a test asks for invite", () => {
    expect(resolveSignupMode(testEnv())).toBe("open");
    expect(resolveSignupMode(testEnv({ SIGNUP_MODE: "invite" }))).toBe("invite");
  });

  it("lets an explicit value override the edition default", () => {
    expect(resolveSignupMode(testEnv({ INBOXJOY_EDITION: "cloud", SIGNUP_MODE: "invite" }))).toBe("invite");
    expect(resolveSignupMode({ INBOXJOY_EDITION: "selfhost", NODE_ENV: "production", SIGNUP_MODE: "open" })).toBe("open");
    expect(testEnv({ SIGNUP_MODE: "" }).SIGNUP_MODE).toBeUndefined();
    expect(() => testEnv({ SIGNUP_MODE: "first-user" })).toThrow();
  });
});

describe("edition route gating", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function start(overrides: NodeJS.ProcessEnv) {
    const app = await buildApp({ env: testEnv(overrides) });
    apps.push(app);
    await app.ready();
    return app;
  }

  it("self-host registers no Dodo or affiliate routes but keeps the plan read", async () => {
    const app = await start({ INBOXJOY_EDITION: "selfhost" });

    for (const route of [...dodoRoutes, ...affiliateRoutes]) {
      expect(app.hasRoute(route), `${route.method} ${route.url}`).toBe(false);
    }
    expect(app.hasRoute({ method: "GET", url: "/v1/billing" })).toBe(true);

    // Public paths answer 404 rather than reaching any handler.
    const webhook = await app.inject({ method: "POST", url: "/v1/webhooks/dodo", payload: {} });
    expect(webhook.statusCode).toBe(404);
    const click = await app.inject({ method: "POST", url: "/v1/public/affiliate/click", payload: { code: "anything" } });
    expect(click.statusCode).toBe(404);
  });

  it("cloud keeps every Dodo and affiliate route", async () => {
    const app = await start({ INBOXJOY_EDITION: "cloud" });

    for (const route of [...dodoRoutes, ...affiliateRoutes, { method: "GET", url: "/v1/billing" } as const]) {
      expect(app.hasRoute(route), `${route.method} ${route.url}`).toBe(true);
    }
    const click = await app.inject({ method: "POST", url: "/v1/public/affiliate/click", payload: { code: "anything" } });
    expect(click.statusCode).toBe(204);
  });
});

describe("public status endpoint", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("needs no session and returns only the edition and sign-up fields", async () => {
    const app = await buildApp({ env: testEnv({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "invite" }) });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/v1/public/status" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    // Without a database there is nothing to set up, so sign-up reads as closed.
    expect(response.json()).toEqual({ edition: "selfhost", signupMode: "invite", signupOpen: false, needsSetup: false, setupTokenRequired: false });
  });

  it("reports cloud as open by default", async () => {
    const app = await buildApp({ env: testEnv({ INBOXJOY_EDITION: "cloud" }) });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/v1/public/status" });

    expect(response.json()).toEqual({ edition: "cloud", signupMode: "open", signupOpen: true, needsSetup: false, setupTokenRequired: false });
  });

  it("never returns the setup token itself", async () => {
    const app = await buildApp({ env: testEnv({ INBOXJOY_EDITION: "selfhost", SETUP_TOKEN: setupToken }) });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/v1/public/status" });

    expect(response.body).not.toContain(setupToken);
    // No database, so nothing to set up and no token to ask for.
    expect(response.json()).toMatchObject({ needsSetup: false, setupTokenRequired: false });
  });
});

describe("SETUP_TOKEN", () => {
  it("is optional, at least 24 characters, and applies only to self-host", () => {
    expect(testEnv().SETUP_TOKEN).toBeUndefined();
    expect(testEnv({ SETUP_TOKEN: "" }).SETUP_TOKEN).toBeUndefined();
    expect(testEnv({ SETUP_TOKEN: `  ${setupToken}  ` }).SETUP_TOKEN).toBe(setupToken);
    expect(() => testEnv({ SETUP_TOKEN: "too-short" })).toThrow(/at least 24 characters/);
    expect(resolveSetupToken(testEnv({ INBOXJOY_EDITION: "selfhost", SETUP_TOKEN: setupToken }))).toBe(setupToken);
    expect(resolveSetupToken(testEnv({ INBOXJOY_EDITION: "cloud", SETUP_TOKEN: setupToken }))).toBeUndefined();
  });

  it("compares the submitted token exactly, in constant time", () => {
    expect(setupTokenMatches(setupToken, setupToken)).toBe(true);
    expect(setupTokenMatches(setupToken, ` ${setupToken}\n`)).toBe(true);
    expect(setupTokenMatches(setupToken, `${setupToken}x`)).toBe(false);
    expect(setupTokenMatches(setupToken, setupToken.slice(0, -1))).toBe(false);
    expect(setupTokenMatches(setupToken, "")).toBe(false);
    expect(setupTokenMatches(setupToken, undefined)).toBe(false);
    expect(setupTokenMatches(setupToken, 12345)).toBe(false);
    expect(setupTokenMatches(setupToken, "x".repeat(10_000))).toBe(false);
  });
});

describe("sign-up admission without a database round trip", () => {
  // Any query against this fails the test: these paths must not need one.
  const noDatabase = new Proxy({}, { get: () => { throw new Error("database used"); } }) as unknown as InboxJoyDb;

  it("keeps cloud open sign-up exactly as before, whatever the body carries", async () => {
    expect(await admitSignup(noDatabase, { mode: "open", edition: "cloud", setupToken: undefined }, { email: "anyone@example.test", inviteToken: "x", setupToken: "y" }))
      .toEqual({ admitted: true, reason: "open", emailVerified: false });
  });

  it("rejects a malformed invitation token before looking anything up", async () => {
    for (const token of [undefined, null, 42, "", "not-a-token", `${"0".repeat(36)}.short`, `00000000-0000-4000-8000-000000000000.${"a".repeat(300)}`]) {
      expect(await invitedWorkspaceForToken(noDatabase, "invitee@example.test", token)).toBeNull();
    }
  });
});

describe("operation error mapping", () => {
  it("answers not_available (an operation missing from this edition) with 404", async () => {
    const app = await buildApp({ env: testEnv({ INBOXJOY_EDITION: "selfhost" }) });
    app.get("/test/not-available", async () => { throw new OpError("not_available", "Billing is not part of the self-hosted edition."); });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/test/not-available" });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_available", error: "Billing is not part of the self-hosted edition." });
  });
});
