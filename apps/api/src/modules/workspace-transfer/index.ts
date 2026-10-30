import { resolveEdition, type AppEnv } from "@inboxjoy/config";
import { createWorkspaceFileShapeCheck, exportWorkspace, importWorkspace, OpError, toImportOpError, WORKSPACE_TRANSFER_LIMITS, WorkspaceTransferError } from "@inboxjoy/core";
import type { InboxJoyDb } from "@inboxjoy/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Transform, type Readable } from "node:stream";

// Workspace export/import (docs/workspace-transfer.md).
//
// Browser sessions only. An API key is a workspace-pinned machine credential
// that always resolves as "owner", whoever created it, so it cannot prove a
// person chose to dump every lead (export) or overwrite workspace settings
// (import). The same reasoning keeps these out of MCP: they are plain
// functions, not registered operations, so no MCP tool exists for them.

export const WORKSPACE_TRANSFER_KEY_MESSAGE = "Workspace export and import need a signed-in browser session. API keys cannot use them.";
export const WORKSPACE_IMPORT_BUSY_MESSAGE = "Other workspace imports are running on this server. Try again in a minute.";
export const WORKSPACE_IMPORT_RUNNING_MESSAGE = "An import into this workspace is already running. Wait for it to finish.";
export const WORKSPACE_IMPORT_UPLOAD_TIMEOUT_MESSAGE = "The upload took longer than 2 minutes. Try again on a faster connection, or move leads separately with CSV import.";
// Imports this API process runs at once, across all workspaces: each one holds
// up to 50 MB of JSON in memory and a long transaction. One workspace never
// has more than one.
export const WORKSPACE_IMPORT_CONCURRENCY = 2;
// How long an import's body may take to arrive, from the pre-body check. A
// slow or stalled upload otherwise holds an import slot until the 5-minute
// request timeout. 50 MB in 2 minutes needs about 3.5 Mbit/s; a typical file
// is a few MB.
export const WORKSPACE_IMPORT_UPLOAD_DEADLINE_MS = 120_000;
const OWNER_ONLY_MESSAGE = "Only the workspace owner can export or import the workspace.";
const UNVERIFIED_MESSAGE = "Verify your email address before importing a workspace. Check your inbox for the verification link.";
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SessionUser = { id: string; emailVerified: boolean };
type SessionMembership = { workspaceId: string; role: string };

type WorkspaceTransferOptions = {
  db?: InboxJoyDb;
  env?: Pick<AppEnv, "INBOXJOY_EDITION">;
  // Written into each export so an import can say where a file came from.
  // Defaults to the edition from env and INBOXJOY_VERSION (the release tag).
  source?: { edition?: string | null; appVersion?: string | null };
  // The app's own session and membership lookups (app.ts). The auth
  // preHandler runs only after Fastify has parsed the body, so these routes
  // repeat its session and owner check first. Without them every request is
  // refused.
  sessionUser?: (request: FastifyRequest) => Promise<SessionUser | null>;
  sessionMembership?: (userId: string, workspaceId?: string) => PromiseLike<SessionMembership[]>;
  // Defaults to WORKSPACE_IMPORT_UPLOAD_DEADLINE_MS; tests shorten it.
  importUploadDeadlineMs?: number;
};

function exportSource(options: WorkspaceTransferOptions) {
  return options.source ?? {
    edition: options.env ? resolveEdition(options.env) : null,
    appVersion: process.env.INBOXJOY_VERSION?.trim() || null,
  };
}

function refuse(request: FastifyRequest, reply: FastifyReply, statusCode: number, error: string, code?: string) {
  return reply.code(statusCode).send({ error, ...(code ? { code } : {}), correlationId: request.id });
}

// Passes the upload through unchanged and fails it with a 400 as soon as it
// holds more objects or nesting than a workspace file can, or with a 408 when
// it has not fully arrived by the deadline.
function guardUpload(payload: Readable, reply: FastifyReply, deadlineMs: number): Transform {
  const check = createWorkspaceFileShapeCheck();
  const guarded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        check(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof WorkspaceTransferError ? toImportOpError(error) : error as Error);
      }
    },
  });
  // pipe() does not pass on a client that goes away mid-upload; ending the
  // guarded stream with an error lets Fastify finish the request.
  payload.on("error", (error) => guarded.destroy(error));
  payload.on("close", () => { if (!payload.readableEnded) guarded.destroy(new Error("The upload was interrupted.")); });
  const deadline = setTimeout(() => {
    if (payload.readableEnded || guarded.destroyed) return;
    // Close the connection after the 408 rather than drain the rest of a
    // slow upload.
    reply.header("connection", "close");
    guarded.destroy(Object.assign(new Error(WORKSPACE_IMPORT_UPLOAD_TIMEOUT_MESSAGE), { statusCode: 408 }));
  }, deadlineMs);
  const stopDeadline = () => clearTimeout(deadline);
  payload.once("end", stopDeadline);
  guarded.once("close", stopDeadline);
  reply.raw.once("close", stopDeadline);
  payload.pipe(guarded);
  return guarded;
}

export function registerWorkspaceTransferRoutes(app: FastifyInstance, options: WorkspaceTransferOptions): void {
  // Who passed the pre-body check, so the handler can confirm the auth hook
  // resolved the same person and workspace.
  const authorized = new WeakMap<FastifyRequest, { userId: string; workspaceId: string }>();
  // Import slots in this process (one app per process): one per workspace, and
  // WORKSPACE_IMPORT_CONCURRENCY in all, so one tenant's import never waits on
  // another's unless the server is already at its cap. A slot is held from the
  // pre-body check until the handler settles, or until the response closes
  // when the handler never runs (refused, unreadable, oversized or late body,
  // client gone mid-upload). A client that hangs up during the import does
  // not free it early.
  const importingWorkspaces = new Set<string>();
  const uploadDeadlineMs = options.importUploadDeadlineMs ?? WORKSPACE_IMPORT_UPLOAD_DEADLINE_MS;
  type ImportSlot = { workspaceId: string; inHandler: boolean; released: boolean };
  const slots = new WeakMap<FastifyRequest, ImportSlot>();
  const release = (slot: ImportSlot) => {
    if (slot.released) return;
    slot.released = true;
    importingWorkspaces.delete(slot.workspaceId);
  };

  // preParsing: after the rate limit (an onRequest hook), before a byte of
  // the body is read. An API key, an anonymous or unknown session, a
  // non-owner, an unverified importer, a second import into the same
  // workspace and an import past the server's cap are all refused here, so
  // none of them can make the API parse a 50 MB upload.
  // Every refusal returns the reply, which Fastify waits on before going on.
  const ownerFirst = (purpose: "export" | "import") => async (request: FastifyRequest, reply: FastifyReply, payload: Readable) => {
    if (request.headers.authorization?.startsWith("Bearer ij_")) {
      return refuse(request, reply, 403, WORKSPACE_TRANSFER_KEY_MESSAGE, "FORBIDDEN");
    }
    if (!request.headers.cookie || !options.sessionUser || !options.sessionMembership) {
      return refuse(request, reply, 401, "Authentication required.");
    }
    let user: SessionUser | null = null;
    try {
      user = await options.sessionUser(request);
    } catch {
      user = null;
    }
    if (!user) return refuse(request, reply, 401, "Authentication required.");

    // Same workspace pin and answers as the auth hook in app.ts.
    const workspaceHeader = request.headers["x-workspace-id"];
    if (workspaceHeader !== undefined && (typeof workspaceHeader !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceHeader))) {
      return refuse(request, reply, 409, "Your workspace changed. Reload to continue.", "workspace_changed");
    }
    const [membership] = await options.sessionMembership(user.id, workspaceHeader);
    if (!membership) {
      return workspaceHeader !== undefined
        ? refuse(request, reply, 409, "Your workspace changed. Reload to continue.", "workspace_changed")
        : refuse(request, reply, 403, "No active workspace membership found.");
    }
    if (membership.role !== "owner") return refuse(request, reply, 403, OWNER_ONLY_MESSAGE, "FORBIDDEN");
    authorized.set(request, { userId: user.id, workspaceId: membership.workspaceId });
    if (purpose === "export") return payload;

    if (!user.emailVerified) return refuse(request, reply, 403, UNVERIFIED_MESSAGE, "email_unverified");
    const busy = importingWorkspaces.has(membership.workspaceId)
      ? WORKSPACE_IMPORT_RUNNING_MESSAGE
      : importingWorkspaces.size >= WORKSPACE_IMPORT_CONCURRENCY ? WORKSPACE_IMPORT_BUSY_MESSAGE : null;
    if (busy) {
      reply.header("retry-after", "60");
      return refuse(request, reply, 429, busy, "import_in_progress");
    }
    importingWorkspaces.add(membership.workspaceId);
    const slot: ImportSlot = { workspaceId: membership.workspaceId, inHandler: false, released: false };
    slots.set(request, slot);
    // "close" fires once the response is sent or the connection drops.
    reply.raw.once("close", () => { if (!slot.inHandler) release(slot); });
    return guardUpload(payload, reply, uploadDeadlineMs);
  };

  // The auth hook resolves the workspace again after the upload; it must be
  // the one checked before it.
  const sameAsChecked = (request: FastifyRequest) => {
    const checked = authorized.get(request);
    return checked !== undefined && checked.userId === request.userId && checked.workspaceId === request.workspaceId;
  };

  app.get("/v1/workspace/export", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preParsing: ownerFirst("export"),
  }, async (request, reply) => {
    if (request.authKind !== "session") return refuse(request, reply, 403, WORKSPACE_TRANSFER_KEY_MESSAGE, "FORBIDDEN");
    if (!sameAsChecked(request)) return refuse(request, reply, 409, "Your workspace changed. Reload to continue.", "workspace_changed");
    if (!options.db) throw new OpError("UNAVAILABLE", "Workspace export is unavailable.");
    const { file, filename } = await exportWorkspace({ db: options.db, workspaceId: request.workspaceId, userId: request.userId }, { source: exportSource(options) });
    request.log.info({ workspaceId: request.workspaceId, leads: file.leads.length, lists: file.lists.length, sequences: file.sequences.length }, "workspace exported");
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("cache-control", "no-store")
      .send(JSON.stringify(file));
  });

  app.post<{ Body: unknown }>("/v1/workspace/import", {
    bodyLimit: WORKSPACE_TRANSFER_LIMITS.maxBytes,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    preParsing: ownerFirst("import"),
  }, async (request, reply) => {
    const slot = slots.get(request);
    // The connection closed after the upload and before this ran: nobody is
    // waiting, and the slot already went to the next import.
    if (!slot || slot.released) return refuse(request, reply, 409, "The upload was interrupted. Nothing was imported.", "import_interrupted");
    slot.inHandler = true;
    try {
      if (request.authKind !== "session") return refuse(request, reply, 403, WORKSPACE_TRANSFER_KEY_MESSAGE, "FORBIDDEN");
      if (!sameAsChecked(request)) return refuse(request, reply, 409, "Your workspace changed. Reload to continue.", "workspace_changed");
      if (!options.db) throw new OpError("UNAVAILABLE", "Workspace import is unavailable.");
      const result = await importWorkspace({ db: options.db, workspaceId: request.workspaceId, userId: request.userId }, request.body);
      request.log.info({ workspaceId: request.workspaceId, imported: result.imported }, "workspace imported");
      return result;
    } finally {
      release(slot);
    }
  });
}
