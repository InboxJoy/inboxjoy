import { createHmac, timingSafeEqual } from "node:crypto";

// Browser-facing OAuth endpoints (the consent POST and grant revocation) are driven by the
// user's session cookie, so they need CSRF protection beyond SameSite=Lax. Two independent
// checks are applied: the request must come from this site (Sec-Fetch-Site + Origin), and
// approving consent must present a short-lived token signed over exactly what the user saw.

export const CONSENT_TOKEN_TTL_SECONDS = 10 * 60;

const PRODUCTION_RUNTIME = process.env.NODE_ENV === "production"
  && process.env.NEXT_PHASE !== "phase-production-build";

if (PRODUCTION_RUNTIME && !process.env.WEB_BASE_URL) {
  throw new Error("WEB_BASE_URL must be set in production: it is the only trusted origin for OAuth consent requests.");
}

/** The configured public origin. Never derived from the request's Host header. */
export function webOrigin(): string {
  return new URL(process.env.WEB_BASE_URL ?? "http://localhost:3000").origin;
}

function headerOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Returns a 403 response when the request did not originate from this site, otherwise null.
 * Requires `Sec-Fetch-Site: same-origin` and an `Origin` matching WEB_BASE_URL; `Referer`
 * is consulted only when `Origin` is absent. Both headers absent is a rejection.
 */
export function rejectCrossSiteRequest(request: Request): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.has("origin")
    ? headerOrigin(request.headers.get("origin"))
    : headerOrigin(request.headers.get("referer"));

  if (fetchSite === "same-origin" && origin !== null && origin === webOrigin()) return null;
  return Response.json(
    { error: "forbidden", error_description: "This request must be submitted from the InboxJoy app." },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

export type ConsentTokenFields = {
  userId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  workspaceId: string;
};

function consentSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET (or AUTH_SECRET) must be set to sign OAuth consent tokens.");
  return secret;
}

function signConsent(fields: ConsentTokenFields, exp: number): Buffer {
  // JSON-encoding the tuple keeps a `|` inside a redirect URI from colliding with a separator.
  const payload = JSON.stringify([fields.userId, fields.clientId, fields.codeChallenge, fields.redirectUri, fields.workspaceId, exp]);
  return createHmac("sha256", consentSecret()).update(payload).digest();
}

/** Mints `exp.signature`, valid for CONSENT_TOKEN_TTL_SECONDS, bound to the given fields. */
export function mintConsentToken(fields: ConsentTokenFields, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + CONSENT_TOKEN_TTL_SECONDS;
  return `${exp}.${signConsent(fields, exp).toString("base64url")}`;
}

/** True only if the token is well-formed, unexpired, and signed over exactly these fields. */
export function verifyConsentToken(token: unknown, fields: ConsentTokenFields, now = Date.now()): boolean {
  if (typeof token !== "string") return false;
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const exp = Number(token.slice(0, separator));
  if (!Number.isInteger(exp) || exp * 1000 <= now) return false;

  // Compare the encoded strings, not decoded bytes: base64url decoding is lenient and would
  // accept non-canonical spellings (trailing padding bits) of the same signature.
  const presented = Buffer.from(token.slice(separator + 1), "utf8");
  const expected = Buffer.from(signConsent(fields, exp).toString("base64url"), "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
