import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, gt, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { hashOpaqueToken } from "@/lib/oauth";

export type ValidatedAccessToken = {
  tokenId: string;
  workspaceId: string;
  scopes: string;
  userId: string;
  clientId: string;
};

export async function validateAccessToken(token: string, db: InboxJoyDb = getDb()): Promise<ValidatedAccessToken | null> {
  if (!token) return null;

  const [result] = await db.select({
    tokenId: schema.mcpOauthTokens.id,
    workspaceId: schema.mcpOauthTokens.workspaceId,
    scopes: schema.mcpOauthTokens.scopes,
    userId: schema.mcpOauthTokens.userId,
    clientId: schema.mcpOauthTokens.clientId,
  }).from(schema.mcpOauthTokens).innerJoin(schema.mcpGrants, and(
    eq(schema.mcpGrants.userId, schema.mcpOauthTokens.userId),
    eq(schema.mcpGrants.clientId, schema.mcpOauthTokens.clientId),
    eq(schema.mcpGrants.workspaceId, schema.mcpOauthTokens.workspaceId),
    isNull(schema.mcpGrants.revokedAt),
  )).where(and(
    eq(schema.mcpOauthTokens.tokenHash, hashOpaqueToken(token)),
    isNull(schema.mcpOauthTokens.revokedAt),
    gt(schema.mcpOauthTokens.expiresAt, new Date()),
  )).limit(1);

  return result ?? null;
}
