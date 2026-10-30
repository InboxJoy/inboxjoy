import rateLimit from "@fastify/rate-limit";
import { loadAppEnv } from "@inboxjoy/config";
import type { InboxJoyDb } from "@inboxjoy/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConnection, registerInboxRoutes } from "../src/modules/inboxes/index.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));
const password = "secret-never-in-output";
const body = { email: "owner@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "owner@example.com", password }, imap: { host: "imap.example.com", port: 993, secure: true, username: "owner@example.com", password } };

describe("SMTP route boundaries without a database", () => {
  const apps: FastifyInstance[] = [];
  const transaction = vi.fn();
  const verify = vi.fn();
  const close = vi.fn();
  const imapFactory = vi.fn();
  const logs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    logs.length = 0;
    verify.mockRejectedValue(Object.assign(new Error(password), { code: "EAUTH" }));
  });
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  async function createApp(enabled = true): Promise<FastifyInstance> {
    const app = Fastify({ logger: { level: "error", stream: { write: (chunk: string) => { logs.push(chunk); } } } });
    apps.push(app);
    await app.register(rateLimit, { global: false });
    app.decorateRequest("workspaceId", "");
    app.decorateRequest("workspaceRole", "member");
    app.decorateRequest("userId", "");
    app.addHook("preHandler", async (request) => {
      request.workspaceId = String(request.headers["x-workspace-id"] ?? "workspace-a");
      request.workspaceRole = request.headers["x-role"] === "member" ? "member" : "owner";
      request.userId = String(request.headers["x-user-id"] ?? "user-a");
    });
    const env = loadAppEnv({ DATABASE_URL: "postgresql://unused/inboxjoy_test", SMTP_MAILBOXES_ENABLED: String(enabled), MAILBOX_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64") });
    registerInboxRoutes(app, env, { transaction } as unknown as InboxJoyDb, undefined, { transportFactory: () => ({ verify, close }), imapFactory });
    return app;
  }

  it("returns 404 for every SMTP write endpoint when disabled", async () => {
    const app = await createApp(false);
    for (const request of [{ method: "POST", url: "/v1/inboxes/smtp", payload: body }, { method: "PATCH", url: "/v1/inboxes/unused/smtp", payload: body }, { method: "POST", url: "/v1/inboxes/unused/verify" }] as const) {
      expect((await app.inject(request)).statusCode).toBe(404);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("forbids members before verification or storage", async () => {
    const app = await createApp();
    for (const request of [{ method: "POST", url: "/v1/inboxes/smtp", payload: body }, { method: "PATCH", url: "/v1/inboxes/unused/smtp", payload: body }, { method: "POST", url: "/v1/inboxes/unused/verify" }] as const) {
      expect((await app.inject({ ...request, headers: { "x-role": "member" } })).statusCode).toBe(403);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns field-attributed verification errors without inserts or secrets", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: "/v1/inboxes/smtp", payload: body });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ field: "smtp.auth" });
    expect(response.body).not.toContain(password);
    expect(transaction).not.toHaveBeenCalled();
    expect(imapFactory).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("validates ports and IP hosts before any verification", async () => {
    const app = await createApp();
    const badPort = await app.inject({ method: "POST", url: "/v1/inboxes/smtp", payload: { ...body, smtp: { ...body.smtp, port: 80 } } });
    expect(badPort.statusCode).toBe(400);
    expect(badPort.json().field).toBe("smtp.port");
    const badHost = await app.inject({ method: "POST", url: "/v1/inboxes/smtp", payload: { ...body, smtp: { ...body.smtp, host: "127.0.0.1" } } });
    expect(badHost.statusCode).toBe(400);
    expect(badHost.json().field).toBe("smtp.host");
    expect(verify).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("limits attempts by workspace, not by user or IP", async () => {
    const app = await createApp();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await app.inject({ method: "POST", url: "/v1/inboxes/smtp", payload: body })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/v1/inboxes/smtp", headers: { "x-user-id": "another-user" }, payload: body })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/v1/inboxes/smtp", headers: { "x-workspace-id": "workspace-b" }, payload: body })).statusCode).toBe(400);
    expect(verify).toHaveBeenCalledTimes(11);
  });

  it("does not echo malformed credential JSON in responses or error logs", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: "/v1/inboxes/smtp", headers: { "content-type": "application/json" }, payload: `{"smtp":{"password":${password}}}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid SMTP mailbox request." });
    expect(response.body).not.toContain(password);
    expect(logs.join("\n")).not.toContain(password);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("parseConnection password re-entry", () => {
  const existing = { host: "smtp.example.com", port: 587, secure: false, username: "owner@example.com", password: "stored-password" };

  it("requires a password with the request's own (not inherited) value when the host changes", () => {
    const result = parseConnection({ host: "changed.example.com" }, "smtp", existing);
    expect(result).toEqual({ error: "Re-enter the password to change the server or username.", field: "smtp.password" });
  });

  it("requires a password when only the port changes", () => {
    expect(parseConnection({ port: 465 }, "smtp", existing)).toMatchObject({ field: "smtp.password" });
  });

  it("requires a password when only the username changes", () => {
    expect(parseConnection({ username: "someone-else@example.com" }, "smtp", existing)).toMatchObject({ field: "smtp.password" });
  });

  it("treats a host that only differs by case or whitespace as unchanged", () => {
    const result = parseConnection({ host: " SMTP.Example.com " }, "smtp", existing);
    expect(result).toEqual({ config: existing });
  });

  it("allows changing only `secure` without a password, reusing the stored one", () => {
    const result = parseConnection({ secure: true }, "smtp", existing);
    expect(result).toEqual({ config: { ...existing, secure: true } });
  });

  it("succeeds when host, port and username change together with a fresh password", () => {
    const result = parseConnection({ host: "new-host.example.com", port: 465, username: "new-user@example.com", password: "fresh-password" }, "smtp", existing);
    expect(result).toEqual({ config: { host: "new-host.example.com", port: 465, secure: false, username: "new-user@example.com", password: "fresh-password" } });
  });

  it("rejects a changed host with an empty password rather than falling back to the stored one", () => {
    expect(parseConnection({ host: "changed.example.com", password: "" }, "smtp", existing)).toMatchObject({ field: "smtp.password" });
  });

  it("keeps working unchanged when creating a mailbox (no existing connection)", () => {
    expect(parseConnection({ host: "smtp.example.com", port: 587, secure: false, username: "owner@example.com" }, "smtp")).toMatchObject({ field: "smtp.password" });
    expect(parseConnection({ host: "smtp.example.com", port: 587, secure: false, username: "owner@example.com", password: "new-password" }, "smtp")).toEqual({ config: { host: "smtp.example.com", port: 587, secure: false, username: "owner@example.com", password: "new-password" } });
  });

  it("returns the existing connection unchanged when nothing is sent for it", () => {
    expect(parseConnection(undefined, "smtp", existing)).toEqual({ config: existing });
  });
});
