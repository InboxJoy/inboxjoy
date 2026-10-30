import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OpError, operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

// Signup does not require email verification, so an invitation must not be
// accepted on an email-string match alone: whoever saw the invite could register
// as the invitee first. Preview reports `verify_email`; accept refuses with the
// same code until auth_users.email_verified is true.
describe.skipIf(!databaseUrl)("team invitations require a verified email", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  let ownerId: string;
  let workspaceId: string;
  let inviteeId: string;
  let inviteeWorkspaceId: string;
  let inviteeEmail: string;

  function context(userId: string, contextWorkspaceId: string): OperationContext {
    return { db, workspaceId: contextWorkspaceId, userId, env: {
      edition: "selfhost",
      authSecret: "team-invite-verification-test-secret-at-least-32-characters",
      apiBaseUrl: "https://api.example.test",
    } };
  }

  async function run(name: string, ctx: OperationContext, input: unknown) {
    const operation = operationByName.get(name);
    if (!operation) throw new Error(`Missing operation ${name}`);
    return runOperation(operation, ctx, input);
  }

  async function createUser(label: string, emailVerified: boolean) {
    const userId = randomUUID();
    const userWorkspaceId = randomUUID();
    const email = `${label.toLowerCase().replace(/\s+/g, "-")}-${userId}@example.com`;
    await db.insert(schema.authUsers).values({ id: userId, name: label, email, emailVerified });
    await db.insert(schema.users).values({ id: userId, email, normalizedEmail: email, displayName: label });
    await db.insert(schema.workspaces).values({ id: userWorkspaceId, name: `${label} workspace`, slug: userWorkspaceId, createdByUserId: userId });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: userWorkspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    return { userId, workspaceId: userWorkspaceId, email };
  }

  async function inviteeMembership() {
    return db.select({ id: schema.memberships.id, role: schema.memberships.role, status: schema.memberships.status }).from(schema.memberships)
      .where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, inviteeId)));
  }

  beforeAll(async () => { await pool.query("select 1"); });

  beforeEach(async () => {
    const owner = await createUser("Inviting owner", true);
    ownerId = owner.userId;
    workspaceId = owner.workspaceId;
    const invitee = await createUser("Unverified invitee", false);
    inviteeId = invitee.userId;
    inviteeWorkspaceId = invitee.workspaceId;
    inviteeEmail = invitee.email;
  });

  afterEach(async () => {
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [workspaceId, inviteeWorkspaceId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, inviteeId]));
    await db.delete(schema.authUsers).where(inArray(schema.authUsers.id, [ownerId, inviteeId]));
  });

  afterAll(async () => { await pool.end(); });

  it("reports verify_email and refuses acceptance until the matching invitee verifies", async () => {
    const invited = await run("team.invite", context(ownerId, workspaceId), { email: inviteeEmail, role: "admin" }) as { token: string };
    const invitee = context(inviteeId, inviteeWorkspaceId);

    await expect(run("team.invitePreview", invitee, { token: invited.token })).resolves.toMatchObject({
      status: "verify_email", workspaceId, role: "admin", invitedEmail: inviteeEmail, signedInEmail: inviteeEmail,
    });

    const refused = await run("team.inviteAccept", invitee, { token: invited.token }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(OpError);
    expect(refused).toMatchObject({ code: "FORBIDDEN", details: { code: "verify_email" } });
    expect(await inviteeMembership()).toHaveLength(0);
    const [invitation] = await db.select({ acceptedAt: schema.invitations.acceptedAt }).from(schema.invitations).where(eq(schema.invitations.workspaceId, workspaceId));
    expect(invitation?.acceptedAt).toBeNull();

    await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, inviteeId));

    await expect(run("team.invitePreview", invitee, { token: invited.token })).resolves.toMatchObject({ status: "pending" });
    await expect(run("team.inviteAccept", invitee, { token: invited.token })).resolves.toEqual({ accepted: true, workspaceId });
    expect(await inviteeMembership()).toEqual([expect.objectContaining({ role: "admin", status: "active" })]);
  });

  it("keeps wrong_email ahead of verification when the signed-in address differs", async () => {
    const invited = await run("team.invite", context(ownerId, workspaceId), { email: `someone-else-${randomUUID()}@example.com` }) as { token: string };
    const invitee = context(inviteeId, inviteeWorkspaceId);

    await expect(run("team.invitePreview", invitee, { token: invited.token })).resolves.toMatchObject({ status: "wrong_email", signedInEmail: inviteeEmail });
    const refused = await run("team.inviteAccept", invitee, { token: invited.token }).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: "FORBIDDEN", message: "This invitation was sent to a different email address." });
    expect((refused as OpError).details).toBeUndefined();
    expect(await inviteeMembership()).toHaveLength(0);
  });

  it("lets only a verified owner create an invitation", async () => {
    // The invitee owns their own workspace but has not verified their address.
    const refused = await run("team.invite", context(inviteeId, inviteeWorkspaceId), { email: `teammate-${randomUUID()}@example.com` }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(OpError);
    expect(refused).toMatchObject({ code: "FORBIDDEN", details: { code: "email_unverified" } });
    expect(await db.select({ id: schema.invitations.id }).from(schema.invitations).where(eq(schema.invitations.workspaceId, inviteeWorkspaceId))).toHaveLength(0);

    await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, inviteeId));
    await expect(run("team.invite", context(inviteeId, inviteeWorkspaceId), { email: `teammate-${randomUUID()}@example.com` })).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("treats a profile without an auth account as unverified", async () => {
    const invited = await run("team.invite", context(ownerId, workspaceId), { email: inviteeEmail }) as { token: string };
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, inviteeId));
    const invitee = context(inviteeId, inviteeWorkspaceId);

    await expect(run("team.invitePreview", invitee, { token: invited.token })).resolves.toMatchObject({ status: "verify_email" });
    const refused = await run("team.inviteAccept", invitee, { token: invited.token }).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: "FORBIDDEN", details: { code: "verify_email" } });
    expect(await inviteeMembership()).toHaveLength(0);
  });
});
