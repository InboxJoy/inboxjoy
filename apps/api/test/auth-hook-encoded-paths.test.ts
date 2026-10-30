import { loadAppEnv } from "@inboxjoy/config";
import { runOperation, type OperationContext } from "@inboxjoy/core";
import { schema } from "@inboxjoy/db";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

vi.mock("@inboxjoy/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@inboxjoy/core")>(),
  runOperation: vi.fn(),
}));

vi.mock("../src/auth.js", () => ({
  createAuth: vi.fn(),
  provisionWorkspace: vi.fn(),
  transactionalEmailFromEnv: vi.fn(),
}));

// The Fastify router percent-decodes a path before matching it, so the auth hook
// must not decide anything from the raw URL alone: "/v1/%74eam" is "/v1/team" to
// the router. These run without Postgres -- the only query the hook makes is the
// API-key lookup, which the stub below answers with one valid key.
describe("auth hook with percent-encoded paths", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const apiKey = { authorization: "Bearer ij_test-key" };
  const forbidden = "API keys cannot access this route. Use a browser session.";
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.apiKeys) throw new Error("Unexpected database query");
        return { where: () => ({ limit: async () => [{ id: randomUUID(), workspaceId, createdByUserId: userId, revokedAt: null }] }) };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as OperationContext["db"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runOperation).mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(withDatabase = true) {
    const env = loadAppEnv({
      NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: "postgresql://unused/inboxjoy_test",
      API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test",
      AUTH_SECRET: "auth-hook-encoded-path-secret-at-least-32-characters",
    });
    const app = await buildApp({ env, db: withDatabase ? db : undefined });
    apps.push(app);
    return app;
  }

  it.each([
    { method: "POST", plain: "/v1/team/invitations", encoded: "/v1/%74eam/invitations" },
    { method: "GET", plain: "/v1/team", encoded: "/v1/tea%6D" },
    { method: "POST", plain: "/v1/api-keys", encoded: "/v1/api-key%73" },
    { method: "GET", plain: "/v1/api-keys", encoded: "/v1/%61pi-keys" },
    { method: "DELETE", plain: "/v1/workspace", encoded: "/v1/workspac%65" },
    { method: "GET", plain: "/v1/workspaces", encoded: "/v1/workspace%73" },
    { method: "POST", plain: "/v1/workspaces/switch", encoded: "/v1/work%73paces/switch" },
    { method: "GET", plain: "/v1/billing", encoded: "/v1/%62illing" },
    { method: "POST", plain: "/v1/team/invitations", encoded: "/v%31/team/invitations" },
    { method: "DELETE", plain: "/v1/workspace", encoded: "/%761/workspace" },
  ] as const)("refuses an API key on $method $encoded exactly like $plain", async ({ method, plain, encoded }) => {
    const app = await createApp();

    const plainResponse = await app.inject({ method, url: plain, headers: apiKey });
    const encodedResponse = await app.inject({ method, url: encoded, headers: apiKey });
    const withQuery = await app.inject({ method, url: `${encoded}?x=1`, headers: apiKey });

    expect(plainResponse.statusCode).toBe(403);
    expect(plainResponse.json()).toMatchObject({ error: forbidden });
    expect(encodedResponse.statusCode).toBe(403);
    expect(encodedResponse.json()).toMatchObject({ error: forbidden });
    expect(withQuery.statusCode).toBe(403);
    expect(runOperation).not.toHaveBeenCalled();
  });

  it.each([
    "/v%31/workspace",
    "/v%31/sending",
    "/%761/sending",
    "/v1/sendin%67",
    "/v%31/team",
    "/v%31/api-keys",
  ])("requires authentication on GET %s and never runs the handler", async (url) => {
    const app = await createApp();

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "Authentication required." });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("rejects a bearer token that is not an ij_ key on an encoded path", async () => {
    const app = await createApp();

    const response = await app.inject({ method: "GET", url: "/v%31/sending", headers: { authorization: "Bearer not-a-key" } });

    expect(response.statusCode).toBe(401);
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("still serves an allowed route to a valid API key, encoded or not", async () => {
    const app = await createApp();

    for (const url of ["/v1/sending", "/v1/sendin%67", "/v%31/sending"]) {
      vi.mocked(runOperation).mockClear();
      const response = await app.inject({ method: "GET", url, headers: apiKey });
      expect(response.statusCode).toBe(200);
      expect(runOperation).toHaveBeenCalledTimes(1);
      expect(runOperation).toHaveBeenCalledWith(expect.objectContaining({ name: "sending.get" }), expect.objectContaining({ workspaceId, userId }), {});
    }

    // Only DELETE on /v1/workspace is closed to keys; other methods stay open.
    vi.mocked(runOperation).mockClear();
    const patched = await app.inject({ method: "PATCH", url: "/v1/workspac%65", headers: apiKey, payload: { name: "Renamed" } });
    expect(patched.statusCode).toBe(200);
    expect(runOperation).toHaveBeenCalledWith(expect.objectContaining({ name: "workspace.update" }), expect.objectContaining({ workspaceId }), { name: "Renamed" });
  });

  // Admin-only operations under otherwise key-accessible prefixes: the route
  // list in the hook cannot name them, so runWorkspaceOperation refuses them by
  // operation name (MCP_ADMIN_OPERATIONS), before the handler ever runs.
  it.each([
    { method: "DELETE", url: `/v1/suppressions/${randomUUID()}` },
    { method: "DELETE", url: `/v1/suppression%73/${randomUUID()}` },
    { method: "DELETE", url: `/v1/sequences/${randomUUID()}` },
    { method: "DELETE", url: `/v%31/sequences/${randomUUID()}` },
  ] as const)("refuses an API key on $method $url although the prefix is open to keys", async ({ method, url }) => {
    const app = await createApp();

    const response = await app.inject({ method, url, headers: apiKey });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: forbidden });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("lets an API key edit workspace identity but not its sending controls", async () => {
    const app = await createApp();

    for (const payload of [{ killSwitchEnabled: false }, { killSwitchEnabled: true }, { dailySendCap: 100_000 }, { name: "Renamed", killSwitchEnabled: true }, { name: "Renamed", dailySendCap: 1 }]) {
      vi.mocked(runOperation).mockClear();
      const response = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: apiKey, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: forbidden });
      expect(runOperation).not.toHaveBeenCalled();
    }

    vi.mocked(runOperation).mockClear();
    const renamed = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: apiKey, payload: { name: "Renamed", defaultTimezone: "UTC", postalAddress: "1 Main St" } });
    expect(renamed.statusCode).toBe(200);
    expect(runOperation).toHaveBeenCalledWith(expect.objectContaining({ name: "workspace.update" }), expect.objectContaining({ workspaceId, userId }), { name: "Renamed", defaultTimezone: "UTC", postalAddress: "1 Main St" });
  });

  it("keeps the public routes public without credentials", async () => {
    const app = await createApp(false);

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/t/0123456789abcdef0123456789abcdef.gif" })).statusCode).toBe(200);

    // Each of these is the route's own answer, proving the handler ran rather
    // than the auth hook's 401.
    const confirm = await app.inject({ method: "GET", url: "/v1/unsubscribe?token=bogus" });
    expect(confirm.statusCode).toBe(400);
    expect(confirm.body).toContain("This unsubscribe link is invalid or expired.");
    const oneClick = await app.inject({ method: "POST", url: "/v1/unsubscribe?token=bogus" });
    expect(oneClick.statusCode).toBe(400);
    expect(oneClick.json()).toMatchObject({ error: "This unsubscribe link is invalid or expired." });
    const webhook = await app.inject({ method: "POST", url: "/v1/webhooks/composio", payload: {} });
    expect(webhook.statusCode).toBe(503);
    expect(webhook.json()).toMatchObject({ error: "Webhook integration is disabled." });
    const authRoute = await app.inject({ method: "GET", url: "/v1/auth/get-session" });
    expect(authRoute.statusCode).toBe(503);
    expect(authRoute.json()).toMatchObject({ error: "Authentication is unavailable." });
    const guide = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: {} });
    expect(guide.statusCode).not.toBe(401);
    const affiliate = await app.inject({ method: "POST", url: "/v1/public/affiliate/click", payload: {} });
    expect(affiliate.statusCode).not.toBe(401);
  });

  it("keeps answering 404 for paths no route matches", async () => {
    const app = await createApp(false);

    expect((await app.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks/nope" })).statusCode).toBe(404);
    // A doubly-encoded path decodes once, to a path that is not a route.
    expect((await app.inject({ method: "GET", url: "/v1/%2574eam", headers: apiKey })).statusCode).not.toBe(200);
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("does not treat an encoded spelling of a public route as public", async () => {
    const app = await createApp(false);

    for (const [method, url] of [["GET", "/v%31/unsubscribe"], ["GET", "/v1/unsubscrib%65"], ["POST", "/v%31/webhooks/composio"], ["POST", "/v1/webhook%73/composio"]] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
  });
});
