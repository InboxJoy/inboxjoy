import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as authorizeGet, POST as authorizePost } from "../app/oauth/authorize/route";
import { GET as grantsGet } from "../app/oauth/grants/route";
import { POST as grantRevokePost } from "../app/oauth/grants/[id]/revoke/route";
import { POST as registerPost } from "../app/oauth/register/route";
import { POST as revokePost } from "../app/oauth/revoke/route";
import { POST as tokenPost } from "../app/oauth/token/route";
import { closeDbForTests } from "../lib/db";
import { createPkceChallenge, hashOpaqueToken } from "../lib/oauth";
import { mintConsentToken, webOrigin } from "../lib/oauth-consent";
import { validateAccessToken } from "../lib/oauth-tokens";
import { getServerAuth } from "../lib/server-auth";

const databaseUrl = process.env.DATABASE_URL;
process.env.BETTER_AUTH_SECRET ??= "oauth-integration-test-secret-at-least-32-characters";
process.env.WEB_BASE_URL ??= "http://localhost:3000";

// Headers a browser attaches when the consent form is submitted from the InboxJoy app itself.
const sameOriginHeaders = () => ({ origin: webOrigin(), "sec-fetch-site": "same-origin" });

type RegisteredClient = { client_id: string; redirect_uris: string[] };
type IssuedTokens = { access_token: string; refresh_token: string; scope: string };

describe.skipIf(!databaseUrl)("web OAuth server", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const createdClientIds: string[] = [];
  let cookie = "";
  let userId = "";
  let workspaceId = "";

  const formRequest = (
    path: string,
    values: Record<string, string>,
    sessionCookie?: string,
    extraHeaders: Record<string, string> = {},
  ) => new Request(`https://app.example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...extraHeaders,
    },
    body: new URLSearchParams(values),
  });

  async function registerClient(redirectUri = "https://client.example.test/callback"): Promise<RegisteredClient> {
    const response = await registerPost(new Request("https://app.example.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `OAuth test ${randomUUID()}`,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }));
    expect(response.status).toBe(201);
    const client = await response.json() as RegisteredClient;
    createdClientIds.push(client.client_id);
    return client;
  }

  function authorizationUrl(clientId: string, redirectUri: string, verifier: string, overrides: Record<string, string> = {}) {
    const url = new URL("https://app.example.test/oauth/authorize");
    const values = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "inboxjoy:read inboxjoy:write",
      state: "test-state",
      code_challenge: createPkceChallenge(verifier),
      code_challenge_method: "S256",
      ...overrides,
    };
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    return url;
  }

  // The consent page mints this token into the form; route-level tests mint it the same way.
  function consentToken(client: RegisteredClient, verifier: string, forWorkspaceId = workspaceId): string {
    return mintConsentToken({
      userId,
      clientId: client.client_id,
      codeChallenge: createPkceChallenge(verifier),
      redirectUri: client.redirect_uris[0]!,
      workspaceId: forWorkspaceId,
    });
  }

  function approvalForm(client: RegisteredClient, verifier: string, overrides: Record<string, string> = {}): Record<string, string> {
    return {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0]!,
      scope: "inboxjoy:read inboxjoy:write",
      state: "test-state",
      code_challenge: createPkceChallenge(verifier),
      code_challenge_method: "S256",
      workspace_id: workspaceId,
      [`consent_token_${workspaceId}`]: consentToken(client, verifier),
      decision: "approve",
      ...overrides,
    };
  }

  async function issueCode(client: RegisteredClient, verifier: string): Promise<string> {
    const url = authorizationUrl(client.client_id, client.redirect_uris[0]!, verifier);
    const validation = await authorizeGet(new Request(url, { headers: { cookie } }));
    expect(validation.status).toBe(302);
    expect(new URL(validation.headers.get("location")!).pathname).toBe("/app/mcp/authorize");

    const response = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier), cookie, sameOriginHeaders()));
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("test-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    return code!;
  }

  async function exchangeCode(client: RegisteredClient, code: string, verifier: string, redirectUri = client.redirect_uris[0]!) {
    return tokenPost(formRequest("/oauth/token", {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }));
  }

  beforeAll(async () => {
    const email = `oauth-test-${randomUUID()}@example.com`;
    const signup = await getServerAuth().api.signUpEmail({
      body: { email, password: "test-password-at-least-eight-characters", name: "OAuth Test User" },
      returnHeaders: true,
    });
    userId = signup.response.user.id;
    const responseHeaders = signup.headers;
    if (!responseHeaders) throw new Error("Authentication response did not include headers.");
    const setCookies = typeof responseHeaders.getSetCookie === "function"
      ? responseHeaders.getSetCookie()
      : [responseHeaders.get("set-cookie")].filter((value): value is string => Boolean(value));
    cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    expect(cookie).toMatch(/(?:__Secure-)?better-auth\.session_token=/);

    workspaceId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        email,
        normalizedEmail: email,
        displayName: "OAuth Test User",
      });
      await tx.insert(schema.workspaces).values({
        id: workspaceId,
        name: "OAuth Integration Workspace",
        slug: `oauth-test-${workspaceId.slice(0, 12)}`,
        createdByUserId: userId,
      });
      await tx.insert(schema.memberships).values({
        id: randomUUID(),
        workspaceId,
        userId,
        role: "owner",
        status: "active",
        joinedAt: new Date(),
      });
    });
  });

  afterAll(async () => {
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (createdClientIds.length) {
      for (const clientId of createdClientIds) await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, clientId));
    }
    if (userId) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
    }
    await closeDbForTests();
    await pool.end();
  });

  it("completes registration, authorization, exchange, rotation, and RFC 7009 revocation", async () => {
    const client = await registerClient();
    const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
    const code = await issueCode(client, verifier);

    const tokenResponse = await exchangeCode(client, code, verifier);
    expect(tokenResponse.status).toBe(200);
    const initial = await tokenResponse.json() as IssuedTokens;
    expect(await validateAccessToken(initial.access_token)).toMatchObject({ workspaceId, userId, clientId: client.client_id });

    const refreshResponse = await tokenPost(formRequest("/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: initial.refresh_token,
    }));
    expect(refreshResponse.status).toBe(200);
    const rotated = await refreshResponse.json() as IssuedTokens;
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);
    expect(await validateAccessToken(initial.access_token)).toBeNull();
    expect(await validateAccessToken(rotated.access_token)).toMatchObject({ workspaceId, scopes: "inboxjoy:read inboxjoy:write" });
    const reusedRefresh = await tokenPost(formRequest("/oauth/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: initial.refresh_token,
    }));
    expect(reusedRefresh.status).toBe(400);
    expect(await reusedRefresh.json()).toMatchObject({ error: "invalid_grant" });

    const revokeResponse = await revokePost(formRequest("/oauth/revoke", {
      client_id: client.client_id,
      token: rotated.access_token,
      token_type_hint: "access_token",
    }));
    expect(revokeResponse.status).toBe(200);
    expect(await validateAccessToken(rotated.access_token)).toBeNull();
  });

  it("rejects a wrong PKCE verifier without consuming the code", async () => {
    const client = await registerClient();
    const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
    const code = await issueCode(client, verifier);

    const rejected = await exchangeCode(client, code, "wrong-verifier-value-with-sufficient-length");
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });

    const accepted = await exchangeCode(client, code, verifier);
    expect(accepted.status).toBe(200);
  });

  it("requires S256 PKCE at the authorization endpoint", async () => {
    const client = await registerClient();
    const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
    const missing = authorizationUrl(client.client_id, client.redirect_uris[0]!, verifier);
    missing.searchParams.delete("code_challenge");
    expect((await authorizeGet(new Request(missing, { headers: { cookie } }))).status).toBe(400);

    const plain = authorizationUrl(client.client_id, client.redirect_uris[0]!, verifier, { code_challenge_method: "plain" });
    const plainResponse = await authorizeGet(new Request(plain, { headers: { cookie } }));
    expect(plainResponse.status).toBe(400);
    expect(await plainResponse.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects redirect URI mismatches at authorization and token exchange", async () => {
    const client = await registerClient();
    const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
    const mismatched = authorizationUrl(client.client_id, "https://attacker.example.test/callback", verifier);
    expect((await authorizeGet(new Request(mismatched, { headers: { cookie } }))).status).toBe(400);

    const code = await issueCode(client, verifier);
    const rejected = await exchangeCode(client, code, verifier, "https://attacker.example.test/callback");
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects expired and reused authorization codes", async () => {
    const client = await registerClient();
    const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
    const expiredCode = await issueCode(client, verifier);
    await db.update(schema.mcpOauthCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(
      schema.mcpOauthCodes.codeHash,
      hashOpaqueToken(expiredCode),
    ));
    expect((await exchangeCode(client, expiredCode, verifier)).status).toBe(400);

    const singleUseCode = await issueCode(client, verifier);
    expect((await exchangeCode(client, singleUseCode, verifier)).status).toBe(200);
    const reused = await exchangeCode(client, singleUseCode, verifier);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("invalidates issued access tokens when the user revokes the grant", async () => {
    const client = await registerClient();
    const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
    const code = await issueCode(client, verifier);
    const tokenResponse = await exchangeCode(client, code, verifier);
    const tokens = await tokenResponse.json() as IssuedTokens;
    expect(await validateAccessToken(tokens.access_token)).not.toBeNull();

    const grantsResponse = await grantsGet(new Request("https://app.example.test/oauth/grants", { headers: { cookie } }));
    expect(grantsResponse.status).toBe(200);
    const listed = await grantsResponse.json() as { grants: Array<{ id: string; clientId: string; revokedAt: string | null }> };
    const grant = listed.grants.find((item) => item.clientId === client.client_id && !item.revokedAt);
    expect(grant).toBeTruthy();

    const crossSiteRevoke = await grantRevokePost(
      new Request(`https://app.example.test/oauth/grants/${grant!.id}/revoke`, { method: "POST", headers: { cookie } }),
      { params: Promise.resolve({ id: grant!.id }) },
    );
    expect(crossSiteRevoke.status).toBe(403);
    expect(await validateAccessToken(tokens.access_token)).not.toBeNull();

    const revokeResponse = await grantRevokePost(
      new Request(`https://app.example.test/oauth/grants/${grant!.id}/revoke`, { method: "POST", headers: { cookie, ...sameOriginHeaders() } }),
      { params: Promise.resolve({ id: grant!.id }) },
    );
    expect(revokeResponse.status).toBe(200);
    expect(await validateAccessToken(tokens.access_token)).toBeNull();

    const [token] = await db.select().from(schema.mcpOauthTokens).where(and(
      eq(schema.mcpOauthTokens.clientId, client.client_id),
      eq(schema.mcpOauthTokens.workspaceId, workspaceId),
    )).limit(1);
    expect(token?.revokedAt).not.toBeNull();
  });

  describe("consent POST CSRF binding", () => {
    async function codesIssuedFor(clientId: string): Promise<number> {
      return (await db.select().from(schema.mcpOauthCodes).where(eq(schema.mcpOauthCodes.clientId, clientId))).length;
    }

    it("rejects a consent POST without an Origin header", async () => {
      const client = await registerClient();
      const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
      const response = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier), cookie, { "sec-fetch-site": "same-origin" }));
      expect(response.status).toBe(403);
      expect(await codesIssuedFor(client.client_id)).toBe(0);
    });

    it("rejects a consent POST from a foreign Origin", async () => {
      const client = await registerClient();
      const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
      const foreignOrigin = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier), cookie, {
        origin: "https://attacker.example.test",
        "sec-fetch-site": "cross-site",
      }));
      expect(foreignOrigin.status).toBe(403);

      // Matching Origin alone is not enough: Sec-Fetch-Site must also say same-origin.
      const spoofedOrigin = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier), cookie, {
        origin: webOrigin(),
        "sec-fetch-site": "cross-site",
      }));
      expect(spoofedOrigin.status).toBe(403);

      // Referer is only consulted when Origin is absent, and must still match.
      const foreignReferer = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier), cookie, {
        referer: "https://attacker.example.test/launch",
        "sec-fetch-site": "same-origin",
      }));
      expect(foreignReferer.status).toBe(403);
      expect(await codesIssuedFor(client.client_id)).toBe(0);
    });

    it("rejects a tampered, mismatched, or expired consent token", async () => {
      const client = await registerClient();
      const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
      const tokenField = `consent_token_${workspaceId}`;
      const valid = consentToken(client, verifier);

      const flipped = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
      const tampered = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier, { [tokenField]: flipped }), cookie, sameOriginHeaders()));
      expect(tampered.status).toBe(403);

      const missing = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier, { [tokenField]: "" }), cookie, sameOriginHeaders()));
      expect(missing.status).toBe(403);

      // A token minted for a different PKCE challenge must not approve this request.
      const otherChallenge = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier, {
        [tokenField]: consentToken(client, `other-verifier-${randomUUID()}`),
      }), cookie, sameOriginHeaders()));
      expect(otherChallenge.status).toBe(403);

      const expired = mintConsentToken({
        userId,
        clientId: client.client_id,
        codeChallenge: createPkceChallenge(verifier),
        redirectUri: client.redirect_uris[0]!,
        workspaceId,
      }, Date.now() - 11 * 60 * 1000);
      const stale = await authorizePost(formRequest("/oauth/authorize", approvalForm(client, verifier, { [tokenField]: expired }), cookie, sameOriginHeaders()));
      expect(stale.status).toBe(403);
      expect(await codesIssuedFor(client.client_id)).toBe(0);
    });

    it("still issues a code for a same-origin POST with a valid consent token", async () => {
      const client = await registerClient();
      const verifier = `verifier-${randomUUID()}-${randomUUID()}`;
      const code = await issueCode(client, verifier);
      expect(await codesIssuedFor(client.client_id)).toBe(1);
      expect((await exchangeCode(client, code, verifier)).status).toBe(200);
    });
  });
});
