// Table/column names follow packages/db/MCP_OAUTH.md and migration 0013_mcp_oauth.sql on feat/mcp-oauth.
// mcp_oauth_tokens.{user_id,client_id,scopes} and mcp_grants.{user_id,client_id,scopes} are `text` columns
// (scopes is a single space-delimited string, not a Postgres array). mcp_oauth_tokens also carries its own
// workspace_id (uuid, NOT NULL) — the join to mcp_grants must include it (user_id + client_id + workspace_id)
// and the authenticated context must use the TOKEN's workspace_id, not the grant's, per the contract.
import type { InboxJoyDb } from "@inboxjoy/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";

export type OAuthIdentity = {
  userId: string;
  workspaceId: string;
  scopes: string[];
  clientId: string;
};

function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  return [];
}

export async function resolveOAuthToken(db: InboxJoyDb, bearerToken: string, canonicalResource: string): Promise<OAuthIdentity | null> {
  if (!bearerToken) return null;
  const tokenHash = createHash("sha256").update(bearerToken).digest("hex");
  const result = await db.execute<{ userId: string; workspaceId: string; scopes: unknown; clientId: string }>(sql`
    SELECT
      tokens.user_id AS "userId",
      tokens.workspace_id AS "workspaceId",
      tokens.scopes AS "scopes",
      tokens.client_id AS "clientId"
    FROM mcp_oauth_tokens AS tokens
    INNER JOIN mcp_grants AS grants
      ON grants.user_id = tokens.user_id
      AND grants.client_id = tokens.client_id
      AND grants.workspace_id = tokens.workspace_id
    INNER JOIN memberships
      ON memberships.user_id::text = tokens.user_id
      AND memberships.workspace_id = tokens.workspace_id
      AND memberships.status = 'active'
    WHERE tokens.token_hash = ${tokenHash}
      AND tokens.revoked_at IS NULL
      AND tokens.expires_at > now()
      AND grants.revoked_at IS NULL
      AND (tokens.resource IS NULL OR tokens.resource = ${canonicalResource})
    LIMIT 1
  `);

  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.userId, workspaceId: row.workspaceId, clientId: row.clientId, scopes: parseScopes(row.scopes) };
}
