import { schema } from "@inboxjoy/db";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  appendOAuthParams,
  generateOpaqueToken,
  hashOpaqueToken,
  oauthError,
  OAuthRequestError,
  validateAuthorizationRequest,
} from "@/lib/oauth";
import { rejectCrossSiteRequest, verifyConsentToken, webOrigin } from "@/lib/oauth-consent";
import { getCurrentUser } from "@/lib/server-auth";

export const runtime = "nodejs";

// The configured public origin; never the request's Host header (see lib/oauth-consent.ts).
function publicOrigin(): string {
  return webOrigin();
}

function loginRedirect(search: string): Response {
  const loginUrl = new URL("/app/login", publicOrigin());
  loginUrl.searchParams.set("next", `/app/mcp/authorize${search}`);
  return Response.redirect(loginUrl, 302);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    await validateAuthorizationRequest(url.searchParams);
  } catch (error) {
    if (error instanceof OAuthRequestError) return oauthError(error.error, error.description, error.status);
    throw error;
  }

  const user = await getCurrentUser(request);
  if (!user) return loginRedirect(url.search);
  return Response.redirect(new URL(`/app/mcp/authorize${url.search}`, publicOrigin()), 302);
}

export async function POST(request: Request): Promise<Response> {
  // CSRF check 1 of 2: the consent form must be submitted from this site.
  const crossSite = rejectCrossSiteRequest(request);
  if (crossSite) return crossSite;

  const form = await request.formData();
  const searchParams = new URLSearchParams();
  for (const key of ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource"]) {
    const value = form.get(key);
    if (typeof value === "string") searchParams.set(key, value);
  }

  let authorization;
  try {
    authorization = await validateAuthorizationRequest(searchParams);
  } catch (error) {
    if (error instanceof OAuthRequestError) return oauthError(error.error, error.description, error.status);
    throw error;
  }

  const user = await getCurrentUser(request);
  if (!user) return loginRedirect(`?${searchParams.toString()}`);

  if (form.get("decision") === "deny") {
    return Response.redirect(appendOAuthParams(authorization.redirectUri, {
      iss: publicOrigin(),
      error: "access_denied",
      state: authorization.state,
    }), 302);
  }

  if (form.get("decision") !== "approve") {
    return oauthError("invalid_request", "A consent decision is required.");
  }

  const workspaceId = form.get("workspace_id");
  if (typeof workspaceId !== "string" || !workspaceId) {
    return oauthError("invalid_request", "A workspace must be selected.");
  }

  // CSRF check 2 of 2: the approval must carry the token minted when the consent page was
  // rendered, signed over the user, client, PKCE challenge, redirect URI and workspace. Any
  // field that differs from what the user saw, or a token older than ten minutes, is rejected.
  const consentTokenValid = verifyConsentToken(form.get(`consent_token_${workspaceId}`), {
    userId: user.userId,
    clientId: authorization.clientId,
    codeChallenge: authorization.codeChallenge,
    redirectUri: authorization.redirectUri,
    workspaceId,
  });
  if (!consentTokenValid) {
    return oauthError("invalid_request", "The consent form has expired or was altered. Please start the connection again.", 403);
  }

  const db = getDb();
  const [membership] = await db.select({ workspaceId: schema.memberships.workspaceId }).from(schema.memberships).where(and(
    eq(schema.memberships.userId, user.userId),
    eq(schema.memberships.workspaceId, workspaceId),
    eq(schema.memberships.status, "active"),
  )).limit(1);
  if (!membership) return oauthError("invalid_request", "The selected workspace is not available to this user.");

  const code = generateOpaqueToken();
  await db.transaction(async (tx) => {
    await tx.insert(schema.mcpGrants).values({
      userId: user.userId,
      clientId: authorization.clientId,
      workspaceId,
      scopes: authorization.scope,
    }).onConflictDoNothing();
    await tx.update(schema.mcpGrants).set({ scopes: authorization.scope }).where(and(
      eq(schema.mcpGrants.userId, user.userId),
      eq(schema.mcpGrants.clientId, authorization.clientId),
      eq(schema.mcpGrants.workspaceId, workspaceId),
      isNull(schema.mcpGrants.revokedAt),
    ));

    await tx.insert(schema.mcpOauthCodes).values({
      codeHash: hashOpaqueToken(code),
      clientId: authorization.clientId,
      userId: user.userId,
      workspaceId,
      redirectUri: authorization.redirectUri,
      scopes: authorization.scope,
      codeChallenge: authorization.codeChallenge,
      codeChallengeMethod: authorization.codeChallengeMethod,
      resource: authorization.resource,
    });
  });

  return Response.redirect(appendOAuthParams(authorization.redirectUri, {
    iss: publicOrigin(),
    code,
    state: authorization.state,
  }), 302);
}
