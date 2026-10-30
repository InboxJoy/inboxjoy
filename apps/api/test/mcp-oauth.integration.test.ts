import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("MCP OAuth", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "mcp-oauth-test-auth-secret-at-least-32-characters" });
  const grantIds: string[] = [];
  const tokenIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: AuthenticatedSession;

  const mcp = (token: string | undefined, method: string, params: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    return app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: randomUUID(), method, params },
    });
  };

  const createOAuthAuthorization = async ({
    scopes,
    expiresAt = new Date(Date.now() + 3_600_000),
    grantRevokedAt = null,
  }: {
    scopes: string[];
    expiresAt?: Date;
    grantRevokedAt?: Date | null;
  }) => {
    const grantId = randomUUID();
    const tokenId = randomUUID();
    const clientId = `mcp-test-${randomUUID()}`;
    const token = `oauth_${randomUUID()}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const scopeString = scopes.join(" ");
    grantIds.push(grantId);
    tokenIds.push(tokenId);

    await db.execute(sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris)
      VALUES (${clientId}, 'MCP test client', ARRAY['http://localhost:33418/callback'])
    `);
    await db.execute(sql`
      INSERT INTO mcp_grants (id, user_id, client_id, workspace_id, scopes, created_at, revoked_at)
      VALUES (${grantId}, ${session.userId}, ${clientId}, ${session.workspaceId}, ${scopeString}, now(), ${grantRevokedAt})
    `);
    await db.execute(sql`
      INSERT INTO mcp_oauth_tokens (id, token_hash, user_id, client_id, workspace_id, scopes, expires_at, refresh_expires_at, revoked_at, created_at)
      VALUES (${tokenId}, ${tokenHash}, ${session.userId}, ${clientId}, ${session.workspaceId}, ${scopeString}, ${expiresAt}, ${expiresAt}, null, now())
    `);

    return token;
  };

  beforeAll(async () => {
    // These self-provisioned tables are a stand-in for migration 0013_mcp_oauth.sql (owned by the
    // feat/mcp-oauth lane), which had not landed on this branch yet. `IF NOT EXISTS` makes this a no-op
    // once that migration is present. Column shapes match that lane's actual migration/MCP_OAUTH.md:
    // text user_id/client_id/scopes, uuid workspace_id (NOT NULL on mcp_oauth_tokens too — the token
    // carries its own workspace_id and the grant join includes it).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS mcp_grants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL,
        client_id text NOT NULL,
        workspace_id uuid NOT NULL,
        scopes text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash text NOT NULL,
        refresh_token_hash text,
        user_id text NOT NULL,
        client_id text NOT NULL,
        workspace_id uuid NOT NULL,
        scopes text NOT NULL,
        expires_at timestamptz NOT NULL,
        refresh_expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
        resource text,
        superseded_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    app = await buildApp({ env, db });
    session = await createAuthenticatedSession(app, "MCP OAuth Workspace");
  });

  afterAll(async () => {
    await app?.close();
    for (const tokenId of tokenIds) await db.execute(sql`DELETE FROM mcp_oauth_tokens WHERE id = ${tokenId}`);
    for (const grantId of grantIds) await db.execute(sql`DELETE FROM mcp_grants WHERE id = ${grantId}`);
    await db.execute(sql`DELETE FROM oauth_clients WHERE client_name = 'MCP test client'`);
    if (session) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    await pool.end();
  });

  it("publishes OAuth protected-resource metadata", async () => {
    const response = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      resource: `${env.WEB_BASE_URL}/mcp`,
      authorization_servers: [env.WEB_BASE_URL],
      scopes_supported: ["inboxjoy:read", "inboxjoy:write"],
      bearer_methods_supported: ["header"],
    });
  });

  it("challenges requests without an Authorization header", async () => {
    const response = await mcp(undefined, "tools/list");

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(response.headers["www-authenticate"]).toContain(`${env.WEB_BASE_URL}/.well-known/oauth-protected-resource`);
  });

  it("challenges requests with an unknown bearer token", async () => {
    const response = await mcp("not-a-real-token", "tools/list");

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(`Bearer error="invalid_token", resource_metadata="${env.WEB_BASE_URL}/.well-known/oauth-protected-resource"`);
  });

  it("rejects expired OAuth tokens", async () => {
    const token = await createOAuthAuthorization({ scopes: ["inboxjoy:read", "inboxjoy:write"], expiresAt: new Date(Date.now() - 60_000) });

    expect((await mcp(token, "tools/list")).statusCode).toBe(401);
  });

  it("rejects OAuth tokens whose grant is revoked", async () => {
    const token = await createOAuthAuthorization({ scopes: ["inboxjoy:read", "inboxjoy:write"], grantRevokedAt: new Date() });

    expect((await mcp(token, "tools/list")).statusCode).toBe(401);
  });

  it("filters write tools from read-scoped listings and rejects direct calls", async () => {
    const token = await createOAuthAuthorization({ scopes: ["inboxjoy:read"] });
    const tools = await mcp(token, "tools/list");

    expect(tools.statusCode).toBe(200);
    const names = tools.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("inboxjoy_sequences_list");
    expect(names).not.toContain("inboxjoy_sequences_create");

    const called = await mcp(token, "tools/call", {
      name: "inboxjoy_sequences_create",
      arguments: { name: "Scope denied", description: "Should not be created", steps: [{ delayDays: 0, subject: "Hello", body: "Welcome" }] },
    });
    expect(called.statusCode).toBe(200);
    const callBody = called.json();
    const failureText = callBody.result?.content?.[0]?.text ?? callBody.error?.message ?? "";
    expect(callBody.result?.isError ?? Boolean(callBody.error)).toBe(true);
    expect(failureText).toMatch(/not found|insufficient_scope/i);
  });

  it("allows a fully scoped OAuth token to list and call tools", async () => {
    const token = await createOAuthAuthorization({ scopes: ["inboxjoy:read", "inboxjoy:write"] });
    const tools = await mcp(token, "tools/list");

    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "inboxjoy_sequences_list" })]));

    const listed = await mcp(token, "tools/call", { name: "inboxjoy_sequences_list", arguments: {} });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().result.isError).not.toBe(true);
    expect(JSON.parse(listed.json().result.content[0].text)).toEqual(expect.objectContaining({ workspaceId: session.workspaceId, sequences: expect.any(Array) }));
  });
});
