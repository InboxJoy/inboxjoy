import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("workspace export and import API", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "workspace-transfer-api-secret-at-least-32-characters" });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let source: AuthenticatedSession;
  let target: AuthenticatedSession;
  let bystander: AuthenticatedSession;
  const cleanupWorkspaceIds = new Set<string>();

  async function leadCount(workspaceId: string) {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from contacts where workspace_id = $1", [workspaceId]);
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    app = await buildApp({ env, db });
    source = await createAuthenticatedSession(app, "Transfer Source");
    target = await createAuthenticatedSession(app, "Transfer Target");
    bystander = await createAuthenticatedSession(app, "Transfer Bystander");
    for (const session of [source, target, bystander]) cleanupWorkspaceIds.add(session.workspaceId);

    const contactId = randomUUID();
    const listId = randomUUID();
    await db.insert(schema.contacts).values({ id: contactId, workspaceId: source.workspaceId, email: "lead@example.com", normalizedEmail: "lead@example.com", firstName: "Lead", status: "active" });
    await db.insert(schema.contactLists).values({ id: listId, workspaceId: source.workspaceId, name: "Prospects" });
    await db.insert(schema.contactListMembers).values({ workspaceId: source.workspaceId, contactListId: listId, contactId });
    const created = await app.inject({ method: "POST", url: "/v1/sequences", headers: { cookie: source.cookie }, payload: { name: "Intro", steps: [{ delayDays: 0, subject: "Hi {{firstName}}", body: "Hello" }] } });
    expect(created.statusCode).toBe(201);
    await db.insert(schema.contacts).values({ id: randomUUID(), workspaceId: bystander.workspaceId, email: "bystander@example.com", normalizedEmail: "bystander@example.com", status: "active" });
    // The target owner is also an admin of the source workspace.
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: source.workspaceId, userId: target.userId, role: "admin", status: "active", joinedAt: new Date() });
  });

  afterAll(async () => {
    for (const workspaceId of cleanupWorkspaceIds) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await app?.close();
    await pool.end();
  });

  it("downloads the owner's workspace as a JSON attachment", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: source.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="inboxjoy-.+-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers["cache-control"]).toBe("no-store");
    const file = response.json();
    expect(file).toMatchObject({ format: "inboxjoy-workspace", version: 1, leads: [{ email: "lead@example.com" }], lists: [{ name: "Prospects", leadEmails: ["lead@example.com"] }] });
    expect(response.body).not.toContain("bystander@example.com");
  });

  it("refuses admins, other workspaces and API keys", async () => {
    const asAdmin = { cookie: target.cookie, "x-workspace-id": source.workspaceId };
    expect((await app.inject({ method: "GET", url: "/v1/workspace/export", headers: asAdmin })).statusCode).toBe(403);
    const file = (await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: source.cookie } })).json();
    expect((await app.inject({ method: "POST", url: "/v1/workspace/import", headers: asAdmin, payload: file })).statusCode).toBe(403);
    // A session cannot aim at a workspace it does not belong to.
    expect((await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: target.cookie, "x-workspace-id": bystander.workspaceId } })).statusCode).toBe(409);

    const key = `ij_${randomUUID()}`;
    await db.insert(schema.apiKeys).values({ id: randomUUID(), workspaceId: target.workspaceId, name: "Transfer test", keyHash: createHash("sha256").update(key).digest("hex"), createdByUserId: target.userId });
    for (const request of [{ method: "GET" as const, url: "/v1/workspace/export" }, { method: "POST" as const, url: "/v1/workspace/import", payload: file }]) {
      const response = await app.inject({ ...request, headers: { authorization: `Bearer ${key}` } });
      expect(response.statusCode).toBe(403);
    }
    expect(await leadCount(target.workspaceId)).toBe(0);
  });

  it("imports into an empty workspace once, as drafts, and leaves other tenants alone", async () => {
    const file = (await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: source.cookie } })).json();
    const imported = await app.inject({ method: "POST", url: "/v1/workspace/import", headers: { cookie: target.cookie, "x-workspace-id": target.workspaceId }, payload: file });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().imported).toMatchObject({ leads: 1, lists: 1, listMemberships: 1, sequences: 1, steps: 1 });

    const sequences = await app.inject({ method: "GET", url: "/v1/sequences", headers: { cookie: target.cookie, "x-workspace-id": target.workspaceId } });
    expect(sequences.json().sequences).toEqual([expect.objectContaining({ name: "Intro", status: "draft", enrolledCount: 0 })]);
    expect(await leadCount(bystander.workspaceId)).toBe(1);
    expect(await leadCount(source.workspaceId)).toBe(1);

    const again = await app.inject({ method: "POST", url: "/v1/workspace/import", headers: { cookie: target.cookie, "x-workspace-id": target.workspaceId }, payload: file });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "workspace_not_empty" });
    expect(await leadCount(target.workspaceId)).toBe(1);
  });

  it("asks an unverified owner to verify before reading the upload", async () => {
    const unverified = await createAuthenticatedSession(app, "Transfer Unverified");
    cleanupWorkspaceIds.add(unverified.workspaceId);
    await db.update(schema.authUsers).set({ emailVerified: false }).where(eq(schema.authUsers.id, unverified.userId));
    // Each import test uses its own client address: the import route allows five
    // requests a minute per address, and the earlier tests already used them.
    const response = await app.inject({ method: "POST", url: "/v1/workspace/import", remoteAddress: "198.51.100.11", headers: { cookie: unverified.cookie }, payload: { format: "inboxjoy-workspace", version: 1, exportedAt: "2026-10-29T10:00:00.000Z", workspace: { name: "Unverified" } } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "email_unverified" });
    expect(await leadCount(unverified.workspaceId)).toBe(0);
  });

  it("explains a file that is not a workspace export", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/workspace/import", remoteAddress: "198.51.100.12", headers: { cookie: bystander.cookie }, payload: { hello: "world" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "not_workspace_export", error: "This file is not an InboxJoy workspace export." });
  });
});
