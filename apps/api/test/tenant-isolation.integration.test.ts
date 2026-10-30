import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const authSecret = "tenant-isolation-auth-secret-at-least-32-characters";

describe.skipIf(!databaseUrl)("tenant isolation", () => {
  const suffix = randomUUID().slice(0, 8);
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: authSecret });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userA: AuthenticatedSession;
  let userB: AuthenticatedSession;
  let sequenceId = "";
  let leadId = "";
  let suppressionId = "";

  beforeAll(async () => {
    app = await buildApp({ env, db });
    userA = await createAuthenticatedSession(app, "Tenant Alpha");
    userB = await createAuthenticatedSession(app, "Tenant Beta");
    await db.update(schema.workspaces).set({ postalAddress: "123 Main St\nAustin, TX 78701" }).where(eq(schema.workspaces.id, userB.workspaceId));

    const created = await app.inject({
      method: "POST",
      url: "/v1/sequences",
      headers: { cookie: userA.cookie },
      payload: { name: `Private campaign ${suffix}`, description: "Private", steps: [{ delayDays: 0, subject: "Hello", body: "Hi" }] },
    });
    expect(created.statusCode).toBe(201);
    sequenceId = created.json().sequence.id as string;

    const email = `private-${suffix}@example.com`;
    const preview = await app.inject({
      method: "POST",
      url: "/v1/imports/preview",
      headers: { cookie: userA.cookie },
      payload: { fileName: "private.csv", csv: `email\n${email}` },
    });
    expect(preview.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/imports/${preview.json().import.id as string}/commit`, headers: { cookie: userA.cookie } })).statusCode).toBe(200);
    const leads = await app.inject({ method: "GET", url: "/v1/leads", headers: { cookie: userA.cookie } });
    leadId = leads.json().leads[0].id as string;

    const suppression = await app.inject({ method: "POST", url: "/v1/suppressions", headers: { cookie: userA.cookie }, payload: { email, reason: "tenant_test" } });
    expect(suppression.statusCode).toBe(201);
    suppressionId = suppression.json().suppression.id as string;
  });

  afterAll(async () => {
    await app?.close();
    if (userA) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, userA.workspaceId));
    if (userB) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, userB.workspaceId));
    await pool.end();
  });

  it("never exposes one workspace's data to another authenticated workspace", async () => {
    const headers = { cookie: userB.cookie };
    const [sequences, leads, lists, suppressions, workspace] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/sequences", headers }),
      app.inject({ method: "GET", url: "/v1/leads", headers }),
      app.inject({ method: "GET", url: "/v1/lists", headers }),
      app.inject({ method: "GET", url: "/v1/suppressions", headers }),
      app.inject({ method: "GET", url: "/v1/workspace", headers }),
    ]);
    expect(sequences.json().sequences).toEqual([]);
    expect(leads.json().leads).toEqual([]);
    expect(lists.json().lists).toEqual([]);
    expect(suppressions.json().suppressions).toEqual([]);
    expect(workspace.json().workspace.id).toBe(userB.workspaceId);
    expect(workspace.json().workspace.id).not.toBe(userA.workspaceId);

    for (const request of [
      { method: "POST", url: `/v1/sequences/${sequenceId}/pause` },
      { method: "GET", url: `/v1/sequences/${sequenceId}/analytics` },
      { method: "PATCH", url: `/v1/sequences/${sequenceId}`, payload: { name: "Nope", description: "Nope", steps: [{ delayDays: 0, subject: "Nope", body: "Nope" }] } },
      { method: "POST", url: `/v1/sequences/${sequenceId}/duplicate` },
      { method: "POST", url: `/v1/sequences/${sequenceId}/enroll`, payload: { leadIds: [leadId] } },
    ]) {
      expect((await app.inject({ ...request, headers })).statusCode).toBe(404);
    }

    expect((await app.inject({ method: "DELETE", url: `/v1/suppressions/${suppressionId}`, headers })).statusCode).toBe(404);
  });
});
