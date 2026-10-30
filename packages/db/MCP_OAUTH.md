# MCP OAuth database contract

The web service issues opaque OAuth access tokens. The Fastify MCP server must never query by the raw Bearer token and must never treat an OAuth token as a JWT.

## Access-token validation

1. Read the raw Bearer token from the `Authorization` header.
2. Compute its lowercase SHA-256 hexadecimal digest.
3. Look up that digest in `mcp_oauth_tokens.token_hash`.
4. Require `mcp_oauth_tokens.revoked_at IS NULL` and `mcp_oauth_tokens.expires_at > now()`.
5. Join an active `mcp_grants` row on all three subject columns: `user_id`, `client_id`, and `workspace_id`.
6. Require `mcp_grants.revoked_at IS NULL`.
7. Use `mcp_oauth_tokens.workspace_id`, `mcp_oauth_tokens.user_id`, and `mcp_oauth_tokens.client_id` as the authenticated context.
8. Enforce `mcp_oauth_tokens.scopes`, which records the scopes actually granted when the token was issued. Do not substitute `mcp_grants.scopes` for authorization checks.

`mcp_oauth_tokens.workspace_id` is intentionally included in addition to the original token-table brief. It binds every token to the selected workspace and makes the grant join unambiguous.

```sql
SELECT
  token.id,
  token.workspace_id,
  token.user_id,
  token.client_id,
  token.scopes
FROM mcp_oauth_tokens AS token
JOIN mcp_grants AS grant
  ON grant.user_id = token.user_id
 AND grant.client_id = token.client_id
 AND grant.workspace_id = token.workspace_id
 AND grant.revoked_at IS NULL
WHERE token.token_hash = $1
  AND token.revoked_at IS NULL
  AND token.expires_at > now()
LIMIT 1;
```

Bind `$1` to `sha256(raw_bearer_token)` encoded as lowercase hexadecimal. A missing row means the request is unauthenticated. The equivalent web implementation is `validateAccessToken` in `apps/web/lib/oauth-tokens.ts`.

## Revocation behavior

- RFC 7009 revocation sets `mcp_oauth_tokens.revoked_at` for the matching access-token or refresh-token hash owned by the supplied public `client_id`.
- User-initiated disconnection sets `mcp_grants.revoked_at` and revokes all token rows matching the same `user_id`, `client_id`, and `workspace_id`.
- The grant join is still mandatory even when `mcp_oauth_tokens.revoked_at` is null. It makes grant revocation immediately authoritative if token-row revocation is delayed or interrupted.

## Issuance details

- Access tokens expire one hour after issuance.
- Refresh tokens expire 30 days after issuance or rotation.
- Refresh tokens rotate by replacing both hashes on the existing `mcp_oauth_tokens` row, invalidating the previous access token and refresh token together.
- Authorization codes expire after 60 seconds, store only `code_hash`, and become unusable after `used_at` is set.
- Active grants are reused for the same `user_id`, `client_id`, and `workspace_id`; the partial unique index `mcp_grants_active_subject_idx` prevents duplicate active grants.
