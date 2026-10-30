import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const env = loadAppEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
  API_BASE_URL: "https://api.example.test",
  WEB_BASE_URL: "https://app.example.test",
  LOG_LEVEL: "silent",
  AUTH_SECRET: "rate-limit-test-auth-secret-at-least-32-characters",
});

describe("public API rate limits", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("limits all endpoints to 300 requests per minute by IP", async () => {
    const app = await buildApp({ env });
    apps.push(app);

    for (let index = 0; index < 300; index += 1) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(429);
  });

  it("limits tracking pixels to 120 requests per minute", async () => {
    const app = await buildApp({ env });
    apps.push(app);
    const url = "/t/0123456789abcdef0123456789abcdef.gif";

    for (let index = 0; index < 120; index += 1) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(429);
  });
});

describe.skipIf(!databaseUrl)("authenticated API rate limits", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: Awaited<ReturnType<typeof createAuthenticatedSession>>;

  beforeAll(async () => {
    app = await buildApp({ env, db });
    session = await createAuthenticatedSession(app, "Rate Limit Test User");
  });

  afterAll(async () => {
    await app?.close();
    if (session?.workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    if (session?.userId) {
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, session.userId));
    }
    await pool.end();
  });

  it.each([
    { url: "/v1/sequences/draft", max: 10, payload: {} },
    { url: "/v1/imports/preview", max: 30, payload: { csv: "" } },
  ])("applies the tighter bucket to POST $url", async ({ url, max, payload }) => {
    for (let index = 0; index < max; index += 1) {
      const response = await app.inject({ method: "POST", url, headers: { cookie: session.cookie }, payload });
      expect(response.statusCode).not.toBe(429);
    }
    const limited = await app.inject({ method: "POST", url, headers: { cookie: session.cookie }, payload });
    expect(limited.statusCode).toBe(429);
  });
});
