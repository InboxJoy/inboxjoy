import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

const siteverifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const databaseUrl = process.env.DATABASE_URL;
const env = loadAppEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
  API_BASE_URL: "https://api.example.test",
  WEB_BASE_URL: "https://app.example.test",
  LOG_LEVEL: "silent",
  AUTH_SECRET: "turnstile-test-auth-secret-at-least-32-characters",
  TURNSTILE_SECRET: "turnstile-test-secret-at-least-32-characters",
  TURNSTILE_HOSTNAMES: "app.example.test",
});

describe.skipIf(!databaseUrl)("signup Turnstile verification", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const emails = new Set<string>();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp({ env, db });
  });

  afterEach(async () => {
    await app.close();
    for (const email of emails) {
      const [authUser] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers).where(eq(schema.authUsers.email, email));
      if (authUser) {
        await db.delete(schema.workspaces).where(eq(schema.workspaces.createdByUserId, authUser.id));
        await db.delete(schema.users).where(eq(schema.users.id, authUser.id));
        await db.delete(schema.authUsers).where(eq(schema.authUsers.id, authUser.id));
      }
    }
    emails.clear();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  function signupPayload(turnstileToken?: unknown) {
    const email = `turnstile-${randomUUID()}@example.test`;
    emails.add(email);
    return {
      name: "Turnstile Test",
      email,
      password: "test-password-at-least-eight-characters",
      acceptedTerms: true,
      ...(turnstileToken === undefined ? {} : { turnstileToken }),
    };
  }

  function stubSiteverify(result: unknown, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(input).toBe(siteverifyUrl);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(init?.signal).toBeInstanceOf(AbortSignal);

      const body = init?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      const params = body as URLSearchParams;
      expect(params.get("response")).toBe("valid-test-token");
      expect(params.get("remoteip")).toBe("127.0.0.1");

      return new Response(JSON.stringify(result), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("rejects signup with a missing token before creating a user", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected siteverify request"));
    const payload = signupPayload();

    const response = await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Complete the human verification challenge and try again." });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, payload.email))).toHaveLength(0);
  });

  it("rejects a failed siteverify response before creating a user", async () => {
    stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const payload = signupPayload("valid-test-token");

    const response = await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "We could not verify that you are human. Refresh and try again." });
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, payload.email))).toHaveLength(0);
  });

  it("allows signup after siteverify confirms the action and hostname", async () => {
    stubSiteverify({ success: true, action: "signup", hostname: "app.example.test" });
    const payload = signupPayload("valid-test-token");

    const response = await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email: payload.email } });
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, payload.email))).toHaveLength(1);
  });

  it("fails closed when siteverify cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("siteverify unavailable"));
    const payload = signupPayload("valid-test-token");

    const response = await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "We could not verify that you are human. Refresh and try again." });
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, payload.email))).toHaveLength(0);
  });
});
