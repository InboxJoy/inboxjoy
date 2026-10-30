import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveOAuthToken } from "../src/mcp-oauth.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("MCP OAuth membership gate", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const clientId = `billing-membership-gate-${randomUUID()}`;
  const token = `oauth_${randomUUID()}`;
  const canonicalResource = "https://app.example.test/mcp";
  const email = `billing-oauth-${randomUUID()}@example.test`;

  beforeAll(async () => {
    await db.insert(schema.users).values({
      id: userId,
      email,
      normalizedEmail: email,
    });
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: "OAuth membership gate",
      slug: `oauth-membership-${randomUUID().slice(0, 8)}`,
    });
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId, userId, role: "member", status: "active" });
    await db.insert(schema.oauthClients).values({
      id: clientId,
      clientName: "Billing-prefixed OAuth membership test",
      redirectUris: ["http://localhost:33418/callback"],
    });
    await db.insert(schema.mcpGrants).values({
      id: randomUUID(),
      userId,
      clientId,
      workspaceId,
      scopes: "inboxjoy:read",
    });
    await db.insert(schema.mcpOauthTokens).values({
      id: randomUUID(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      clientId,
      workspaceId,
      scopes: "inboxjoy:read",
      resource: canonicalResource,
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
    });
  });

  afterAll(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, clientId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it("stops resolving a token as soon as workspace membership is inactive", async () => {
    await expect(resolveOAuthToken(db, token, canonicalResource)).resolves.toMatchObject({ userId, workspaceId, clientId });

    await db.update(schema.memberships).set({ status: "disabled" }).where(eq(schema.memberships.workspaceId, workspaceId));

    await expect(resolveOAuthToken(db, token, canonicalResource)).resolves.toBeNull();
  });
});
