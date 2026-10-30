import { loadAppEnv } from "@inboxjoy/config";
import { operationByName, runOperation } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService, type TransactionalEmailService, type WorkspaceInviteEmailInput } from "@inboxjoy/email";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("workspace switching and invitation email API", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    AUTH_SECRET: "workspace-switch-test-auth-secret-at-least-32-characters",
    LOG_LEVEL: "silent",
  });
  const sendWorkspaceInvite = vi.fn<(input: WorkspaceInviteEmailInput) => Promise<void>>();
  const transactionalEmail: TransactionalEmailService = { ...disabledTransactionalEmailService, enabled: true, sendWorkspaceInvite };
  const sessions: AuthenticatedSession[] = [];
  const oauthClientIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;
  let user: AuthenticatedSession;
  let otherOwner: AuthenticatedSession;

  beforeEach(async () => {
    sendWorkspaceInvite.mockReset().mockResolvedValue(undefined);
    app = await buildApp({ env, db, transactionalEmail });
    user = await createAuthenticatedSession(app, "Workspace User");
    sessions.push(user);
    otherOwner = await createAuthenticatedSession(app, "Other Workspace Owner");
    sessions.push(otherOwner);
    await db.update(schema.workspaces).set({ name: "Alpha workspace" }).where(eq(schema.workspaces.id, user.workspaceId));
    await db.update(schema.workspaces).set({ name: "Zulu workspace" }).where(eq(schema.workspaces.id, otherOwner.workspaceId));
    await db.update(schema.memberships).set({ joinedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.workspaceId, user.workspaceId)));
  });

  afterEach(async () => { await app?.close(); });

  afterAll(async () => {
    for (const clientId of oauthClientIds) await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, clientId));
    for (const session of sessions) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    for (const session of sessions) {
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, session.userId));
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
    }
    await pool.end();
  });

  async function addOtherMembership(status: "active" | "disabled" | "invited" = "active") {
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: otherOwner.workspaceId, userId: user.userId, role: "member", status, joinedAt: new Date("2026-02-01T00:00:00.000Z") });
  }

  async function activePreference() {
    const [row] = await db.select({ activeWorkspaceId: schema.users.activeWorkspaceId }).from(schema.users).where(eq(schema.users.id, user.userId));
    return row!.activeWorkspaceId;
  }

  async function switchWorkspace(workspaceId: string) {
    return app.inject({ method: "POST", url: "/v1/workspaces/switch", headers: { cookie: user.cookie }, payload: { workspaceId } });
  }

  async function invite(email = `invite-${randomUUID()}@example.test`, role: "member" | "admin" = "member") {
    return app.inject({ method: "POST", url: "/v1/team/invitations", headers: { cookie: otherOwner.cookie }, payload: { email, role } });
  }

  it("keeps null-preference users on their most recently joined active workspace", async () => {
    await addOtherMembership();
    expect(await activePreference()).toBeNull();
    const response = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().workspace.id).toBe(otherOwner.workspaceId);
    const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers: { cookie: user.cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ workspaces: [
      { id: user.workspaceId, name: "Alpha workspace", role: "owner", isCurrent: false },
      { id: otherOwner.workspaceId, name: "Zulu workspace", role: "member", isCurrent: true },
    ] });
  });

  it("persists switching to an older workspace and keeps the other workspace's data isolated", async () => {
    await addOtherMembership();
    const ownContactId = randomUUID();
    const otherContactId = randomUUID();
    await db.insert(schema.contacts).values([
      { id: ownContactId, workspaceId: user.workspaceId, email: "own@example.test", normalizedEmail: "own@example.test" },
      { id: otherContactId, workspaceId: otherOwner.workspaceId, email: "other@example.test", normalizedEmail: "other@example.test" },
    ]);
    const switched = await switchWorkspace(user.workspaceId);
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({ workspaceId: user.workspaceId });
    expect(await activePreference()).toBe(user.workspaceId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const leads = await app.inject({ method: "GET", url: "/v1/leads", headers: { cookie: user.cookie } });
      expect(leads.statusCode).toBe(200);
      expect(leads.json()).toMatchObject({ workspaceId: user.workspaceId, leads: [{ id: ownContactId }] });
    }
    expect((await app.inject({ method: "GET", url: `/v1/leads/${otherContactId}`, headers: { cookie: user.cookie } })).statusCode).toBe(404);
    const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers: { cookie: user.cookie } });
    expect(listed.json().workspaces.map((workspace: { isCurrent: boolean }) => workspace.isCurrent)).toEqual([true, false]);
    const [membership] = await db.select({ joinedAt: schema.memberships.joinedAt }).from(schema.memberships)
      .where(and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.workspaceId, user.workspaceId)));
    expect(membership!.joinedAt!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("pins each tab's reads, writes, and current membership to its workspace header", async () => {
    await addOtherMembership();
    expect((await switchWorkspace(otherOwner.workspaceId)).statusCode).toBe(200);
    const ownContactId = randomUUID();
    const otherContactId = randomUUID();
    await db.insert(schema.contacts).values([
      { id: ownContactId, workspaceId: user.workspaceId, email: "tab-own@example.test", normalizedEmail: "tab-own@example.test" },
      { id: otherContactId, workspaceId: otherOwner.workspaceId, email: "tab-other@example.test", normalizedEmail: "tab-other@example.test" },
    ]);

    for (const [workspaceId, role, contactId] of [
      [user.workspaceId, "owner", ownContactId],
      [otherOwner.workspaceId, "member", otherContactId],
    ] as const) {
      const headers = { cookie: user.cookie, "x-workspace-id": workspaceId };
      const workspace = await app.inject({ method: "GET", url: "/v1/workspace", headers });
      expect(workspace.statusCode).toBe(200);
      expect(workspace.json()).toMatchObject({ workspace: { id: workspaceId }, role });
      const leads = await app.inject({ method: "GET", url: "/v1/leads", headers });
      expect(leads.statusCode).toBe(200);
      expect(leads.json()).toMatchObject({ workspaceId, leads: [{ id: contactId }] });
      expect(leads.json().leads).toHaveLength(1);
      const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().workspaces.filter((membership: { isCurrent: boolean }) => membership.isCurrent))
        .toEqual([expect.objectContaining({ id: workspaceId, role })]);
    }

    const headers = { cookie: user.cookie, "x-workspace-id": user.workspaceId };
    expect((await app.inject({ method: "GET", url: `/v1/leads/${otherContactId}`, headers })).statusCode).toBe(404);
    const updated = await app.inject({ method: "PATCH", url: "/v1/workspace", headers, payload: { dailySendCap: 37 } });
    expect(updated.statusCode).toBe(200);
    const [ownWorkspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, user.workspaceId));
    const [otherWorkspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, otherOwner.workspaceId));
    expect(ownWorkspace!.dailySendCap).toBe(37);
    expect(otherWorkspace!.dailySendCap).toBe(200);
    expect(await activePreference()).toBe(otherOwner.workspaceId);
    const defaultWorkspace = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(defaultWorkspace.statusCode).toBe(200);
    expect(defaultWorkspace.json()).toMatchObject({ workspace: { id: otherOwner.workspaceId }, role: "member" });
  });

  it("uses the pinned membership's role for owner-only operations", async () => {
    await addOtherMembership();
    expect((await switchWorkspace(user.workspaceId)).statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: user.cookie, "x-workspace-id": otherOwner.workspaceId }, payload: { name: "Member key" } });
    expect(denied.statusCode).toBe(403);
    const otherKeys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, otherOwner.workspaceId));
    expect(otherKeys).toHaveLength(0);
    const allowed = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId }, payload: { name: "Owner key" } });
    expect(allowed.statusCode).toBe(201);
    const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, allowed.json().apiKey.id));
    expect(key!.workspaceId).toBe(user.workspaceId);
  });

  it.each(["unrelated", "missing", "malformed", "empty", "multiple"] as const)("rejects a %s workspace header before writes", async (kind) => {
    expect((await switchWorkspace(user.workspaceId)).statusCode).toBe(200);
    const workspaceId = kind === "unrelated" ? otherOwner.workspaceId : kind === "missing" ? randomUUID()
      : kind === "empty" ? "" : kind === "multiple" ? `${user.workspaceId}, ${otherOwner.workspaceId}` : "invalid-uuid";
    const response = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: user.cookie, "x-workspace-id": workspaceId }, payload: { dailySendCap: 99 } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Your workspace changed. Reload to continue.", code: "workspace_changed", correlationId: response.headers["x-correlation-id"] });
    for (const workspaceId of [user.workspaceId, otherOwner.workspaceId]) {
      const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      expect(workspace!.dailySendCap).toBe(200);
    }
    expect(await activePreference()).toBe(user.workspaceId);
  });

  it.each(["disabled", "invited", "removed", "deleted"] as const)("rejects a pinned workspace after its membership is %s", async (state) => {
    await addOtherMembership();
    expect((await switchWorkspace(user.workspaceId)).statusCode).toBe(200);
    const membership = and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.workspaceId, otherOwner.workspaceId));
    if (state === "removed") await db.delete(schema.memberships).where(membership);
    else if (state === "deleted") await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherOwner.workspaceId));
    else await db.update(schema.memberships).set({ status: state }).where(membership);
    const response = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: user.cookie, "x-workspace-id": otherOwner.workspaceId }, payload: { dailySendCap: 99 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("workspace_changed");
    const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, user.workspaceId));
    expect(workspace!.dailySendCap).toBe(200);
    expect(await activePreference()).toBe(user.workspaceId);
  });

  it("rejects the previous user's tab pin after another user signs in", async () => {
    const response = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: otherOwner.cookie, "x-workspace-id": user.workspaceId }, payload: { dailySendCap: 99 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("workspace_changed");
    const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, otherOwner.workspaceId));
    expect(workspace!.dailySendCap).toBe(200);
  });

  it("reserves membership self-healing for requests using the server default", async () => {
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, user.userId));
    const pinned = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId }, payload: { dailySendCap: 99 } });
    expect(pinned.statusCode).toBe(409);
    expect(pinned.json().code).toBe("workspace_changed");
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.userId))).toHaveLength(0);
    const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, user.workspaceId));
    expect(workspace!.dailySendCap).toBe(200);
    const recovered = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ workspace: { id: user.workspaceId }, role: "owner" });
  });

  it.each(["disabled", "invited"] as const)("does not grant owner access when self-healing conflicts with an existing %s membership", async (status) => {
    await db.update(schema.memberships).set({ status, role: "member" }).where(eq(schema.memberships.userId, user.userId));
    const response = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "No active workspace membership found." });
    const memberships = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ workspaceId: user.workspaceId, role: "member", status });
  });

  it("allows the workspace header in cross-origin browser requests", async () => {
    const response = await app.inject({ method: "OPTIONS", url: "/v1/workspace", headers: {
      origin: env.WEB_BASE_URL,
      "access-control-request-method": "PATCH",
      "access-control-request-headers": "content-type,x-workspace-id",
    } });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]).toContain("x-workspace-id");
  });

  it("returns the same 404 for unrelated and nonexistent workspaces without changing preference", async () => {
    expect((await switchWorkspace(user.workspaceId)).statusCode).toBe(200);
    const unrelated = await switchWorkspace(otherOwner.workspaceId);
    const missing = await switchWorkspace(randomUUID());
    expect(unrelated.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(unrelated.json().error).toBe(missing.json().error);
    expect(await activePreference()).toBe(user.workspaceId);
  });

  it("does not list or switch to disabled or invited memberships", async () => {
    await addOtherMembership("disabled");
    for (const status of ["disabled", "invited"] as const) {
      await db.update(schema.memberships).set({ status }).where(and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.workspaceId, otherOwner.workspaceId)));
      expect((await switchWorkspace(otherOwner.workspaceId)).statusCode).toBe(404);
      const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers: { cookie: user.cookie } });
      expect(listed.json().workspaces).toEqual([{ id: user.workspaceId, name: "Alpha workspace", role: "owner", isCurrent: true }]);
    }
    expect(await activePreference()).toBeNull();
  });

  it("falls back without a 403 after the selected membership is removed", async () => {
    await addOtherMembership();
    expect((await switchWorkspace(user.workspaceId)).statusCode).toBe(200);
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.workspaceId, user.workspaceId)));
    const response = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().workspace.id).toBe(otherOwner.workspaceId);
    expect(await activePreference()).toBe(user.workspaceId);
  });

  it("falls back after the preferred membership is disabled or workspace is deleted", async () => {
    await addOtherMembership();
    expect((await switchWorkspace(otherOwner.workspaceId)).statusCode).toBe(200);
    await db.update(schema.memberships).set({ status: "disabled" }).where(and(eq(schema.memberships.userId, user.userId), eq(schema.memberships.workspaceId, otherOwner.workspaceId)));
    const disabled = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().workspace.id).toBe(user.workspaceId);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherOwner.workspaceId));
    expect(await activePreference()).toBeNull();
    const deleted = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().workspace.id).toBe(user.workspaceId);
  });

  it("blocks API keys from workspace switching while leaving singular workspace access pinned", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: user.cookie }, payload: { name: "Workspace key" } });
    expect(created.statusCode).toBe(201);
    const headers = { authorization: `Bearer ${created.json().key}`, "x-workspace-id": "invalid-uuid" };
    await addOtherMembership();
    expect((await switchWorkspace(otherOwner.workspaceId)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/workspaces", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/workspaces/switch", headers, payload: { workspaceId: user.workspaceId } })).statusCode).toBe(403);
    expect(await activePreference()).toBe(otherOwner.workspaceId);
    // Sending controls are closed to keys; identity fields stay open and land on
    // the key's own workspace, never the browser-preferred one.
    expect((await app.inject({ method: "PATCH", url: "/v1/workspace", headers, payload: { dailySendCap: 33 } })).statusCode).toBe(403);
    const updated = await app.inject({ method: "PATCH", url: "/v1/workspace", headers, payload: { name: "Key pinned rename" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().workspace).toMatchObject({ id: user.workspaceId, name: "Key pinned rename", dailySendCap: 200 });
    const leads = await app.inject({ method: "GET", url: "/v1/leads", headers });
    expect(leads.json().workspaceId).toBe(user.workspaceId);
    const [otherWorkspace] = await db.select({ name: schema.workspaces.name, dailySendCap: schema.workspaces.dailySendCap }).from(schema.workspaces).where(eq(schema.workspaces.id, otherOwner.workspaceId));
    expect(otherWorkspace).toMatchObject({ name: "Zulu workspace", dailySendCap: 200 });
  });

  it("keeps MCP OAuth bearers pinned to the token workspace with a malformed browser header", async () => {
    await addOtherMembership();
    expect((await switchWorkspace(otherOwner.workspaceId)).statusCode).toBe(200);
    const clientId = `workspace-pin-${randomUUID()}`;
    oauthClientIds.push(clientId);
    await db.insert(schema.oauthClients).values({ id: clientId, clientName: "Workspace pin test", redirectUris: ["http://localhost:33418/callback"] });
    await db.insert(schema.mcpGrants).values({ id: randomUUID(), userId: user.userId, clientId, workspaceId: user.workspaceId, scopes: "inboxjoy:read" });
    const token = `workspace-token-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(schema.mcpOauthTokens).values({
      id: randomUUID(), tokenHash: createHash("sha256").update(token).digest("hex"), userId: user.userId,
      clientId, workspaceId: user.workspaceId, scopes: "inboxjoy:read", expiresAt, refreshExpiresAt: expiresAt,
    });
    const response = await app.inject({ method: "POST", url: "/mcp", headers: {
      authorization: `Bearer ${token}`, "x-workspace-id": "invalid-uuid", accept: "application/json, text/event-stream",
    }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inboxjoy_leads_list", arguments: {} } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.isError).not.toBe(true);
    expect(JSON.parse(response.json().result.content[0].text).workspaceId).toBe(user.workspaceId);
  });

  it("sets the accepting user's preferred workspace in the invitation acceptance transaction", async () => {
    expect((await switchWorkspace(user.workspaceId)).statusCode).toBe(200);
    const invitation = await invite(user.email);
    expect(invitation.statusCode).toBe(201);
    const accepted = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId }, payload: { token: invitation.json().token } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, workspaceId: otherOwner.workspaceId });
    expect(await activePreference()).toBe(otherOwner.workspaceId);
    const current = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(current.json().workspace.id).toBe(otherOwner.workspaceId);
  });

  it("lets an invitee without any active membership preview and accept, even with a stale tab pin", async () => {
    const invitation = await invite(user.email, "admin");
    const token = invitation.json().token as string;
    await db.update(schema.memberships).set({ status: "disabled", role: "member" }).where(eq(schema.memberships.userId, user.userId));
    expect((await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } })).statusCode).toBe(403);

    const preview = await app.inject({ method: "GET", url: `/v1/team/invitations/preview?token=${encodeURIComponent(token)}`, headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ status: "pending", workspaceId: otherOwner.workspaceId, workspaceName: "Zulu workspace", inviterName: "Other Workspace Owner", role: "admin", invitedEmail: user.email });

    const accepted = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId }, payload: { token } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, workspaceId: otherOwner.workspaceId });
    const current = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: user.cookie } });
    expect(current.json()).toMatchObject({ workspace: { id: otherOwner.workspaceId }, role: "admin" });

    const after = await app.inject({ method: "GET", url: `/v1/team/invitations/preview?token=${encodeURIComponent(token)}`, headers: { cookie: user.cookie } });
    expect(after.json().status).toBe("member");
  });

  it("holds a matching invitation as verify_email until the invitee's email is verified", async () => {
    const invitation = await invite(user.email);
    expect(invitation.statusCode).toBe(201);
    const token = invitation.json().token as string;
    const previewUrl = `/v1/team/invitations/preview?token=${encodeURIComponent(token)}`;
    // Signup does not require verification, so this is the state of anyone who
    // registered with the invitee's address after seeing the invite.
    await db.update(schema.authUsers).set({ emailVerified: false }).where(eq(schema.authUsers.id, user.userId));

    const preview = await app.inject({ method: "GET", url: previewUrl, headers: { cookie: user.cookie } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ status: "verify_email", invitedEmail: user.email, signedInEmail: user.email, workspaceId: otherOwner.workspaceId });

    const refused = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: user.cookie }, payload: { token } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "verify_email", error: expect.stringContaining("Verify your email") });
    expect(await db.select({ id: schema.memberships.id }).from(schema.memberships).where(and(eq(schema.memberships.workspaceId, otherOwner.workspaceId), eq(schema.memberships.userId, user.userId)))).toHaveLength(0);

    await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, user.userId));
    expect((await app.inject({ method: "GET", url: previewUrl, headers: { cookie: user.cookie } })).json().status).toBe("pending");
    const accepted = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: user.cookie }, payload: { token } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, workspaceId: otherOwner.workspaceId });
  });

  it("previews an invitation sent to another address as wrong_email and rejects unknown tokens", async () => {
    const invitation = await invite();
    const preview = await app.inject({ method: "GET", url: `/v1/team/invitations/preview?token=${encodeURIComponent(invitation.json().token)}`, headers: { cookie: user.cookie } });
    expect(preview.json()).toMatchObject({ status: "wrong_email", signedInEmail: user.email });
    const unknown = await app.inject({ method: "GET", url: `/v1/team/invitations/preview?token=${otherOwner.workspaceId}.${"x".repeat(43)}`, headers: { cookie: user.cookie } });
    expect(unknown.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/team/invitations/preview?token=${encodeURIComponent(invitation.json().token)}` })).statusCode).toBe(401);
  });

  it("sends one invitation email with the recipient, names, role, URL, and persisted expiry", async () => {
    const recipient = `recipient-${randomUUID()}@example.test`;
    sendWorkspaceInvite.mockImplementation(async (input) => {
      const stored = await db.select({ id: schema.invitations.id }).from(schema.invitations).where(and(eq(schema.invitations.workspaceId, otherOwner.workspaceId), eq(schema.invitations.email, input.recipient.email)));
      expect(stored).toHaveLength(1);
    });
    const response = await invite(recipient, "admin");
    expect(response.statusCode).toBe(201);
    expect(response.json().emailSent).toBe(true);
    expect(sendWorkspaceInvite).toHaveBeenCalledTimes(1);
    expect(sendWorkspaceInvite).toHaveBeenCalledWith({ recipient: { email: recipient }, inviterName: "Other Workspace Owner", workspaceName: "Zulu workspace", role: "admin", acceptUrl: `${env.WEB_BASE_URL}/app/invite/${response.json().token}`, expiresAt: new Date(response.json().invitation.expiresAt) });
  });

  it("keeps a committed invitation successful when the email service throws", async () => {
    sendWorkspaceInvite.mockRejectedValue(new Error("Email provider unavailable"));
    const response = await invite();
    expect(response.statusCode).toBe(201);
    expect(response.json().emailSent).toBe(false);
    expect(sendWorkspaceInvite).toHaveBeenCalledTimes(1);
    const stored = await db.select().from(schema.invitations).where(eq(schema.invitations.id, response.json().invitation.id));
    expect(stored).toHaveLength(1);
    expect(response.json().token).toBeTruthy();
  });

  it("skips email when transactional email is disabled", async () => {
    await app.close();
    app = await buildApp({ env, db, transactionalEmail: { ...disabledTransactionalEmailService, sendWorkspaceInvite } });
    const response = await invite();
    expect(response.statusCode).toBe(201);
    expect(response.json().emailSent).toBe(false);
    expect(sendWorkspaceInvite).not.toHaveBeenCalled();
  });

  it("skips email when an operation context has no web URL or email service", async () => {
    for (const missing of ["webBaseUrl", "transactionalEmail"] as const) {
      const result = await runOperation(operationByName.get("team.invite")!, {
        db,
        workspaceId: otherOwner.workspaceId,
        userId: otherOwner.userId,
        env: { edition: "selfhost", authSecret: env.AUTH_SECRET!, apiBaseUrl: env.API_BASE_URL, webBaseUrl: missing === "webBaseUrl" ? undefined : env.WEB_BASE_URL },
        transactionalEmail: missing === "transactionalEmail" ? undefined : transactionalEmail,
      }, { email: `${missing}-${randomUUID()}@example.test`, role: "member" });
      expect(result.emailSent).toBe(false);
      const stored = await db.select({ id: schema.invitations.id }).from(schema.invitations).where(eq(schema.invitations.id, result.invitation.id));
      expect(stored).toHaveLength(1);
    }
    expect(sendWorkspaceInvite).not.toHaveBeenCalled();
  });

  it("rejects a 21st open invitation and allows replacing an invitation at the cap", async () => {
    const emails = Array.from({ length: 20 }, (_, index) => `cap-${index}-${randomUUID()}@example.test`);
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);
    await db.insert(schema.invitations).values(emails.map((email) => ({ id: randomUUID(), workspaceId: otherOwner.workspaceId, email, normalizedEmail: email, role: "member" as const, tokenHash: randomUUID(), expiresAt, invitedByUserId: otherOwner.userId })));
    await db.insert(schema.invitations).values([
      { id: randomUUID(), workspaceId: otherOwner.workspaceId, email: "expired@example.test", normalizedEmail: "expired@example.test", tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 1_000) },
      { id: randomUUID(), workspaceId: otherOwner.workspaceId, email: "accepted@example.test", normalizedEmail: "accepted@example.test", tokenHash: randomUUID(), expiresAt, acceptedAt: new Date() },
    ]);
    const blocked = await invite();
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("20 open invitations");
    expect(sendWorkspaceInvite).not.toHaveBeenCalled();
    const existing = await db.select({ id: schema.invitations.id }).from(schema.invitations).where(and(eq(schema.invitations.workspaceId, otherOwner.workspaceId), eq(schema.invitations.normalizedEmail, emails[0]!)));
    const replaced = await invite(emails[0]!.toUpperCase(), "admin");
    expect(replaced.statusCode).toBe(201);
    expect(replaced.json().invitation.id).not.toBe(existing[0]!.id);
    expect(replaced.json().invitation.role).toBe("admin");
    expect(replaced.json().emailSent).toBe(true);
    expect(sendWorkspaceInvite).toHaveBeenCalledTimes(1);
    const invitations = await db.select().from(schema.invitations).where(eq(schema.invitations.workspaceId, otherOwner.workspaceId));
    expect(invitations.filter((invitation) => !invitation.acceptedAt && invitation.expiresAt > new Date())).toHaveLength(20);
  });

  it("rate limits invitation creation to ten requests per minute", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await invite("reinvited@example.test")).statusCode).toBe(201);
    }
    expect((await invite("rate-limited@example.test")).statusCode).toBe(429);
    expect(sendWorkspaceInvite).toHaveBeenCalledTimes(10);
  });

  it("serializes concurrent invitation creation at the workspace cap", async () => {
    await db.insert(schema.invitations).values(Array.from({ length: 19 }, (_, index) => {
      const email = `concurrent-${index}-${randomUUID()}@example.test`;
      return { id: randomUUID(), workspaceId: otherOwner.workspaceId, email, normalizedEmail: email, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 7 * 86_400_000) };
    }));
    const responses = await Promise.all([invite(), invite()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const stored = await db.select({ id: schema.invitations.id }).from(schema.invitations).where(eq(schema.invitations.workspaceId, otherOwner.workspaceId));
    expect(stored).toHaveLength(20);
    expect(sendWorkspaceInvite).toHaveBeenCalledTimes(1);
  });
});
