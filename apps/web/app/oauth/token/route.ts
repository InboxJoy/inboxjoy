import { schema } from "@inboxjoy/db";
import { and, eq, gt, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  canonicalResource,
  createPkceChallenge,
  expiresIn,
  generateOpaqueToken,
  hashOpaqueToken,
  oauthError,
  OAuthRequestError,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/oauth";

export const runtime = "nodejs";

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  scope: string;
};

// RFC 8707: when the client names a resource it must be the one we protect.
function requireCanonicalResource(params: URLSearchParams): string {
  const requested = params.get("resource");
  const canonical = canonicalResource();
  if (requested && requested !== canonical) {
    throw new OAuthRequestError("invalid_target", "The requested resource is not served by this authorization server.");
  }
  return canonical;
}

async function exchangeAuthorizationCode(params: URLSearchParams): Promise<TokenPair> {
  const code = params.get("code");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const verifier = params.get("code_verifier");
  if (!code || !clientId || !redirectUri || !verifier) {
    throw new OAuthRequestError("invalid_request", "code, client_id, redirect_uri, and code_verifier are required.");
  }
  const resource = requireCanonicalResource(params);

  const accessToken = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  const now = new Date();
  return getDb().transaction(async (tx) => {
    const [authorizationCode] = await tx.select().from(schema.mcpOauthCodes).where(eq(
      schema.mcpOauthCodes.codeHash,
      hashOpaqueToken(code),
    )).limit(1);

    if (!authorizationCode || authorizationCode.usedAt || authorizationCode.expiresAt <= now) {
      throw new OAuthRequestError("invalid_grant", "The authorization code is invalid, expired, or already used.");
    }
    if (authorizationCode.clientId !== clientId || authorizationCode.redirectUri !== redirectUri) {
      throw new OAuthRequestError("invalid_grant", "The authorization code does not match this client or redirect URI.");
    }
    if (createPkceChallenge(verifier) !== authorizationCode.codeChallenge) {
      throw new OAuthRequestError("invalid_grant", "PKCE verification failed.");
    }

    const [grant] = await tx.select({ id: schema.mcpGrants.id }).from(schema.mcpGrants).where(and(
      eq(schema.mcpGrants.userId, authorizationCode.userId),
      eq(schema.mcpGrants.clientId, authorizationCode.clientId),
      eq(schema.mcpGrants.workspaceId, authorizationCode.workspaceId),
      isNull(schema.mcpGrants.revokedAt),
    )).limit(1);
    if (!grant) throw new OAuthRequestError("invalid_grant", "The associated grant is no longer active.");

    const consumed = await tx.update(schema.mcpOauthCodes).set({ usedAt: now }).where(and(
      eq(schema.mcpOauthCodes.id, authorizationCode.id),
      isNull(schema.mcpOauthCodes.usedAt),
      gt(schema.mcpOauthCodes.expiresAt, now),
    )).returning({ id: schema.mcpOauthCodes.id });
    if (!consumed.length) throw new OAuthRequestError("invalid_grant", "The authorization code was already used.");

    await tx.insert(schema.mcpOauthTokens).values({
      tokenHash: hashOpaqueToken(accessToken),
      refreshTokenHash: hashOpaqueToken(refreshToken),
      userId: authorizationCode.userId,
      clientId: authorizationCode.clientId,
      workspaceId: authorizationCode.workspaceId,
      scopes: authorizationCode.scopes,
      resource: authorizationCode.resource ?? resource,
      expiresAt: expiresIn(ACCESS_TOKEN_TTL_SECONDS, now),
      refreshExpiresAt: expiresIn(REFRESH_TOKEN_TTL_SECONDS, now),
    });

    return { accessToken, refreshToken, scope: authorizationCode.scopes };
  });
}

async function rotateRefreshToken(params: URLSearchParams): Promise<TokenPair> {
  const refreshToken = params.get("refresh_token");
  const clientId = params.get("client_id");
  if (!refreshToken || !clientId) {
    throw new OAuthRequestError("invalid_request", "refresh_token and client_id are required.");
  }
  const resource = requireCanonicalResource(params);

  const nextAccessToken = generateOpaqueToken();
  const nextRefreshToken = generateOpaqueToken();
  const now = new Date();
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const db = getDb();

  const [token] = await db.select().from(schema.mcpOauthTokens).where(and(
    eq(schema.mcpOauthTokens.refreshTokenHash, refreshTokenHash),
    eq(schema.mcpOauthTokens.clientId, clientId),
  )).limit(1);
  if (!token) throw new OAuthRequestError("invalid_grant", "The refresh token is invalid or expired.");

  // A superseded or revoked refresh token being replayed means the token was
  // stolen at some point: kill the whole family for this grant. This runs
  // outside any transaction so the revocation survives the thrown error.
  const revokeFamily = () => db.update(schema.mcpOauthTokens).set({ revokedAt: now }).where(and(
    eq(schema.mcpOauthTokens.userId, token.userId),
    eq(schema.mcpOauthTokens.clientId, token.clientId),
    eq(schema.mcpOauthTokens.workspaceId, token.workspaceId),
    isNull(schema.mcpOauthTokens.revokedAt),
  ));
  if (token.supersededAt || token.revokedAt) {
    await revokeFamily();
    throw new OAuthRequestError("invalid_grant", "The refresh token was already used; all sessions for this connection have been revoked. Reconnect the app.");
  }
  if (token.refreshExpiresAt <= now) throw new OAuthRequestError("invalid_grant", "The refresh token is invalid or expired.");

  const [grant] = await db.select({ id: schema.mcpGrants.id }).from(schema.mcpGrants).where(and(
    eq(schema.mcpGrants.userId, token.userId),
    eq(schema.mcpGrants.clientId, token.clientId),
    eq(schema.mcpGrants.workspaceId, token.workspaceId),
    isNull(schema.mcpGrants.revokedAt),
  )).limit(1);
  if (!grant) throw new OAuthRequestError("invalid_grant", "The associated grant is no longer active.");

  const superseded = await db.update(schema.mcpOauthTokens).set({ supersededAt: now, revokedAt: now }).where(and(
    eq(schema.mcpOauthTokens.id, token.id),
    isNull(schema.mcpOauthTokens.supersededAt),
    isNull(schema.mcpOauthTokens.revokedAt),
  )).returning({ id: schema.mcpOauthTokens.id });
  if (!superseded.length) {
    // Lost a race with another rotation of the same token — treat as reuse.
    await revokeFamily();
    throw new OAuthRequestError("invalid_grant", "The refresh token was already used; all sessions for this connection have been revoked. Reconnect the app.");
  }

  await db.insert(schema.mcpOauthTokens).values({
    tokenHash: hashOpaqueToken(nextAccessToken),
    refreshTokenHash: hashOpaqueToken(nextRefreshToken),
    userId: token.userId,
    clientId: token.clientId,
    workspaceId: token.workspaceId,
    scopes: token.scopes,
    resource: token.resource ?? resource,
    expiresAt: expiresIn(ACCESS_TOKEN_TTL_SECONDS, now),
    refreshExpiresAt: expiresIn(REFRESH_TOKEN_TTL_SECONDS, now),
  });

  return { accessToken: nextAccessToken, refreshToken: nextRefreshToken, scope: token.scopes };
}

export async function POST(request: Request): Promise<Response> {
  const params = new URLSearchParams(await request.text());
  try {
    const grantType = params.get("grant_type");
    const pair = grantType === "authorization_code"
      ? await exchangeAuthorizationCode(params)
      : grantType === "refresh_token"
        ? await rotateRefreshToken(params)
        : null;
    if (!pair) return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");

    return Response.json({
      access_token: pair.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: pair.refreshToken,
      scope: pair.scope,
    }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
  } catch (error) {
    if (error instanceof OAuthRequestError) return oauthError(error.error, error.description, error.status);
    throw error;
  }
}
