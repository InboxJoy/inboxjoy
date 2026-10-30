import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { operationByName, runOperation, type OperationContext } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe.skipIf(!databaseUrl)("tenant operation security", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);

  beforeAll(async () => {
    await pool.query("select 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("does not remove a foreign contact from its lists", async () => {
    const userId = randomUUID();
    const foreignUserId = randomUUID();
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const contactId = randomUUID();
    const listId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const context: OperationContext = {
      db,
      workspaceId,
      userId,
      env: { edition: "selfhost", authSecret: "tenant-security-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" },
    };

    try {
      await db.insert(schema.users).values([
        { id: userId, email: `tenant-${suffix}@example.com`, normalizedEmail: `tenant-${suffix}@example.com` },
        { id: foreignUserId, email: `tenant-foreign-${suffix}@example.com`, normalizedEmail: `tenant-foreign-${suffix}@example.com` },
      ]);
      await db.insert(schema.workspaces).values([
        { id: workspaceId, name: `Tenant ${suffix}`, slug: `tenant-${suffix}`, createdByUserId: userId },
        { id: foreignWorkspaceId, name: `Foreign tenant ${suffix}`, slug: `tenant-foreign-${suffix}`, createdByUserId: foreignUserId },
      ]);
      await db.insert(schema.contacts).values({ id: contactId, workspaceId: foreignWorkspaceId, email: `foreign-${suffix}@example.com`, normalizedEmail: `foreign-${suffix}@example.com` });
      await db.insert(schema.contactLists).values({ id: listId, workspaceId: foreignWorkspaceId, name: "Foreign list", createdByUserId: foreignUserId });
      await db.insert(schema.contactListMembers).values({ workspaceId: foreignWorkspaceId, contactListId: listId, contactId, addedByUserId: foreignUserId });

      await expect(runOperation(operation("leads.delete"), context, { ids: [contactId] })).resolves.toEqual({ deleted: 0, skipped: 1 });
      await expect(db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId))).resolves.toHaveLength(1);
      await expect(db.select().from(schema.contactListMembers).where(and(eq(schema.contactListMembers.contactListId, listId), eq(schema.contactListMembers.contactId, contactId)))).resolves.toHaveLength(1);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, foreignWorkspaceId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.users).where(eq(schema.users.id, foreignUserId));
    }
  });

  it("does not let setLeadVariables touch another workspace's sequence or contacts", async () => {
    const userId = randomUUID();
    const foreignUserId = randomUUID();
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const sequenceId = randomUUID();
    const foreignSequenceId = randomUUID();
    const contactId = randomUUID();
    const foreignContactId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const context: OperationContext = {
      db,
      workspaceId,
      userId,
      env: { edition: "selfhost", authSecret: "tenant-security-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" },
    };

    try {
      await db.insert(schema.users).values([
        { id: userId, email: `lv-tenant-${suffix}@example.com`, normalizedEmail: `lv-tenant-${suffix}@example.com` },
        { id: foreignUserId, email: `lv-foreign-${suffix}@example.com`, normalizedEmail: `lv-foreign-${suffix}@example.com` },
      ]);
      await db.insert(schema.workspaces).values([
        { id: workspaceId, name: `LV tenant ${suffix}`, slug: `lv-tenant-${suffix}`, createdByUserId: userId },
        { id: foreignWorkspaceId, name: `LV foreign ${suffix}`, slug: `lv-foreign-${suffix}`, createdByUserId: foreignUserId },
      ]);
      await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "owner", status: "active", joinedAt: new Date() });
      await db.insert(schema.sequences).values([
        { id: sequenceId, workspaceId, name: "Own sequence", status: "draft" },
        { id: foreignSequenceId, workspaceId: foreignWorkspaceId, name: "Foreign sequence", status: "draft" },
      ]);
      await db.insert(schema.contacts).values([
        { id: contactId, workspaceId, email: `own-${suffix}@example.com`, normalizedEmail: `own-${suffix}@example.com` },
        { id: foreignContactId, workspaceId: foreignWorkspaceId, email: `foreign-${suffix}@example.com`, normalizedEmail: `foreign-${suffix}@example.com` },
      ]);

      await expect(runOperation(operation("campaigns.setLeadVariables"), context, { sequenceId: foreignSequenceId, leads: [{ contactId, variables: { icebreaker: "x" } }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(runOperation(operation("campaigns.setLeadVariables"), context, { sequenceId, leads: [{ contactId: foreignContactId, variables: { icebreaker: "x" } }] })).resolves.toMatchObject({ updated: 0, notFound: [foreignContactId] });
      await expect(db.select().from(schema.campaignLeadVariables).where(inArray(schema.campaignLeadVariables.sequenceId, [sequenceId, foreignSequenceId]))).resolves.toHaveLength(0);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, foreignWorkspaceId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.users).where(eq(schema.users.id, foreignUserId));
    }
  });

  it("revokes a removed member's MCP grant and tokens atomically", async () => {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const workspaceId = randomUUID();
    const membershipId = randomUUID();
    const clientId = `member-remove-${randomUUID()}`;
    const grantId = randomUUID();
    const tokenId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const context: OperationContext = {
      db,
      workspaceId,
      userId: ownerId,
      env: { edition: "selfhost", authSecret: "member-remove-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" },
    };

    try {
      await db.insert(schema.users).values([
        { id: ownerId, email: `remove-owner-${suffix}@example.com`, normalizedEmail: `remove-owner-${suffix}@example.com` },
        { id: memberId, email: `remove-member-${suffix}@example.com`, normalizedEmail: `remove-member-${suffix}@example.com` },
      ]);
      await db.insert(schema.workspaces).values({ id: workspaceId, name: `Remove member ${suffix}`, slug: `remove-member-${suffix}`, createdByUserId: ownerId });
      await db.insert(schema.memberships).values([
        { id: randomUUID(), workspaceId, userId: ownerId, role: "owner", status: "active", joinedAt: new Date() },
        { id: membershipId, workspaceId, userId: memberId, role: "member", status: "active", joinedAt: new Date() },
      ]);
      await db.insert(schema.oauthClients).values({ id: clientId, clientName: "Member removal test", redirectUris: ["http://localhost:33418/callback"] });
      await db.insert(schema.mcpGrants).values({ id: grantId, userId: memberId, clientId, workspaceId, scopes: "inboxjoy:read inboxjoy:write" });
      await db.insert(schema.mcpOauthTokens).values({
        id: tokenId,
        tokenHash: `token-${randomUUID()}`,
        refreshTokenHash: `refresh-${randomUUID()}`,
        userId: memberId,
        clientId,
        workspaceId,
        scopes: "inboxjoy:read inboxjoy:write",
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
      });

      await expect(runOperation(operation("team.memberRemove"), context, { id: membershipId })).resolves.toEqual({ removed: true });

      await expect(db.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId))).resolves.toHaveLength(0);
      const [grant] = await db.select({ revokedAt: schema.mcpGrants.revokedAt }).from(schema.mcpGrants).where(eq(schema.mcpGrants.id, grantId));
      const [token] = await db.select({ revokedAt: schema.mcpOauthTokens.revokedAt }).from(schema.mcpOauthTokens).where(eq(schema.mcpOauthTokens.id, tokenId));
      expect(grant?.revokedAt).toBeInstanceOf(Date);
      expect(token?.revokedAt).toBeInstanceOf(Date);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, clientId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerId));
      await db.delete(schema.users).where(eq(schema.users.id, memberId));
    }
  });
});
