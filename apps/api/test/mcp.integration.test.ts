import { loadAppEnv } from "@inboxjoy/config";
import { MCP_ADMIN_OPERATIONS, operations } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("MCP API keys", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const env = loadAppEnv({ ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", CORS_ORIGINS: "https://app.example.test", AUTH_SECRET: "mcp-test-auth-secret-at-least-32-characters" });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let workspaceA: AuthenticatedSession;
  let workspaceB: AuthenticatedSession;
  let keyA = "";
  let keyId = "";
  let oauthToken = "";
  const oauthClientId = `mcp-admin-exclusions-${randomUUID()}`;

  const mcp = (key: string, method: string, params: Record<string, unknown> = {}) => app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: randomUUID(), method, params },
  });

  beforeAll(async () => {
    app = await buildApp({ env, db });
    workspaceA = await createAuthenticatedSession(app, "MCP Workspace A");
    workspaceB = await createAuthenticatedSession(app, "MCP Workspace B");
    const key = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: workspaceA.cookie }, payload: { name: "Integration MCP" } });
    expect(key.statusCode).toBe(201);
    keyA = key.json().key as string;
    keyId = key.json().apiKey.id as string;
    oauthToken = `oauth_${randomUUID()}`;
    const scopes = "inboxjoy:read inboxjoy:write";
    const expiresAt = new Date(Date.now() + 3_600_000);
    await db.insert(schema.oauthClients).values({ id: oauthClientId, clientName: "MCP exclusions integration", redirectUris: ["http://localhost:33418/callback"] });
    await db.insert(schema.mcpGrants).values({ userId: workspaceA.userId, clientId: oauthClientId, workspaceId: workspaceA.workspaceId, scopes });
    await db.insert(schema.mcpOauthTokens).values({ tokenHash: createHash("sha256").update(oauthToken).digest("hex"), userId: workspaceA.userId, clientId: oauthClientId, workspaceId: workspaceA.workspaceId, scopes, expiresAt, refreshExpiresAt: expiresAt });
  });

  afterAll(async () => {
    await app?.close();
    await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, oauthClientId));
    if (workspaceA) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA.workspaceId));
    if (workspaceB) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceB.workspaceId));
    await pool.end();
  });

  it.each(["API key", "OAuth token"])("never registers administrative tools for a valid %s", async (credential) => {
    const response = await mcp(credential === "API key" ? keyA : oauthToken, "tools/list");
    expect(response.statusCode).toBe(200);
    const toolNames = response.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain("inboxjoy_sequences_create");
    const administrativeNames = operations.filter((operation) => /^(apiKeys|team|workspaces|billing)\./.test(operation.name)
      || ["suppressions.remove", "sequences.delete", "workspace.delete"].includes(operation.name)).map((operation) => operation.name);
    expect(MCP_ADMIN_OPERATIONS).toEqual(new Set(administrativeNames));
    for (const operationName of MCP_ADMIN_OPERATIONS) {
      expect(toolNames, operationName).not.toContain(`inboxjoy_${operationName.replaceAll(".", "_")}`);
    }
  });

  it.each(["API key", "OAuth token"])("rejects direct MCP role-change calls using a valid %s", async (credential) => {
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceA.workspaceId));
    const response = await mcp(credential === "API key" ? keyA : oauthToken, "tools/call", { name: "inboxjoy_team_memberRoleChange", arguments: { id: membership!.id, role: "member" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.result?.isError ?? Boolean(body.error)).toBe(true);
    expect(body.result?.content?.[0]?.text ?? body.error?.message ?? "").toMatch(/not found/i);
    const [unchanged] = await db.select().from(schema.memberships).where(eq(schema.memberships.id, membership!.id));
    expect(unchanged!.role).toBe("owner");
  });

  it.each(["API key", "OAuth token"])("never lets a %s change sending controls through MCP", async (credential) => {
    await db.update(schema.workspaces).set({ killSwitchEnabled: true, dailySendCap: 50 }).where(eq(schema.workspaces.id, workspaceA.workspaceId));
    const token = credential === "API key" ? keyA : oauthToken;
    for (const args of [{ killSwitchEnabled: false }, { dailySendCap: 100_000 }, { name: "Renamed by agent", killSwitchEnabled: false }]) {
      const response = await mcp(token, "tools/call", { name: "inboxjoy_workspace_update", arguments: args });
      expect(response.statusCode).toBe(200);
      expect(response.json().result?.isError, JSON.stringify(args)).toBe(true);
      expect(response.json().result?.content?.[0]?.text ?? "").toMatch(/FORBIDDEN/);
    }
    const [unchanged] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceA.workspaceId));
    expect(unchanged).toMatchObject({ killSwitchEnabled: true, dailySendCap: 50 });
    expect(unchanged!.name).not.toBe("Renamed by agent");

    const renamed = await mcp(token, "tools/call", { name: "inboxjoy_workspace_update", arguments: { name: `MCP rename ${credential}` } });
    expect(renamed.json().result?.isError ?? false).toBe(false);
    await db.update(schema.workspaces).set({ killSwitchEnabled: false, dailySendCap: 200 }).where(eq(schema.workspaces.id, workspaceA.workspaceId));
  });

  it("creates and scopes sequences through MCP tools", async () => {
    const tools = await mcp(keyA, "tools/list");
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "inboxjoy_sequences_create" }), expect.objectContaining({ name: "inboxjoy_sequences_list" }), expect.objectContaining({ name: "inboxjoy_sequences_setMailboxes" })]));
    const created = await mcp(keyA, "tools/call", { name: "inboxjoy_sequences_create", arguments: { name: "MCP campaign", description: "Created by an agent", steps: [{ delayDays: 0, subject: "Hello", body: "Welcome" }] } });
    expect(created.statusCode).toBe(200);
    expect(created.json().result.isError).not.toBe(true);
    const sequenceId = JSON.parse(created.json().result.content[0].text).sequence.id as string;
    const saved = await mcp(keyA, "tools/call", { name: "inboxjoy_sequences_setMailboxes", arguments: { id: sequenceId, mailboxIds: [] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().result.isError).not.toBe(true);
    expect(JSON.parse(saved.json().result.content[0].text)).toMatchObject({ sequence: { id: sequenceId, mailboxIds: [] }, mailboxIds: [], reassigned: 0 });

    const listed = await mcp(keyA, "tools/call", { name: "inboxjoy_sequences_list", arguments: {} });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.json().result.content[0].text).sequences).toEqual(expect.arrayContaining([expect.objectContaining({ name: "MCP campaign" })]));

    const keyB = await app.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie: workspaceB.cookie }, payload: { name: "Workspace B" } });
    const listedByB = await mcp(keyB.json().key as string, "tools/call", { name: "inboxjoy_sequences_list", arguments: {} });
    expect(JSON.parse(listedByB.json().result.content[0].text).sequences).toEqual([]);
  });

  it("lists the affiliate tools only on the managed service", async () => {
    for (const edition of ["selfhost", "cloud"] as const) {
      const editionApp = await buildApp({ env: { ...env, INBOXJOY_EDITION: edition }, db });
      try {
        const response = await editionApp.inject({
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${oauthToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          payload: { jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: {} },
        });
        expect(response.statusCode).toBe(200);
        const toolNames = response.json().result.tools.map((tool: { name: string }) => tool.name);
        expect(toolNames).toContain("inboxjoy_sequences_create");
        for (const affiliateTool of ["inboxjoy_affiliate_get", "inboxjoy_affiliate_listReferrals"]) {
          if (edition === "cloud") expect(toolNames, affiliateTool).toContain(affiliateTool);
          else expect(toolNames, affiliateTool).not.toContain(affiliateTool);
        }
      } finally {
        await editionApp.close();
      }
    }
  });

  it("rejects revoked API keys", async () => {
    const revoked = await app.inject({ method: "DELETE", url: `/v1/api-keys/${keyId}`, headers: { cookie: workspaceA.cookie } });
    expect(revoked.statusCode).toBe(204);
    expect((await mcp(keyA, "tools/list")).statusCode).toBe(401);
  });
});
