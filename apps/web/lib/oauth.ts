import { schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";

import { getDb } from "@/lib/db";

export const OAUTH_SCOPES = ["inboxjoy:read", "inboxjoy:write"] as const;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

export class OAuthRequestError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export type ValidatedAuthorizationRequest = {
  clientId: string;
  clientName: string;
  clientCreatedAt: Date;
  redirectUri: string;
  state: string | null;
  scopes: string[];
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  resource: string;
};

export function canonicalResource(): string {
  const origin = process.env.WEB_BASE_URL ?? "http://localhost:3000";
  return `${origin}/mcp`;
}

export function oauthError(error: string, errorDescription: string, status = 400): Response {
  return Response.json({ error, error_description: errorDescription }, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function expiresIn(seconds: number, from = new Date()): Date {
  return new Date(from.getTime() + seconds * 1000);
}

export function appendOAuthParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function validateRegistrationRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function normalizeScopes(scope: string | null): string[] {
  const requested = scope?.trim() ? scope.trim().split(/\s+/) : ["inboxjoy:read"];
  const unique = [...new Set(requested)];
  if (unique.some((item) => !OAUTH_SCOPES.includes(item as (typeof OAUTH_SCOPES)[number]))) {
    throw new OAuthRequestError("invalid_scope", "One or more requested scopes are not supported.");
  }
  return unique;
}

export async function validateAuthorizationRequest(searchParams: URLSearchParams): Promise<ValidatedAuthorizationRequest> {
  const clientId = searchParams.get("client_id")?.trim();
  const redirectUri = searchParams.get("redirect_uri");
  const responseType = searchParams.get("response_type");
  const codeChallenge = searchParams.get("code_challenge")?.trim();
  const codeChallengeMethod = searchParams.get("code_challenge_method");

  if (!clientId || !redirectUri) {
    throw new OAuthRequestError("invalid_request", "client_id and redirect_uri are required.");
  }

  const [client] = await getDb().select().from(schema.oauthClients).where(eq(schema.oauthClients.id, clientId)).limit(1);
  if (!client) throw new OAuthRequestError("invalid_request", "The OAuth client is not registered.");
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthRequestError("invalid_request", "redirect_uri does not match a registered redirect URI.");
  }
  if (responseType !== "code") {
    throw new OAuthRequestError("unsupported_response_type", "response_type must be code.");
  }
  if (!codeChallenge) {
    throw new OAuthRequestError("invalid_request", "code_challenge is required.");
  }
  if (codeChallengeMethod !== "S256") {
    throw new OAuthRequestError("invalid_request", "code_challenge_method must be S256.");
  }

  const requestedResource = searchParams.get("resource");
  if (requestedResource && requestedResource !== canonicalResource()) {
    throw new OAuthRequestError("invalid_target", "The requested resource is not served by this authorization server.");
  }

  const scopes = normalizeScopes(searchParams.get("scope"));
  return {
    clientId,
    clientName: client.clientName,
    clientCreatedAt: client.createdAt,
    redirectUri,
    state: searchParams.get("state"),
    scopes,
    scope: scopes.join(" "),
    codeChallenge,
    codeChallengeMethod: "S256",
    resource: requestedResource ?? canonicalResource(),
  };
}

export function oauthDiscoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    code_challenge_methods_supported: ["S256"],
    response_modes_supported: ["query"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    scopes_supported: [...OAUTH_SCOPES],
    token_endpoint_auth_methods_supported: ["none"],
  };
}
