import { schema } from "@inboxjoy/db";
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { oauthError, validateRegistrationRedirectUri } from "@/lib/oauth";

export const runtime = "nodejs";

const REGISTRATIONS_PER_HOUR = 10;
const REGISTRATION_WINDOW_MS = 3_600_000;
const registrationHits = new Map<string, number[]>();
let lastEvictionAt = Date.now();

// Drop addresses with no hits inside the window so the map stays bounded by recent traffic
// instead of growing with every address ever seen. Runs at most once per window.
function evictStaleRegistrationHits(now: number): void {
  if (now - lastEvictionAt < REGISTRATION_WINDOW_MS) return;
  lastEvictionAt = now;
  for (const [ip, hits] of registrationHits) {
    const recent = hits.filter((t) => now - t < REGISTRATION_WINDOW_MS);
    if (recent.length) registrationHits.set(ip, recent);
    else registrationHits.delete(ip);
  }
}

function registrationAllowed(ip: string): boolean {
  const now = Date.now();
  evictStaleRegistrationHits(now);
  const hits = (registrationHits.get(ip) ?? []).filter((t) => now - t < REGISTRATION_WINDOW_MS);
  if (hits.length >= REGISTRATIONS_PER_HOUR) { registrationHits.set(ip, hits); return false; }
  hits.push(now);
  registrationHits.set(ip, hits);
  return true;
}

type RegistrationRequest = {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!registrationAllowed(ip)) {
    return Response.json({ error: "invalid_client_metadata", error_description: "Too many client registrations from this address. Try again later." }, { status: 429, headers: { "retry-after": "3600" } });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "The registration body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return oauthError("invalid_client_metadata", "The registration body must be a JSON object.");
  }
  const body = parsed as RegistrationRequest;

  const clientName = typeof body.client_name === "string" ? body.client_name.trim() : "";
  const rawRedirectUris = body.redirect_uris;
  const redirectUris = Array.isArray(rawRedirectUris)
    ? rawRedirectUris.filter((uri): uri is string => typeof uri === "string")
    : [];
  const authMethod = body.token_endpoint_auth_method ?? "none";

  if (!clientName || clientName.length > 200) {
    return oauthError("invalid_client_metadata", "client_name is required and must be 200 characters or fewer.");
  }
  if (!Array.isArray(rawRedirectUris) || !redirectUris.length || redirectUris.length !== rawRedirectUris.length) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of absolute URLs.");
  }
  if (redirectUris.some((uri) => !validateRegistrationRedirectUri(uri))) {
    return oauthError("invalid_redirect_uri", "Redirect URIs must use HTTPS, or HTTP on localhost or 127.0.0.1.");
  }
  if (new Set(redirectUris).size !== redirectUris.length) {
    return oauthError("invalid_redirect_uri", "redirect_uris must not contain duplicates.");
  }
  if (authMethod !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients using token_endpoint_auth_method none are supported.");
  }

  const clientId = randomUUID();
  const [client] = await getDb().insert(schema.oauthClients).values({
    id: clientId,
    clientName,
    redirectUris,
    tokenEndpointAuthMethod: "none",
  }).returning();
  if (!client) throw new Error("OAuth client registration did not return the inserted row");

  return Response.json({
    client_id: client.id,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "inboxjoy:read inboxjoy:write",
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  }, { status: 201, headers: { "cache-control": "no-store" } });
}
