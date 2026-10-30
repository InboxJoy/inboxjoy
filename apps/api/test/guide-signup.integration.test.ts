import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService } from "@inboxjoy/email";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("guide signup", () => {
  const suffix = randomUUID().slice(0, 8);
  const validEmail = `Guide-${suffix}@Example.com`;
  const normalizedEmail = validEmail.toLowerCase();
  const duplicateEmail = `DUPLICATE-${suffix}@Example.com`;
  const normalizedDuplicateEmail = duplicateEmail.toLowerCase();
  const rateLimitEmails = Array.from({ length: 10 }, (_, index) => `guide-rate-${suffix}-${index}@example.com`);
  const pool = createPgPool(databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/inboxjoy?sslmode=disable");
  const db = createDb(pool);
  const env = loadAppEnv({
    ...process.env,
    NODE_ENV: "test",
    INBOXJOY_EDITION: "cloud",
    DATABASE_URL: databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/inboxjoy?sslmode=disable",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    AUTH_SECRET: "guide-signup-test-auth-secret-at-least-32-characters",
    FOUNDER_ALERT_EMAIL: "founder@example.test",
  });
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  beforeAll(async () => {
    await db.delete(schema.guideSignups).where(inArray(schema.guideSignups.normalizedEmail, [
      normalizedEmail,
      normalizedDuplicateEmail,
      ...rateLimitEmails,
    ]));
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await db.delete(schema.guideSignups).where(inArray(schema.guideSignups.normalizedEmail, [
      normalizedEmail,
      normalizedDuplicateEmail,
      ...rateLimitEmails,
    ]));
    await pool.end();
  });

  it("accepts a valid email and persists the signup", async () => {
    const app = await buildApp({ env, db });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/guide-signup",
      payload: { email: `  ${validEmail}  `, source: "home" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const [signup] = await db.select().from(schema.guideSignups).where(eq(schema.guideSignups.normalizedEmail, normalizedEmail));
    expect(signup).toMatchObject({ email: validEmail, normalizedEmail, source: "home", guideSentAt: null });
  });

  it("returns success for a duplicate and keeps one row", async () => {
    const alerts: Array<{ to: string; subject: string }> = [];
    const transactionalEmail = {
      ...disabledTransactionalEmailService,
      enabled: true,
      async sendSequenceTest(input: Parameters<typeof disabledTransactionalEmailService.sendSequenceTest>[0]) {
        alerts.push({ to: input.recipient.email, subject: input.subject });
      },
    };
    const app = await buildApp({ env, db, transactionalEmail });
    apps.push(app);
    const first = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: { email: duplicateEmail } });
    const duplicate = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: { email: normalizedDuplicateEmail, source: "pricing" } });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ ok: true });
    const rows = await db.select().from(schema.guideSignups).where(eq(schema.guideSignups.normalizedEmail, normalizedDuplicateEmail));
    expect(rows).toHaveLength(1);
    expect(alerts).toEqual([{
      to: "founder@example.test",
      subject: `New guide signup: ${duplicateEmail}`,
    }]);
  });

  it("never sends the founder alert from a self-hosted server", async () => {
    const alerts: string[] = [];
    const transactionalEmail = {
      ...disabledTransactionalEmailService,
      enabled: true,
      async sendSequenceTest(input: Parameters<typeof disabledTransactionalEmailService.sendSequenceTest>[0]) {
        alerts.push(input.recipient.email);
      },
    };
    const app = await buildApp({ env: { ...env, INBOXJOY_EDITION: "selfhost" }, db, transactionalEmail });
    const response = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: { email: validEmail.replace("Guide-", "Guide-selfhost-") } });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(alerts).toEqual([]);
    await db.delete(schema.guideSignups).where(eq(schema.guideSignups.normalizedEmail, normalizedEmail.replace("guide-", "guide-selfhost-")));
  });

  it("rejects an invalid email", async () => {
    const app = await buildApp({ env, db });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: { email: "not-an-email" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Enter a valid email address." });
  });

  it("limits guide signups to 10 requests per minute per IP", async () => {
    const app = await buildApp({ env, db });
    apps.push(app);
    for (const email of rateLimitEmails) {
      const response = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: { email } });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: "POST", url: "/v1/guide-signup", payload: { email: `guide-rate-${suffix}-limited@example.com` } });
    expect(limited.statusCode).toBe(429);
  });
});
