import { loadAppEnv } from "@inboxjoy/config";
import { exportWorkspace, importWorkspace, OpError, WORKSPACE_TRANSFER_SHAPE, type OperationContext, type WorkspaceImportResult, type WorkspaceTransferFile } from "@inboxjoy/core";
import { schema } from "@inboxjoy/db";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import {
  registerWorkspaceTransferRoutes,
  WORKSPACE_IMPORT_BUSY_MESSAGE,
  WORKSPACE_IMPORT_CONCURRENCY,
  WORKSPACE_IMPORT_RUNNING_MESSAGE,
  WORKSPACE_IMPORT_UPLOAD_DEADLINE_MS,
  WORKSPACE_IMPORT_UPLOAD_TIMEOUT_MESSAGE,
  WORKSPACE_TRANSFER_KEY_MESSAGE,
} from "../src/modules/workspace-transfer/index.js";

vi.mock("@inboxjoy/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@inboxjoy/core")>(),
  exportWorkspace: vi.fn(),
  importWorkspace: vi.fn(),
}));

vi.mock("../src/auth.js", () => ({
  createAuth: vi.fn(),
  provisionWorkspace: vi.fn(),
  transactionalEmailFromEnv: vi.fn(),
}));

const exportedFile = { format: "inboxjoy-workspace", version: 1, exportedAt: "2026-10-29T10:00:00.000Z", source: {}, workspace: { name: "Acme" }, leads: [], lists: [], suppressions: [], sequences: [], mailboxes: [], team: [] } as unknown as WorkspaceTransferFile;
const db = {} as OperationContext["db"];

// Just under the 50 MB limit, so only a check made before parsing can stop it:
// tens of millions of empty objects once JSON.parse runs.
function hugeUpload(): string {
  const prefix = '{"format":"inboxjoy-workspace","version":1,"workspace":{"name":"x"},"leads":[';
  return `${prefix}${"{},".repeat(Math.floor((40 * 1024 * 1024) / 3))}{}]}`;
}

// Wired through buildApp: a key is refused before the auth hook looks it up,
// on plain and percent-encoded spellings alike.
describe("workspace transfer routes in the app", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const keyDb = {
    select: () => ({ from: (table: unknown) => {
      if (table !== schema.apiKeys) throw new Error("Unexpected database query");
      return { where: () => ({ limit: async () => [{ id: randomUUID(), workspaceId: randomUUID(), createdByUserId: randomUUID(), revokedAt: null }] }) };
    } }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as OperationContext["db"];

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  async function createApp() {
    const env = loadAppEnv({
      NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: "postgresql://unused/inboxjoy_test",
      API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test",
      AUTH_SECRET: "workspace-transfer-route-secret-at-least-32-characters",
    });
    const app = await buildApp({ env, db: keyDb });
    apps.push(app);
    return app;
  }

  it.each([
    { method: "GET", url: "/v1/workspace/export" },
    { method: "GET", url: "/v1/workspac%65/export" },
    { method: "GET", url: "/v%31/workspace/expor%74" },
    { method: "POST", url: "/v1/workspace/import" },
    { method: "POST", url: "/v1/workspace/%69mport" },
  ] as const)("refuses an API key on $method $url", async ({ method, url }) => {
    const app = await createApp();
    const response = await app.inject({ method, url, headers: { authorization: "Bearer ij_test-key" }, ...(method === "POST" ? { payload: exportedFile } : {}) });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: WORKSPACE_TRANSFER_KEY_MESSAGE });
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("asks anonymous callers to sign in before reading an upload", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: "/v1/workspace/import", headers: { "content-type": "application/json" }, payload: JSON.stringify({ pad: "x".repeat(60 * 1024 * 1024) }) });
    expect(response.statusCode).toBe(401);
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("checks a forged session cookie with the app's own session lookup before reading the upload", async () => {
    const getSession = vi.fn(async () => null);
    vi.mocked(createAuth).mockReturnValueOnce({ api: { getSession }, handler: vi.fn() } as unknown as ReturnType<typeof createAuth>);
    const app = await createApp();
    // An upload that announces 40 MB and never finishes: an API that waited
    // for the body before checking the session would never answer.
    const upload = new Readable({ read() {} });
    upload.push('{"format":"inboxjoy-workspace","version":1,"leads":[{},{},');
    const response = await app.inject({ method: "POST", url: "/v1/workspace/import", headers: { cookie: "better-auth.session_token=forged", "content-type": "application/json", "content-length": String(40 * 1024 * 1024) }, payload: upload });
    upload.destroy();
    expect(response.statusCode).toBe(401);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(importWorkspace).not.toHaveBeenCalled();
  });
});

type ModuleAppOptions = {
  authKind?: "session" | "api_key";
  user?: { id: string; emailVerified: boolean } | null;
  membership?: { workspaceId: string; role: string } | null;
  // What the app's auth hook resolves after the body, when it differs.
  resolvedWorkspaceId?: string;
  importUploadDeadlineMs?: number;
};

// The module on its own: the pre-body lookups are fakes, the identity the
// app's auth hook would set comes from a preHandler stub, and the JSON parser
// counts how often it runs.
describe("workspace transfer route handlers", () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const apps: Awaited<ReturnType<typeof createModuleApp>>["app"][] = [];

  async function createModuleApp(options: ModuleAppOptions = {}) {
    const parsed = { count: 0 };
    const sessionUser = vi.fn(async () => options.user === undefined ? { id: userId, emailVerified: true } : options.user);
    // The owner of whichever workspace x-workspace-id names, else of the default one.
    const sessionMembership = vi.fn(async (_userId: string, pinned?: string) => options.membership === null ? [] : [options.membership ?? { workspaceId: pinned ?? workspaceId, role: "owner" }]);
    const app = Fastify({ logger: false });
    app.decorateRequest("workspaceId", "");
    app.decorateRequest("userId", "");
    app.decorateRequest("workspaceRole", "member");
    app.decorateRequest("authKind", "session");
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      parsed.count++;
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(Object.assign(error as Error, { statusCode: 400 }), undefined);
      }
    });
    app.addHook("preHandler", async (request) => {
      const pinned = request.headers["x-workspace-id"];
      request.workspaceId = options.resolvedWorkspaceId ?? (typeof pinned === "string" ? pinned : workspaceId);
      request.userId = userId;
      request.workspaceRole = "owner";
      request.authKind = options.authKind ?? "session";
    });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof OpError) {
        const status = error.code === "FORBIDDEN" ? 403 : error.code === "CONFLICT" ? 409 : error.code === "BAD_INPUT" ? 400 : 503;
        const detailCode = error.details && typeof error.details === "object" && "code" in error.details ? error.details.code : undefined;
        return reply.status(status).send({ error: error.message, code: detailCode ?? error.code });
      }
      const failure = error as { statusCode?: number; message?: string };
      return reply.status(failure.statusCode ?? 500).send({ error: failure.message });
    });
    registerWorkspaceTransferRoutes(app, { db, source: { edition: "selfhost", appVersion: "test" }, sessionUser, sessionMembership, importUploadDeadlineMs: options.importUploadDeadlineMs });
    await app.ready();
    apps.push(app);
    return { app, parsed, sessionUser, sessionMembership };
  }

  const importRequest = (payload: unknown = exportedFile, headers: Record<string, string> = {}) => ({ method: "POST" as const, url: "/v1/workspace/import", headers: { cookie: "session=1", ...headers }, payload: payload as string });

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("downloads the export as a named JSON attachment for the signed-in workspace", async () => {
    vi.mocked(exportWorkspace).mockResolvedValue({ file: exportedFile, filename: "inboxjoy-acme-2026-10-29.json" });
    const { app } = await createModuleApp();
    const response = await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: "session=1" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="inboxjoy-acme-2026-10-29.json"');
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(exportedFile);
    expect(exportWorkspace).toHaveBeenCalledWith({ db, workspaceId, userId }, { source: { edition: "selfhost", appVersion: "test" } });
  });

  it("stamps exports with the running edition", async () => {
    vi.mocked(exportWorkspace).mockResolvedValue({ file: exportedFile, filename: "inboxjoy-acme-2026-10-29.json" });
    const app = Fastify({ logger: false });
    app.decorateRequest("workspaceId", "");
    app.decorateRequest("userId", "");
    app.decorateRequest("authKind", "session");
    app.addHook("preHandler", async (request) => { request.workspaceId = workspaceId; request.userId = userId; request.authKind = "session"; });
    registerWorkspaceTransferRoutes(app, {
      db,
      env: { INBOXJOY_EDITION: "cloud" },
      sessionUser: async () => ({ id: userId, emailVerified: true }),
      sessionMembership: async () => [{ workspaceId, role: "owner" }],
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: "session=1" } })).statusCode).toBe(200);
    expect(exportWorkspace).toHaveBeenCalledWith(expect.anything(), { source: expect.objectContaining({ edition: "cloud" }) });
  });

  it("passes the uploaded file to the import for the signed-in workspace", async () => {
    const result = { imported: { leads: 0 } } as unknown as WorkspaceImportResult;
    vi.mocked(importWorkspace).mockResolvedValue(result);
    const { app, parsed } = await createModuleApp();
    const response = await app.inject(importRequest());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(importWorkspace).toHaveBeenCalledWith({ db, workspaceId, userId }, exportedFile);
    expect(parsed.count).toBe(1);
  });

  it("refuses machine credentials even when they arrive with a cookie", async () => {
    const { app } = await createModuleApp({ authKind: "api_key" });
    for (const request of [{ method: "GET" as const, url: "/v1/workspace/export" }, { method: "POST" as const, url: "/v1/workspace/import", payload: exportedFile }]) {
      const response = await app.inject({ ...request, headers: { cookie: "session=1" } });
      expect(response.statusCode).toBe(403);
    }
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("refuses every request when the app passes no session lookups", async () => {
    const app = Fastify({ logger: false });
    registerWorkspaceTransferRoutes(app, { db });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: "session=1" } })).statusCode).toBe(401);
    expect((await app.inject(importRequest())).statusCode).toBe(401);
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a forged session cookie with a 40 MB upload before parsing it", async () => {
    const { app, parsed, sessionUser, sessionMembership } = await createModuleApp({ user: null });
    const response = await app.inject(importRequest(hugeUpload(), { "content-type": "application/json" }));
    expect(response.statusCode).toBe(401);
    expect(parsed.count).toBe(0);
    expect(sessionUser).toHaveBeenCalledTimes(1);
    expect(sessionMembership).not.toHaveBeenCalled();
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("refuses non-owners, other workspaces and unverified importers before parsing the upload", async () => {
    const admin = await createModuleApp({ membership: { workspaceId, role: "admin" } });
    const asAdmin = await admin.app.inject(importRequest());
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json()).toMatchObject({ code: "FORBIDDEN", error: "Only the workspace owner can export or import the workspace." });
    expect((await admin.app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: "session=1" } })).statusCode).toBe(403);

    const outsider = await createModuleApp({ membership: null });
    const elsewhere = await outsider.app.inject(importRequest(exportedFile, { "x-workspace-id": randomUUID() }));
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json()).toMatchObject({ code: "workspace_changed" });
    expect((await outsider.app.inject(importRequest())).statusCode).toBe(403);

    const owner = await createModuleApp();
    expect((await owner.app.inject(importRequest(exportedFile, { "x-workspace-id": "not-a-uuid" }))).statusCode).toBe(409);
    expect(owner.sessionMembership).not.toHaveBeenCalled();

    const unverified = await createModuleApp({ user: { id: userId, emailVerified: false } });
    const notVerified = await unverified.app.inject(importRequest());
    expect(notVerified.statusCode).toBe(403);
    expect(notVerified.json()).toMatchObject({ code: "email_unverified" });
    // Export is the owner's own data and needs no verified email.
    vi.mocked(exportWorkspace).mockResolvedValue({ file: exportedFile, filename: "inboxjoy-acme-2026-10-29.json" });
    expect((await unverified.app.inject({ method: "GET", url: "/v1/workspace/export", headers: { cookie: "session=1" } })).statusCode).toBe(200);

    for (const { parsed } of [admin, outsider, owner, unverified]) expect(parsed.count).toBe(0);
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("imports only into the workspace that was checked before the upload", async () => {
    const { app } = await createModuleApp({ resolvedWorkspaceId: randomUUID() });
    const response = await app.inject(importRequest());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "workspace_changed" });
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("runs one import per workspace and frees the slot however an import ends", async () => {
    const { app, parsed } = await createModuleApp();
    let finish!: (value: WorkspaceImportResult) => void;
    vi.mocked(importWorkspace).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = app.inject(importRequest());
    await vi.waitFor(() => expect(importWorkspace).toHaveBeenCalledTimes(1));

    const second = await app.inject(importRequest());
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
    expect(second.json()).toMatchObject({ code: "import_in_progress", error: WORKSPACE_IMPORT_RUNNING_MESSAGE });
    expect(parsed.count).toBe(1);

    finish({ imported: { leads: 1 } } as unknown as WorkspaceImportResult);
    expect((await first).statusCode).toBe(200);

    // A refused import, an unreadable body and an oversized body each free it too.
    vi.mocked(importWorkspace).mockRejectedValueOnce(new OpError("CONFLICT", "This workspace already has leads, lists or campaigns."));
    expect((await app.inject(importRequest())).statusCode).toBe(409);
    expect((await app.inject(importRequest("{not json", { "content-type": "application/json" }))).statusCode).toBe(400);
    expect((await app.inject(importRequest(JSON.stringify({ pad: "x".repeat(51 * 1024 * 1024) }), { "content-type": "application/json" }))).statusCode).toBe(413);
    vi.mocked(importWorkspace).mockResolvedValueOnce({ imported: { leads: 2 } } as unknown as WorkspaceImportResult);
    expect((await app.inject(importRequest())).statusCode).toBe(200);
  });

  it("keeps the slot until the import finishes when the client hangs up during it", async () => {
    const { app } = await createModuleApp();
    let finish!: (value: WorkspaceImportResult) => void;
    vi.mocked(importWorkspace).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const upload = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/workspace/import", headers: { cookie: "session=1", "content-type": "application/json" } });
    upload.on("error", () => undefined);
    upload.end(JSON.stringify(exportedFile));
    await vi.waitFor(() => expect(importWorkspace).toHaveBeenCalledTimes(1));
    upload.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await app.inject(importRequest())).statusCode).toBe(429);
    finish({ imported: { leads: 1 } } as unknown as WorkspaceImportResult);
    vi.mocked(importWorkspace).mockResolvedValue({ imported: { leads: 0 } } as unknown as WorkspaceImportResult);
    await vi.waitFor(async () => expect((await app.inject(importRequest())).statusCode).toBe(200));
  });

  // Each import parks until the test finishes it, keyed by workspace.
  function parkImports() {
    const pending = new Map<string, () => void>();
    vi.mocked(importWorkspace).mockImplementation((ctx) => new Promise((resolve) => {
      pending.set(ctx.workspaceId, () => resolve({ imported: { leads: 0 } } as unknown as WorkspaceImportResult));
    }));
    return pending;
  }
  const into = (id: string) => importRequest(exportedFile, { "x-workspace-id": id });

  it("lets other workspaces import while one workspace's import runs", async () => {
    const { app, parsed } = await createModuleApp();
    const pending = parkImports();
    const [busy, other] = [randomUUID(), randomUUID()];
    const first = app.inject(into(busy));
    await vi.waitFor(() => expect(pending.has(busy)).toBe(true));

    const again = await app.inject(into(busy));
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: "import_in_progress", error: WORKSPACE_IMPORT_RUNNING_MESSAGE });

    const elsewhere = app.inject(into(other));
    await vi.waitFor(() => expect(pending.has(other)).toBe(true));
    pending.get(other)!();
    expect((await elsewhere).statusCode).toBe(200);
    pending.get(busy)!();
    expect((await first).statusCode).toBe(200);
    expect(parsed.count).toBe(2);
  });

  it(`runs at most ${WORKSPACE_IMPORT_CONCURRENCY} imports at once across workspaces`, async () => {
    expect(WORKSPACE_IMPORT_CONCURRENCY).toBe(2);
    const { app, parsed } = await createModuleApp();
    const pending = parkImports();
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    const running = [app.inject(into(first)), app.inject(into(second))];
    await vi.waitFor(() => expect(pending.size).toBe(2));

    const refused = await app.inject(into(third));
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60");
    expect(refused.json()).toMatchObject({ code: "import_in_progress", error: WORKSPACE_IMPORT_BUSY_MESSAGE });
    expect(parsed.count).toBe(2);

    // A finished import frees a server slot for the next workspace.
    pending.get(first)!();
    expect((await running[0]!).statusCode).toBe(200);
    const retried = app.inject(into(third));
    await vi.waitFor(() => expect(pending.has(third)).toBe(true));
    pending.get(third)!();
    pending.get(second)!();
    expect((await retried).statusCode).toBe(200);
    expect((await running[1]!).statusCode).toBe(200);
  });

  it("stops an upload that has not fully arrived by the deadline with 408, without holding up anyone else", async () => {
    expect(WORKSPACE_IMPORT_UPLOAD_DEADLINE_MS).toBe(120_000);
    const { app, parsed } = await createModuleApp({ importUploadDeadlineMs: 100 });
    const slowWorkspace = randomUUID();
    const upload = new Readable({ read() {} });
    upload.push('{"format":"inboxjoy-workspace","version":1,"leads":[{},');
    const slow = app.inject(importRequest(upload, { "x-workspace-id": slowWorkspace, "content-type": "application/json" }));

    // Another workspace imports while the slow upload drips.
    vi.mocked(importWorkspace).mockResolvedValueOnce({ imported: { leads: 0 } } as unknown as WorkspaceImportResult);
    expect((await app.inject(into(randomUUID()))).statusCode).toBe(200);

    const response = await slow;
    upload.destroy();
    expect(response.statusCode).toBe(408);
    expect(response.json()).toMatchObject({ error: WORKSPACE_IMPORT_UPLOAD_TIMEOUT_MESSAGE });
    expect(response.headers.connection).toBe("close");
    expect(parsed.count).toBe(1);

    // The slow workspace's slot is free again.
    vi.mocked(importWorkspace).mockResolvedValueOnce({ imported: { leads: 0 } } as unknown as WorkspaceImportResult);
    expect((await app.inject(into(slowWorkspace))).statusCode).toBe(200);
    expect(importWorkspace).toHaveBeenCalledTimes(2);
  });

  it("answers a stalled upload over a real connection with 408 and closes it", async () => {
    const { app, parsed } = await createModuleApp({ importUploadDeadlineMs: 100 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const upload = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/workspace/import", headers: { cookie: "session=1", "content-type": "application/json", "content-length": String(40 * 1024 * 1024) } });
    upload.on("error", () => undefined);
    const answered = new Promise<{ status?: number; body: string; closed: Promise<void> }>((resolve) => {
      upload.on("response", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        const closed = new Promise<void>((done) => response.socket.once("close", () => done()));
        response.on("end", () => resolve({ status: response.statusCode, body, closed }));
      });
    });
    upload.write('{"format":"inboxjoy-workspace","version":1,"leads":[{},');

    const { status, body, closed } = await answered;
    expect(status).toBe(408);
    expect(JSON.parse(body)).toMatchObject({ error: WORKSPACE_IMPORT_UPLOAD_TIMEOUT_MESSAGE });
    await closed;
    upload.destroy();
    expect(parsed.count).toBe(0);
    vi.mocked(importWorkspace).mockResolvedValueOnce({ imported: { leads: 0 } } as unknown as WorkspaceImportResult);
    expect((await app.inject(importRequest())).statusCode).toBe(200);
  });

  it("times only the upload, not the import that follows it", async () => {
    const { app } = await createModuleApp({ importUploadDeadlineMs: 50 });
    vi.mocked(importWorkspace).mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ imported: { leads: 3 } } as unknown as WorkspaceImportResult), 150)));
    const response = await app.inject(importRequest());
    expect(response.statusCode).toBe(200);
    expect(response.headers.connection).not.toBe("close");
  });

  it("stops an upload with more objects or nesting than a workspace file can hold while it streams", async () => {
    const { app, parsed } = await createModuleApp();
    const tooMany = `{"format":"inboxjoy-workspace","version":1,"workspace":{"name":"x"},"leads":[${"{},".repeat(WORKSPACE_TRANSFER_SHAPE.maxContainers)}{}]}`;
    const many = await app.inject(importRequest(tooMany, { "content-type": "application/json" }));
    expect(many.statusCode).toBe(400);
    expect(many.json()).toMatchObject({ code: "import_too_large" });

    const tooDeep = `{"format":"inboxjoy-workspace","version":1,"workspace":{"name":"x"},"sequences":[{"name":"x","steps":[{"delayDays":0,"subject":"x","bodyText":"x","variables":{"a":${"[".repeat(5_000)}${"]".repeat(5_000)}}}]}]}`;
    const deep = await app.inject(importRequest(tooDeep, { "content-type": "application/json" }));
    expect(deep.statusCode).toBe(400);
    expect(deep.json()).toMatchObject({ code: "invalid_export" });

    expect(parsed.count).toBe(0);
    expect(importWorkspace).not.toHaveBeenCalled();
    // And the slot is free again afterwards.
    vi.mocked(importWorkspace).mockResolvedValueOnce({ imported: { leads: 0 } } as unknown as WorkspaceImportResult);
    expect((await app.inject(importRequest())).statusCode).toBe(200);
  });

  it("stops uploads over the size limit with 413", async () => {
    const { app } = await createModuleApp();
    const response = await app.inject(importRequest(JSON.stringify({ pad: "x".repeat(51 * 1024 * 1024) }), { "content-type": "application/json" }));
    expect(response.statusCode).toBe(413);
    expect(importWorkspace).not.toHaveBeenCalled();
  });

  it("reports owner-only and non-empty refusals from the import", async () => {
    const { app } = await createModuleApp();
    vi.mocked(importWorkspace).mockRejectedValueOnce(new OpError("FORBIDDEN", "Only the workspace owner can export or import the workspace."));
    expect((await app.inject(importRequest())).statusCode).toBe(403);
    vi.mocked(importWorkspace).mockRejectedValueOnce(new OpError("CONFLICT", "This workspace already has leads, lists or campaigns."));
    expect((await app.inject(importRequest())).statusCode).toBe(409);
  });
});
