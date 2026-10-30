import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("settings API", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "settings-test-auth-secret-at-least-32-characters" });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: AuthenticatedSession;
  let invitee: AuthenticatedSession;
  let otherOwner: AuthenticatedSession;
  const cleanupWorkspaceIds = new Set<string>();

  beforeAll(async () => {
    app = await buildApp({ env, db });
    owner = await createAuthenticatedSession(app, "Settings Owner");
    invitee = await createAuthenticatedSession(app, "Settings Invitee");
    otherOwner = await createAuthenticatedSession(app, "Other Owner");
    cleanupWorkspaceIds.add(owner.workspaceId);
    cleanupWorkspaceIds.add(invitee.workspaceId);
    cleanupWorkspaceIds.add(otherOwner.workspaceId);
  });

  afterAll(async () => {
    for (const workspaceId of cleanupWorkspaceIds) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await app?.close();
    await pool.end();
  });

  it("updates workspace settings and returns mailbox health", async () => {
    const mailboxId = randomUUID();
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId: owner.workspaceId, userId: owner.userId, provider: "gmail", composioConnectedAccountId: `settings-${mailboxId}`, email: owner.email, normalizedEmail: owner.email, alias: `settings-${mailboxId.slice(0, 8)}`, status: "active", dailyLimit: 40 });
    await db.insert(schema.mailboxHealth).values({ id: randomUUID(), workspaceId: owner.workspaceId, emailAccountId: mailboxId, state: "healthy", bounceRate: "1.25", replyRate: "8.50", effectiveDailyLimit: 32, lastSuccessfulSendAt: new Date("2026-08-31T12:00:00.000Z") });

    const updated = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: owner.cookie }, payload: { name: "Updated workspace", defaultTimezone: "America/New_York", dailySendCap: 450, killSwitchEnabled: true, postalAddress: "456 Market St\nSan Francisco, CA 94105" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().workspace).toMatchObject({ name: "Updated workspace", defaultTimezone: "America/New_York", dailySendCap: 450, killSwitchEnabled: true });

    const sending = await app.inject({ method: "GET", url: "/v1/sending", headers: { cookie: owner.cookie } });
    expect(sending.statusCode).toBe(200);
    expect(sending.json().mailboxes).toEqual(expect.arrayContaining([expect.objectContaining({ id: mailboxId, healthState: "healthy", bounceRate: 1.25, replyRate: 8.5, effectiveDailyLimit: 32 })]));
  });

  it("keeps open tracking off until the workspace turns it on", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: owner.cookie } })).json().workspace.openTrackingEnabled).toBe(false);
    expect((await app.inject({ method: "GET", url: "/v1/sending", headers: { cookie: owner.cookie } })).json().workspace.openTrackingEnabled).toBe(false);

    const enabled = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: owner.cookie }, payload: { openTrackingEnabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().workspace.openTrackingEnabled).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/sending", headers: { cookie: owner.cookie } })).json().workspace.openTrackingEnabled).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: otherOwner.cookie } })).json().workspace.openTrackingEnabled).toBe(false);

    const disabled = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: owner.cookie }, payload: { openTrackingEnabled: false } });
    expect(disabled.json().workspace.openTrackingEnabled).toBe(false);
  });

  it("deletes a mailbox from every list while keeping its row for send history", async () => {
    const mailboxId = randomUUID();
    await db.insert(schema.emailAccounts).values({ id: mailboxId, workspaceId: owner.workspaceId, userId: owner.userId, provider: "gmail", composioConnectedAccountId: `delete-${mailboxId}`, email: `delete-${mailboxId.slice(0, 8)}@example.test`, normalizedEmail: `delete-${mailboxId.slice(0, 8)}@example.test`, alias: `delete-${mailboxId.slice(0, 8)}`, status: "disconnected" });

    // Another workspace cannot see or delete it.
    expect((await app.inject({ method: "DELETE", url: `/v1/inboxes/${mailboxId}`, headers: { cookie: otherOwner.cookie } })).statusCode).toBe(404);

    const deleted = await app.inject({ method: "DELETE", url: `/v1/inboxes/${mailboxId}`, headers: { cookie: owner.cookie } });
    expect(deleted.statusCode).toBe(204);

    const [row] = await db.select({ status: schema.emailAccounts.status }).from(schema.emailAccounts).where(eq(schema.emailAccounts.id, mailboxId));
    expect(row?.status).toBe("removed");

    const inboxes = await app.inject({ method: "GET", url: "/v1/inboxes", headers: { cookie: owner.cookie } });
    expect(inboxes.statusCode).toBe(200);
    expect(inboxes.json().inboxes.map((inbox: { id: string }) => inbox.id)).not.toContain(mailboxId);

    const sending = await app.inject({ method: "GET", url: "/v1/sending", headers: { cookie: owner.cookie } });
    expect(sending.json().mailboxes.map((mailbox: { id: string }) => mailbox.id)).not.toContain(mailboxId);

    // Deleting again is a clean 404, not an error.
    expect((await app.inject({ method: "DELETE", url: `/v1/inboxes/${mailboxId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(404);
  });

  it("creates, lists, scopes, and revokes API keys", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: owner.cookie }, payload: { name: "Settings key" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().key).toMatch(/^ij_/);
    expect(created.json().apiKey).not.toHaveProperty("keyHash");
    const keyId = created.json().apiKey.id as string;

    const listed = await app.inject({ method: "GET", url: "/v1/api-keys", headers: { cookie: owner.cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().apiKeys).toEqual(expect.arrayContaining([expect.objectContaining({ id: keyId, name: "Settings key" })]));
    expect(listed.body).not.toContain("keyHash");

    expect((await app.inject({ method: "DELETE", url: `/v1/api-keys/${keyId}`, headers: { cookie: otherOwner.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/api-keys/${keyId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(204);
  });

  it("enforces invitation email, accepts the invite, and restricts member actions", async () => {
    const invitation = await app.inject({ method: "POST", url: "/v1/team/invitations", headers: { cookie: owner.cookie }, payload: { email: invitee.email, role: "member" } });
    expect(invitation.statusCode).toBe(201);
    const token = invitation.json().token as string;

    const wrongUser = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: otherOwner.cookie }, payload: { token } });
    expect(wrongUser.statusCode).toBe(403);

    const accepted = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: invitee.cookie }, payload: { token } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, workspaceId: owner.workspaceId });

    const [membership] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.workspaceId, owner.workspaceId), eq(schema.memberships.userId, invitee.userId)));
    expect(membership).toMatchObject({ role: "member", status: "active" });
    const team = await app.inject({ method: "GET", url: "/v1/team", headers: { cookie: owner.cookie } });
    expect(team.json().members).toEqual(expect.arrayContaining([expect.objectContaining({ email: invitee.email, role: "member" })]));

    expect((await app.inject({ method: "POST", url: "/v1/team/invitations", headers: { cookie: invitee.cookie }, payload: { email: `blocked-${randomUUID()}@example.com`, role: "member" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: invitee.cookie }, payload: { name: "Blocked key" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/v1/team/members/${membership!.id}`, headers: { cookie: invitee.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/v1/workspace", headers: { cookie: invitee.cookie }, payload: { confirmation: "Updated workspace" } })).statusCode).toBe(403);
    const inboxMutations = [
      { method: "POST" as const, url: "/v1/inboxes/connect-link", payload: { provider: "gmail" } },
      { method: "POST" as const, url: `/v1/inboxes/${randomUUID()}/pause` },
      { method: "POST" as const, url: `/v1/inboxes/${randomUUID()}/resume` },
      { method: "POST" as const, url: `/v1/inboxes/${randomUUID()}/disconnect` },
      { method: "DELETE" as const, url: `/v1/inboxes/${randomUUID()}` },
      { method: "POST" as const, url: `/v1/inboxes/${randomUUID()}/reconnect` },
      { method: "PATCH" as const, url: `/v1/inboxes/${randomUUID()}/settings`, payload: { dailyLimit: 10 } },
      { method: "PUT" as const, url: `/v1/inboxes/${randomUUID()}/schedules`, payload: { schedules: [] } },
    ];
    for (const mutation of inboxMutations) {
      const response = await app.inject({ ...mutation, headers: { cookie: invitee.cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "Only workspace owners and admins can manage inboxes." });
    }
  });

  it("revokes invitations only inside the owner's workspace", async () => {
    const invitation = await app.inject({ method: "POST", url: "/v1/team/invitations", headers: { cookie: owner.cookie }, payload: { email: `pending-${randomUUID()}@example.com`, role: "admin" } });
    expect(invitation.statusCode).toBe(201);
    const invitationId = invitation.json().invitation.id as string;
    expect((await app.inject({ method: "DELETE", url: `/v1/team/invitations/${invitationId}`, headers: { cookie: otherOwner.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/team/invitations/${invitationId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(204);
  });

  it("keeps kill-switch and deletion changes tenant scoped", async () => {
    const otherBefore = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: otherOwner.cookie } });
    const otherName = otherBefore.json().workspace.name as string;
    expect((await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: invitee.cookie }, payload: { killSwitchEnabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: owner.cookie }, payload: { killSwitchEnabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: otherOwner.cookie } })).json().workspace.killSwitchEnabled).toBe(false);
    expect((await app.inject({ method: "DELETE", url: "/v1/workspace", headers: { cookie: otherOwner.cookie }, payload: { confirmation: "Updated workspace" } })).statusCode).toBe(400);
    expect((await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, owner.workspaceId)))).toHaveLength(1);

    const disposable = await createAuthenticatedSession(app, "Disposable Workspace");
    cleanupWorkspaceIds.add(disposable.workspaceId);
    const workspace = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: disposable.cookie } });
    const deleted = await app.inject({ method: "DELETE", url: "/v1/workspace", headers: { cookie: disposable.cookie }, payload: { confirmation: workspace.json().workspace.name } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deleted: true, workspaceId: disposable.workspaceId });
    expect((await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, disposable.workspaceId)))).toHaveLength(0);
    expect(otherName).not.toBe("Updated workspace");
  });

  it("keeps the founder stop out of reach of PATCH /v1/workspace", async () => {
    const paused = await createAuthenticatedSession(app, "Founder Paused");
    cleanupWorkspaceIds.add(paused.workspaceId);
    // What the founder stop writes.
    await db.update(schema.workspaces).set({ status: "paused" }).where(eq(schema.workspaces.id, paused.workspaceId));

    // The owner may still change their own settings, but status is not theirs to edit.
    const attempt = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: paused.cookie }, payload: { status: "active", killSwitchEnabled: false, name: "Still paused" } });
    expect(attempt.statusCode).toBe(200);
    expect(attempt.json().workspace).toMatchObject({ status: "paused", killSwitchEnabled: false, name: "Still paused" });
    const [row] = await db.select({ status: schema.workspaces.status }).from(schema.workspaces).where(eq(schema.workspaces.id, paused.workspaceId));
    expect(row?.status).toBe("paused");

    // A body that only tries to flip status is an empty update, not a resume.
    expect((await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: paused.cookie }, payload: { status: "active" } })).statusCode).toBe(400);
  });

  it("closes admin-only operations to API keys while the owner session still succeeds", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: owner.cookie }, payload: { name: "Admin boundary key" } });
    expect(created.statusCode).toBe(201);
    const key = { authorization: `Bearer ${created.json().key as string}` };
    const forbidden = { error: "API keys cannot access this route. Use a browser session." };

    const suppressionId = randomUUID();
    const suppressedEmail = `suppressed-${suppressionId.slice(0, 8)}@example.test`;
    await db.insert(schema.suppressions).values({ id: suppressionId, workspaceId: owner.workspaceId, email: suppressedEmail, normalizedEmail: suppressedEmail, emailHash: suppressionId, reason: "manual", source: "test", createdByUserId: owner.userId });
    const sequenceId = randomUUID();
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId: owner.workspaceId, name: "Key boundary sequence", status: "draft", createdByUserId: owner.userId });

    const removeSuppression = await app.inject({ method: "DELETE", url: `/v1/suppressions/${suppressionId}`, headers: key });
    expect(removeSuppression.statusCode).toBe(403);
    expect(removeSuppression.json()).toMatchObject(forbidden);
    expect(await db.select({ id: schema.suppressions.id }).from(schema.suppressions).where(eq(schema.suppressions.id, suppressionId))).toHaveLength(1);

    const deleteSequence = await app.inject({ method: "DELETE", url: `/v1/sequences/${sequenceId}`, headers: key });
    expect(deleteSequence.statusCode).toBe(403);
    expect(deleteSequence.json()).toMatchObject(forbidden);
    expect(await db.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId))).toHaveLength(1);

    for (const payload of [{ killSwitchEnabled: true }, { dailySendCap: 100_000 }, { name: "Renamed by key", killSwitchEnabled: false }]) {
      const response = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: key, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject(forbidden);
    }
    const before = (await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: owner.cookie } })).json().workspace;
    expect(before).toMatchObject({ killSwitchEnabled: false, dailySendCap: 450 });

    // Identity fields stay open to keys; the key still works for ordinary routes.
    const renamed = await app.inject({ method: "PATCH", url: "/v1/workspace", headers: key, payload: { name: "Renamed by key" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().workspace).toMatchObject({ name: "Renamed by key", killSwitchEnabled: false, dailySendCap: 450 });
    expect((await app.inject({ method: "GET", url: "/v1/suppressions", headers: key })).statusCode).toBe(200);

    // The owner's browser session is unaffected.
    expect((await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: owner.cookie }, payload: { killSwitchEnabled: true, dailySendCap: 300 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/v1/workspace", headers: { cookie: owner.cookie }, payload: { killSwitchEnabled: false, dailySendCap: 450, name: "Updated workspace" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/suppressions/${suppressionId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/v1/sequences/${sequenceId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(204);
    expect(await db.select({ id: schema.suppressions.id }).from(schema.suppressions).where(eq(schema.suppressions.id, suppressionId))).toHaveLength(0);
    expect(await db.select({ id: schema.sequences.id }).from(schema.sequences).where(eq(schema.sequences.id, sequenceId))).toHaveLength(0);
  });
});
