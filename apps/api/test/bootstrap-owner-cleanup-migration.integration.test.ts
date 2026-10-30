import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const placeholderId = "00000000-0000-4000-8000-000000000002";
const bootstrapWorkspaceId = "00000000-0000-4000-8000-000000000001";
const bootstrapMembershipId = "00000000-0000-4000-8000-000000000003";
const seededEmail = "hey@replyless.ai";

function migrationSql(name: string) {
  return readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), "utf8");
}

describe.skipIf(!databaseUrl)("0043 remove unclaimed bootstrap owner migration", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const cleanups: Array<() => Promise<unknown>> = [];

  const seed = async () => pool.query(await migrationSql("0002_bootstrap_workspace.sql"));
  const runCleanup = async () => pool.query(await migrationSql("0043_remove_unclaimed_bootstrap_owner.sql"));
  const seededRows = async () => ({
    user: (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, placeholderId))).length,
    workspace: (await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, bootstrapWorkspaceId))).length,
    membership: (await db.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.id, bootstrapMembershipId))).length,
  });

  beforeEach(async () => {
    // Every test starts from the 0002 seed exactly as a fresh install has it.
    await seed();
    expect(await seededRows()).toEqual({ user: 1, workspace: 1, membership: 1 });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    // Leave the shared test database as migrations left it: no placeholder.
    await runCleanup();
  });

  afterAll(async () => { await pool.end(); });

  it("removes the never-claimed, empty placeholder owner, workspace and membership", async () => {
    await runCleanup();
    expect(await seededRows()).toEqual({ user: 0, workspace: 0, membership: 0 });

    // Idempotent: a second run (or a fresh database) has nothing to do.
    await runCleanup();
    expect(await seededRows()).toEqual({ user: 0, workspace: 0, membership: 0 });
  });

  it("is a no-op once the address was claimed by a real sign-in account (production)", async () => {
    const authUserId = randomUUID();
    await db.insert(schema.authUsers).values({ id: authUserId, name: "Hey Owner", email: seededEmail, emailVerified: true });
    cleanups.push(() => db.delete(schema.authUsers).where(eq(schema.authUsers.id, authUserId)));

    await runCleanup();
    expect(await seededRows()).toEqual({ user: 1, workspace: 1, membership: 1 });
  });

  it("keeps the workspace and its data when it holds a lead", async () => {
    const contactId = randomUUID();
    await db.insert(schema.contacts).values({ id: contactId, workspaceId: bootstrapWorkspaceId, email: "lead@example.test", normalizedEmail: "lead@example.test" });
    cleanups.push(() => db.delete(schema.contacts).where(eq(schema.contacts.id, contactId)));

    await runCleanup();
    expect(await seededRows()).toEqual({ user: 1, workspace: 1, membership: 1 });
    expect(await db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.id, contactId))).toHaveLength(1);
  });

  it("keeps the workspace when it has another member", async () => {
    const userId = randomUUID();
    await db.insert(schema.users).values({ id: userId, email: `member-${userId}@example.test`, normalizedEmail: `member-${userId}@example.test` });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: bootstrapWorkspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
    cleanups.push(() => db.delete(schema.users).where(eq(schema.users.id, userId)));

    await runCleanup();
    expect(await seededRows()).toEqual({ user: 1, workspace: 1, membership: 1 });
    expect(await db.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.userId, userId))).toHaveLength(1);
  });

  it("keeps everything when anything else references the seed, even a table not named in the migration", async () => {
    // Invitations are not in the migration's comment list; the catalog-driven
    // foreign-key check still finds them.
    const invitationId = randomUUID();
    await db.insert(schema.invitations).values({
      id: invitationId,
      workspaceId: bootstrapWorkspaceId,
      email: "invitee@example.test",
      normalizedEmail: "invitee@example.test",
      tokenHash: `cleanup-test-${invitationId}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedByUserId: placeholderId,
    });
    cleanups.push(() => db.delete(schema.invitations).where(eq(schema.invitations.id, invitationId)));

    await runCleanup();
    expect(await seededRows()).toEqual({ user: 1, workspace: 1, membership: 1 });
  });

  it("keeps the placeholder profile when it is referenced from another workspace", async () => {
    const otherWorkspaceId = randomUUID();
    await db.insert(schema.workspaces).values({ id: otherWorkspaceId, name: "Other", slug: `other-${otherWorkspaceId}`, createdByUserId: placeholderId });
    cleanups.push(() => db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId)));

    await runCleanup();
    expect(await seededRows()).toEqual({ user: 1, workspace: 1, membership: 1 });
    expect(await db.select({ createdByUserId: schema.workspaces.createdByUserId }).from(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId)))
      .toEqual([{ createdByUserId: placeholderId }]);
  });
});
