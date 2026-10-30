import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool } from "@inboxjoy/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

function countReferrals(body: unknown): number {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === "object") {
    const referrals = (body as Record<string, unknown>).referrals;
    if (Array.isArray(referrals)) return referrals.length;
  }
  throw new Error(`GET /v1/affiliate/referrals did not return a recognizable array: ${JSON.stringify(body)}`);
}

describe.skipIf(!databaseUrl)("affiliate program — public click + signup attribution", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    AUTH_SECRET: "affiliate-signup-test-auth-secret-at-least-32-characters",
  });
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ env, db });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("the public click endpoint needs no auth and always replies 204, even for an unknown code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/affiliate/click",
      payload: { code: `unknown-${randomUUID()}` },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("the public click endpoint also replies 204 with no body at all", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/public/affiliate/click", payload: {} });
    expect(response.statusCode).toBe(204);
  });

  it("attributes a signup made with a valid ij_ref cookie, and ignores a bad/unknown cookie without blocking signup", async () => {
    const affiliate = await createAuthenticatedSession(app, "Affiliate Owner");

    const affiliateGet = await app.inject({ method: "GET", url: "/v1/affiliate", headers: { cookie: affiliate.cookie } });
    expect(affiliateGet.statusCode).toBe(200);
    const affiliateBody = affiliateGet.json() as { code?: unknown };
    const code = typeof affiliateBody.code === "string" ? affiliateBody.code : undefined;
    expect(code, `GET /v1/affiliate did not return a usable "code" field: ${affiliateGet.body}`).toBeTruthy();

    const referralsBefore = await app.inject({ method: "GET", url: "/v1/affiliate/referrals", headers: { cookie: affiliate.cookie } });
    expect(referralsBefore.statusCode).toBe(200);
    const beforeCount = countReferrals(referralsBefore.json());

    // A bad/unknown cookie must never fail or block the signup itself.
    const badCookieSignup = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      headers: { cookie: "ij_ref=not-a-real-affiliate-code" },
      payload: {
        name: "Bad Cookie Signup",
        email: `affiliate-bad-cookie-${randomUUID()}@example.com`,
        password: "test-password-at-least-eight-characters",
        acceptedTerms: true,
      },
    });
    expect(badCookieSignup.statusCode).toBe(200);

    const referralsAfterBadCookie = await app.inject({ method: "GET", url: "/v1/affiliate/referrals", headers: { cookie: affiliate.cookie } });
    expect(countReferrals(referralsAfterBadCookie.json())).toBe(beforeCount);

    // A valid cookie must attribute the new signup to this affiliate exactly once.
    const referredSignup = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      headers: { cookie: `${"ij_ref"}=${code}` },
      payload: {
        name: "Referred Signup",
        email: `affiliate-referred-${randomUUID()}@example.com`,
        password: "test-password-at-least-eight-characters",
        acceptedTerms: true,
      },
    });
    expect(referredSignup.statusCode).toBe(200);

    const referralsAfter = await app.inject({ method: "GET", url: "/v1/affiliate/referrals", headers: { cookie: affiliate.cookie } });
    expect(referralsAfter.statusCode).toBe(200);
    expect(countReferrals(referralsAfter.json())).toBe(beforeCount + 1);
  });
});
