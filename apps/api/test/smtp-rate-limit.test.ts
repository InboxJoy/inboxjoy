import rateLimit from "@fastify/rate-limit";
import { loadAppEnv } from "@inboxjoy/config";
import type { InboxJoyDb } from "@inboxjoy/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInboxRoutes } from "../src/modules/inboxes/index.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));

const attempts = [
  { method: "POST", url: "/v1/inboxes/smtp" },
  { method: "PATCH", url: "/v1/inboxes/mailbox/smtp" },
  { method: "POST", url: "/v1/inboxes/mailbox/verify" },
] as const;
const password = "never-log-this-password";
const payload = {
  email: "sender@example.com",
  smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com", password },
  imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com", password },
};
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup() {
  const app = Fastify();
  apps.push(app);
  await app.register(rateLimit, { global: false });
  app.decorateRequest("workspaceId", "");
  app.decorateRequest("workspaceRole", "owner");
  app.decorateRequest("userId", "");
  app.addHook("preHandler", async (request) => {
    request.workspaceId = String(request.headers["x-workspace"] ?? "workspace-a");
    request.userId = String(request.headers["x-user"] ?? "user-a");
  });
  const verify = vi.fn().mockRejectedValue(Object.assign(new Error(password), { code: "EAUTH" }));
  const transaction = vi.fn();
  const db = { select: () => ({ from: () => ({ where: async () => [] }) }), transaction } as unknown as InboxJoyDb;
  const env = loadAppEnv({ DATABASE_URL: "postgresql://unused/inboxjoy_test", SMTP_MAILBOXES_ENABLED: "true", MAILBOX_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64") });
  registerInboxRoutes(app, env, db, undefined, { transportFactory: () => ({ verify, close: vi.fn() }) });
  return { app, verify, transaction };
}

describe("SMTP verification limits without a database", () => {
  it.each(attempts)("limits $method $url to ten requests per workspace per hour", async (attempt) => {
    const { app, verify } = await setup();
    for (let index = 0; index < 10; index += 1) {
      expect((await app.inject({ ...attempt, payload })).statusCode).not.toBe(429);
    }
    const calls = verify.mock.calls.length;
    const limited = await app.inject({ ...attempt, payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "SMTP mailbox verification is limited to 10 attempts per workspace per hour." });
    expect(limited.body).not.toContain(password);
    expect(verify).toHaveBeenCalledTimes(calls);
  });

  it("shares the budget across routes and users, isolates workspaces and ignores source IP", async () => {
    const { app, verify, transaction } = await setup();
    for (let index = 0; index < 10; index += 1) {
      expect((await app.inject({ ...attempts[index % attempts.length]!, payload, remoteAddress: `203.0.113.${index + 1}`, headers: { "x-user": `user-${index}` } })).statusCode).not.toBe(429);
    }
    const calls = verify.mock.calls.length;
    for (const attempt of attempts) expect((await app.inject({ ...attempt, payload, headers: { "x-user": "another-user" } })).statusCode).toBe(429);
    expect(verify).toHaveBeenCalledTimes(calls);
    expect((await app.inject({ ...attempts[0], payload, headers: { "x-workspace": "workspace-b" } })).statusCode).toBe(400);
    expect(verify).toHaveBeenCalledTimes(calls + 1);
    expect(transaction).not.toHaveBeenCalled();
  });
});
