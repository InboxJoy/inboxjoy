import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { provisionWorkspace } from "../src/auth.js";

const databaseUrl = process.env.DATABASE_URL;
const placeholderId = "00000000-0000-4000-8000-000000000002";
const bootstrapWorkspaceId = "00000000-0000-4000-8000-000000000001";
const ownerEmail = "hey@replyless.ai";

describe.skipIf(!databaseUrl)("0038 claim bootstrap owner migration", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);

  afterAll(async () => { await pool.end(); });

  it("gives the real account its profile, its own workspace and owner access to the bootstrap workspace", async () => {
    const migration = await readFile(new URL("../../../packages/db/migrations/0038_claim_bootstrap_owner.sql", import.meta.url), "utf8");
    const [placeholder] = await db.select().from(schema.users).where(eq(schema.users.id, placeholderId));
    const [bootstrap] = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, bootstrapWorkspaceId));
    const userId = randomUUID();
    await db.insert(schema.authUsers).values({ id: userId, name: "Hey Owner", email: ownerEmail, emailVerified: true });
    try {
      await pool.query(migration);
      await pool.query(migration);

      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      expect(user).toMatchObject({ email: ownerEmail, normalizedEmail: ownerEmail, displayName: "Hey Owner" });
      if (placeholder) {
        const [released] = await db.select().from(schema.users).where(eq(schema.users.id, placeholderId));
        expect(released!.normalizedEmail).toBe(`${ownerEmail}#unclaimed-${placeholderId}`);
      }

      // The SQL-built personal workspace must be the one provisionWorkspace resolves to.
      const personalWorkspaceId = await provisionWorkspace(db, { id: userId, name: "Hey Owner", email: ownerEmail });
      const created = await db.select().from(schema.workspaces).where(eq(schema.workspaces.createdByUserId, userId));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ id: personalWorkspaceId, name: "Hey Owner's workspace", slug: `hey-owner-${userId.replaceAll("-", "").slice(0, 12)}` });

      const memberships = await db.select({ workspaceId: schema.memberships.workspaceId, role: schema.memberships.role, status: schema.memberships.status })
        .from(schema.memberships).where(eq(schema.memberships.userId, userId));
      const expected = [{ workspaceId: personalWorkspaceId, role: "owner", status: "active" }];
      if (bootstrap) expected.push({ workspaceId: bootstrapWorkspaceId, role: "owner", status: "active" });
      expect(memberships).toEqual(expect.arrayContaining(expected));
      expect(memberships).toHaveLength(expected.length);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.createdByUserId, userId));
      await db.delete(schema.memberships).where(eq(schema.memberships.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
      if (placeholder) await db.update(schema.users).set({ normalizedEmail: placeholder.normalizedEmail }).where(and(eq(schema.users.id, placeholderId)));
    }
  });

  it("does nothing when that address has no sign-in account", async () => {
    const migration = await readFile(new URL("../../../packages/db/migrations/0038_claim_bootstrap_owner.sql", import.meta.url), "utf8");
    const before = await db.select().from(schema.users).where(eq(schema.users.id, placeholderId));
    await pool.query(migration);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, placeholderId))).toEqual(before);
  });
});
