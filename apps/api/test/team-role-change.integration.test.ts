import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("team member role changes", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    AUTH_SECRET: "team-role-test-auth-secret-at-least-32-characters",
    LOG_LEVEL: "silent",
  });
  const sessions: AuthenticatedSession[] = [];
  const memberId = randomUUID();
  const adminId = randomUUID();
  const coOwnerId = randomUUID();
  const initialUpdatedAt = new Date("2020-01-01T00:00:00.000Z");
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: AuthenticatedSession;
  let member: AuthenticatedSession;
  let admin: AuthenticatedSession;
  let otherOwner: AuthenticatedSession;
  let ownerId: string;
  let otherWorkspaceMemberId: string;
  let apiKey: string;

  beforeAll(async () => {
    app = await buildApp({ env, db });
    owner = await createAuthenticatedSession(app, "Role Owner");
    sessions.push(owner);
    member = await createAuthenticatedSession(app, "Role Member");
    sessions.push(member);
    admin = await createAuthenticatedSession(app, "Role Admin");
    sessions.push(admin);
    otherOwner = await createAuthenticatedSession(app, "Other Role Owner");
    sessions.push(otherOwner);
    await db.insert(schema.memberships).values([
      { id: memberId, workspaceId: owner.workspaceId, userId: member.userId, role: "member", status: "active", joinedAt: new Date() },
      { id: adminId, workspaceId: owner.workspaceId, userId: admin.userId, role: "admin", status: "active", joinedAt: new Date() },
      { id: coOwnerId, workspaceId: owner.workspaceId, userId: otherOwner.userId, role: "owner", status: "active", joinedAt: new Date() },
    ]);
    const [ownerMembership] = await db.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, owner.workspaceId), eq(schema.memberships.userId, owner.userId)));
    ownerId = ownerMembership!.id;
    const [otherMembership] = await db.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, otherOwner.workspaceId), eq(schema.memberships.userId, otherOwner.userId)));
    otherWorkspaceMemberId = otherMembership!.id;
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: owner.cookie, "x-workspace-id": owner.workspaceId }, payload: { name: "Role change denial key" } });
    expect(created.statusCode).toBe(201);
    apiKey = created.json().key;
  });

  beforeEach(async () => {
    await db.update(schema.memberships).set({ role: "member", status: "active", updatedAt: initialUpdatedAt }).where(eq(schema.memberships.id, memberId));
  });

  afterAll(async () => {
    await app?.close();
    for (const session of sessions) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    for (const session of sessions) {
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, session.userId));
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
    }
    await pool.end();
  });

  const changeRole = (caller: AuthenticatedSession, membershipId: string, role: unknown) => app.inject({
    method: "PATCH",
    url: `/v1/team/members/${membershipId}`,
    headers: { cookie: caller.cookie, "x-workspace-id": owner.workspaceId },
    payload: { role },
  });

  async function targetMembership() {
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.id, memberId));
    return membership!;
  }

  it("lets an owner promote a member to admin and demote them back", async () => {
    for (const role of ["admin", "member"] as const) {
      const response = await changeRole(owner, memberId, role);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: memberId, role });
      const membership = await targetMembership();
      expect(membership).toMatchObject({ id: memberId, workspaceId: owner.workspaceId, userId: member.userId, role, status: "active" });
      expect(membership.updatedAt.getTime()).toBeGreaterThan(initialUpdatedAt.getTime());
      const team = await app.inject({ method: "GET", url: "/v1/team", headers: { cookie: owner.cookie, "x-workspace-id": owner.workspaceId } });
      expect(team.statusCode).toBe(200);
      expect(team.json().members).toEqual(expect.arrayContaining([expect.objectContaining({ id: memberId, role })]));
    }
  });

  it.each(["admin", "member"] as const)("forbids a %s caller from changing roles", async (role) => {
    const response = await changeRole(role === "admin" ? admin : member, memberId, "admin");
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("Only workspace owners can complete this action.");
    expect(await targetMembership()).toMatchObject({ role: "member", updatedAt: initialUpdatedAt });
  });

  it("forbids changing another owner or the caller's own membership", async () => {
    for (const membershipId of [coOwnerId, ownerId]) {
      const response = await changeRole(owner, membershipId, "member");
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("The workspace owner's role cannot be changed.");
      const [unchanged] = await db.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId));
      expect(unchanged!.role).toBe("owner");
    }
  });

  it("returns the same 404 for unknown and other-workspace membership IDs", async () => {
    for (const membershipId of [randomUUID(), otherWorkspaceMemberId]) {
      const response = await changeRole(owner, membershipId, "admin");
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Workspace member not found.");
    }
    const [unchanged] = await db.select().from(schema.memberships).where(eq(schema.memberships.id, otherWorkspaceMemberId));
    expect(unchanged).toMatchObject({ workspaceId: otherOwner.workspaceId, role: "owner" });
  });

  it.each(["disabled", "invited"] as const)("returns 404 for an existing %s membership", async (status) => {
    await db.update(schema.memberships).set({ status }).where(eq(schema.memberships.id, memberId));
    expect((await changeRole(owner, memberId, "admin")).statusCode).toBe(404);
    expect(await targetMembership()).toMatchObject({ status, role: "member", updatedAt: initialUpdatedAt });
  });

  it.each(["owner", "invalid", "", null, 42])("rejects invalid role %j with 400", async (role) => {
    expect((await changeRole(owner, memberId, role)).statusCode).toBe(400);
    expect(await targetMembership()).toMatchObject({ role: "member", updatedAt: initialUpdatedAt });
  });

  it("rejects missing roles and malformed membership IDs with 400", async () => {
    expect((await changeRole(owner, memberId, undefined)).statusCode).toBe(400);
    expect((await changeRole(owner, "not-a-uuid", "admin")).statusCode).toBe(400);
    expect(await targetMembership()).toMatchObject({ role: "member", updatedAt: initialUpdatedAt });
  });

  it("blocks valid API keys from the role-change REST route", async () => {
    const response = await app.inject({ method: "PATCH", url: `/v1/team/members/${memberId}`, headers: { authorization: `Bearer ${apiKey}`, "x-workspace-id": owner.workspaceId }, payload: { role: "admin" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("API keys cannot access this route. Use a browser session.");
    expect(await targetMembership()).toMatchObject({ role: "member", updatedAt: initialUpdatedAt });
  });
});
