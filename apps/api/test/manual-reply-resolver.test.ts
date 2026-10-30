import type { ComposioClient } from "@inboxjoy/composio";
import { loadAppEnv } from "@inboxjoy/config";
import { runOperation, type OperationContext } from "@inboxjoy/core";
import { schema } from "@inboxjoy/db";
import { createMailClientResolver } from "@inboxjoy/smtp";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

vi.mock("@inboxjoy/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@inboxjoy/core")>(),
  runOperation: vi.fn(),
}));

vi.mock("@inboxjoy/smtp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@inboxjoy/smtp")>(),
  createMailClientResolver: vi.fn(),
}));

vi.mock("../src/auth.js", () => ({
  createAuth: vi.fn(),
  provisionWorkspace: vi.fn(),
  transactionalEmailFromEnv: vi.fn(),
}));

describe("manual reply API resolver wiring without a live database", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const getMailClientFor = vi.fn();
  const close = vi.fn();
  const composio = { enabled: false } as ComposioClient;
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.apiKeys) throw new Error("Unexpected database query");
        return { where: () => ({ limit: async () => [{ id: randomUUID(), workspaceId, createdByUserId: userId, revokedAt: null }] }) };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as OperationContext["db"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createMailClientResolver).mockReturnValue({ getMailClientFor, close });
    vi.mocked(runOperation).mockResolvedValue({ sent: true, providerMessageId: "<manual@example.com>", threading: "in_thread" });
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(overrides: NodeJS.ProcessEnv = {}, withDatabase = true) {
    const env = loadAppEnv({
      NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: "postgresql://unused/inboxjoy_test",
      API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test",
      AUTH_SECRET: "reply-resolver-test-secret-at-least-32-characters", ...overrides,
    });
    const app = await buildApp({ env, db: withDatabase ? db : undefined, composio });
    apps.push(app);
    return app;
  }

  it.each([false, true])("builds one shared resolver with hash-derived current and previous credential key versions (allowPrivateHosts=%s)", async (allowPrivateHosts) => {
    const current = Buffer.alloc(32, 7);
    const previous = Buffer.alloc(32, 3);
    const app = await createApp({ MAILBOX_CREDENTIALS_KEY: current.toString("base64"), MAILBOX_CREDENTIALS_KEY_PREVIOUS: previous.toString("base64"), SMTP_ALLOW_PRIVATE_HOSTS: String(allowPrivateHosts) });
    const version = (key: Buffer) => (createHash("sha256").update(key).digest().readUInt32BE(0) & 0x7fffffff) || 1;

    expect(createMailClientResolver).toHaveBeenCalledTimes(1);
    expect(createMailClientResolver).toHaveBeenCalledWith({ db, composio, keys: new Map([[version(previous), previous], [version(current), current]]), allowPrivateHosts });
    await app.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("injects the resolver alongside Composio for REST manual replies", async () => {
    const app = await createApp();
    const replyId = randomUUID();
    const idempotencyKey = randomUUID();
    const response = await app.inject({
      method: "POST", url: `/v1/replies/${replyId}/send`, headers: { authorization: "Bearer ij_test-key" },
      payload: { body: "Yes, I can.", idempotencyKey },
    });

    expect(response.statusCode).toBe(200);
    expect(runOperation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "replies.send" }),
      expect.objectContaining({ db, workspaceId, userId, composio, mailClientFor: getMailClientFor }),
      { id: replyId, body: "Yes, I can.", idempotencyKey },
    );
    expect(createMailClientResolver).toHaveBeenCalledTimes(1);
  });

  it("injects the same resolver alongside Composio for MCP manual replies", async () => {
    const app = await createApp();
    const input = { id: randomUUID(), body: "Yes, I can.", idempotencyKey: randomUUID() };
    const response = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: "Bearer ij_test-key", "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "inboxjoy_replies_send", arguments: input } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.isError).not.toBe(true);
    expect(runOperation).toHaveBeenCalledWith(
      expect.objectContaining({ name: "replies.send" }),
      expect.objectContaining({ db, workspaceId, userId, composio, mailClientFor: getMailClientFor }),
      input,
    );
    expect(createMailClientResolver).toHaveBeenCalledTimes(1);
  });

  it("does not construct a resolver when operation storage is absent", async () => {
    const app = await createApp({}, false);

    expect(createMailClientResolver).not.toHaveBeenCalled();
    await app.close();
    expect(close).not.toHaveBeenCalled();
  });
});
