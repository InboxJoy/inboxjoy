import { loadAppEnv } from "@inboxjoy/config";
import { decryptSecret, readMailboxCredentials } from "@inboxjoy/core";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("SMTP mailbox integration", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const key = randomBytes(32);
  const env = loadAppEnv({ NODE_ENV: "test", DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test", API_BASE_URL: "https://api.example.test", WEB_BASE_URL: "https://app.example.test", AUTH_SECRET: "smtp-integration-auth-secret-at-least-32-characters", LOG_LEVEL: "silent", SMTP_MAILBOXES_ENABLED: "true", MAILBOX_CREDENTIALS_KEY: key.toString("base64") });
  const body = { email: `smtp-${randomUUID()}@example.com`, displayName: "SMTP Inbox", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "smtp-user", password: "smtp-secret-password" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "imap-user", password: "imap-secret-password" } };
  const smtpVerify = vi.fn();
  const imapConnect = vi.fn();
  const smtp = { transportFactory: () => ({ verify: smtpVerify, close: vi.fn() }), imapFactory: () => ({ connect: imapConnect, mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 123n, uidNext: 51 }), logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn() }) };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: AuthenticatedSession;
  let other: AuthenticatedSession;
  let member: AuthenticatedSession;

  beforeAll(async () => {
    app = await buildApp({ env, db, smtp });
    owner = await createAuthenticatedSession(app, "SMTP Owner");
    other = await createAuthenticatedSession(app, "SMTP Other Workspace");
    member = await createAuthenticatedSession(app, "SMTP Member");
    await db.insert(schema.memberships).values({ id: randomUUID(), workspaceId: owner.workspaceId, userId: member.userId, role: "member", status: "active", joinedAt: new Date() });
  });

  beforeEach(async () => {
    await app.close();
    smtpVerify.mockReset().mockResolvedValue(true);
    imapConnect.mockReset().mockResolvedValue(undefined);
    await db.delete(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, owner.workspaceId));
    app = await buildApp({ env, db, smtp });
  });

  afterAll(async () => {
    await app?.close();
    for (const session of [owner, other, member]) {
      if (session) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    }
    for (const session of [owner, other, member]) {
      if (!session) continue;
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, session.userId));
    }
    await pool.end();
  });

  const headers = () => ({ cookie: owner.cookie, "x-workspace-id": owner.workspaceId });
  const connect = () => app.inject({ method: "POST", url: "/v1/inboxes/smtp", headers: headers(), payload: body });
  const stored = async (id: string) => (await db.select().from(schema.mailboxCredentials).where(eq(schema.mailboxCredentials.emailAccountId, id)))[0]!;

  // Minimal fixture for an enrollment row: enough foreign keys (contact, sequence, sequence
  // version) to satisfy schema constraints without exercising the full sequence/enroll API.
  const seedEnrollment = async (emailAccountId: string, options: { status?: "paused" | "active" | "scheduled"; stopReason?: string | null; statusBeforePause?: "scheduled" | "active" | null } = {}) => {
    const contactId = randomUUID();
    const email = `enrollment-${randomUUID()}@example.com`;
    await db.insert(schema.contacts).values({ id: contactId, workspaceId: owner.workspaceId, email, normalizedEmail: email, status: "active" });
    const sequenceId = randomUUID();
    await db.insert(schema.sequences).values({ id: sequenceId, workspaceId: owner.workspaceId, name: `SMTP resume ${randomUUID()}` });
    const sequenceVersionId = randomUUID();
    await db.insert(schema.sequenceVersions).values({ id: sequenceVersionId, workspaceId: owner.workspaceId, sequenceId, version: 1 });
    const id = randomUUID();
    const status = options.status ?? "paused";
    await db.insert(schema.enrollments).values({
      id, workspaceId: owner.workspaceId, contactId, sequenceId, sequenceVersionId, emailAccountId,
      status, stopReason: options.stopReason ?? "mailbox_auth_expired", statusBeforePause: options.statusBeforePause ?? "active",
      pausedAt: status === "paused" ? new Date() : null,
    });
    return id;
  };
  const enrollmentStatus = async (id: string) => (await db.select({ status: schema.enrollments.status, stopReason: schema.enrollments.stopReason, statusBeforePause: schema.enrollments.statusBeforePause, pausedAt: schema.enrollments.pausedAt }).from(schema.enrollments).where(eq(schema.enrollments.id, id)))[0]!;

  it("returns 404 with the feature disabled", async () => {
    await app.close();
    app = await buildApp({ env: { ...env, SMTP_MAILBOXES_ENABLED: false }, db, smtp });
    expect((await connect()).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/inboxes", headers: headers() })).json().features).toEqual({ smtp: false });
    expect(smtpVerify).not.toHaveBeenCalled();
  });

  it("returns 403 for members on all SMTP write endpoints", async () => {
    for (const request of [{ method: "POST", url: "/v1/inboxes/smtp", payload: body }, { method: "PATCH", url: `/v1/inboxes/${randomUUID()}/smtp`, payload: body }, { method: "POST", url: `/v1/inboxes/${randomUUID()}/verify` }] as const) {
      expect((await app.inject({ ...request, headers: { cookie: member.cookie, "x-workspace-id": owner.workspaceId } })).statusCode).toBe(403);
    }
    expect(smtpVerify).not.toHaveBeenCalled();
  });

  it.each(["smtp", "imap"])("returns 400 and inserts no accounts or credentials after %s verification failure", async (kind) => {
    if (kind === "smtp") smtpVerify.mockRejectedValue(Object.assign(new Error(body.smtp.password), { code: "EAUTH" }));
    else imapConnect.mockRejectedValue(Object.assign(new Error(body.imap.password), { authenticationFailed: true }));
    const response = await connect();
    expect(response.statusCode).toBe(400);
    expect(response.json().field).toBe(`${kind}.auth`);
    expect(response.body).not.toContain(body.smtp.password);
    expect(response.body).not.toContain(body.imap.password);
    expect(await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, owner.workspaceId))).toHaveLength(0);
    expect(await db.select().from(schema.mailboxCredentials).where(eq(schema.mailboxCredentials.workspaceId, owner.workspaceId))).toHaveLength(0);
  });

  it("atomically connects an active account with ciphertext and a seeded IMAP cursor", async () => {
    const response = await connect();
    expect(response.statusCode).toBe(201);
    const id = response.json().inbox.id as string;
    const [account] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, id));
    expect(account).toMatchObject({ provider: "smtp", status: "active", normalizedEmail: body.email, composioConnectedAccountId: `smtp:${id}` });
    const credentials = await stored(id);
    expect(credentials).toMatchObject({ workspaceId: owner.workspaceId, lastImapUidvalidity: 123n, lastImapUid: 50n, lastVerifyError: null });
    expect(credentials.verifiedAt).toBeInstanceOf(Date);
    for (const [field, ciphertext, plaintext] of [["smtp_password", credentials.smtpPasswordEncrypted, body.smtp.password], ["imap_password", credentials.imapPasswordEncrypted, body.imap.password]]) {
      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext).toMatch(/^v1\./);
      expect(decryptSecret(ciphertext!, { keys: new Map([[credentials.keyVersion, key]]), aad: `${id}:${field}` })).toBe(plaintext);
    }
    const publicCredentials = await readMailboxCredentials(db, id);
    expect(publicCredentials?.smtp).toEqual({ host: body.smtp.host, port: body.smtp.port, secure: body.smtp.secure, username: body.smtp.username });
    expect(JSON.stringify(publicCredentials, (_name, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(/password|v1\./i);
    const listed = await app.inject({ method: "GET", url: "/v1/inboxes", headers: headers() });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ features: { smtp: true }, inboxes: [{ id, smtp: publicCredentials?.smtp, imap: publicCredentials?.imap }] });
    for (const output of [response.body, listed.body]) {
      expect(output).not.toContain(body.smtp.password);
      expect(output).not.toContain(body.imap.password);
      expect(output).not.toContain(credentials.smtpPasswordEncrypted);
      expect(output).not.toMatch(/password/i);
    }
  });

  it("returns 409 for a normalized duplicate active address", async () => {
    expect((await connect()).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/inboxes/smtp", headers: headers(), payload: { ...body, email: ` ${body.email.toUpperCase()} ` } })).statusCode).toBe(409);
    expect(await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.workspaceId, owner.workspaceId))).toHaveLength(1);
  });

  it("serializes concurrent duplicate connect requests", async () => {
    const results = await Promise.all([connect(), connect()]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(await db.select().from(schema.mailboxCredentials).where(eq(schema.mailboxCredentials.workspaceId, owner.workspaceId))).toHaveLength(1);
  });

  it("does not reactivate an errored mailbox into a duplicate active address", async () => {
    const firstId = (await connect()).json().inbox.id as string;
    await db.update(schema.emailAccounts).set({ status: "error" }).where(eq(schema.emailAccounts.id, firstId));
    expect((await connect()).statusCode).toBe(201);
    for (const request of [{ method: "POST", url: `/v1/inboxes/${firstId}/verify` }, { method: "PATCH", url: `/v1/inboxes/${firstId}/smtp`, payload: {} }] as const) {
      expect((await app.inject({ ...request, headers: headers() })).statusCode).toBe(409);
    }
    expect((await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, firstId)))[0]?.status).toBe("error");
  });

  it("blocks cross-workspace GET, credential updates and verification", async () => {
    const connected = await connect();
    const id = connected.json().inbox.id as string;
    const otherHeaders = { cookie: other.cookie, "x-workspace-id": other.workspaceId };
    const response = await app.inject({ method: "GET", url: "/v1/inboxes", headers: otherHeaders });
    expect(response.json().inboxes).toEqual([]);
    expect(response.body).not.toContain(body.smtp.username);
    for (const request of [{ method: "GET", url: `/v1/inboxes/${id}/status` }, { method: "PATCH", url: `/v1/inboxes/${id}/smtp`, payload: { smtp: { password: "attacker-secret" } } }, { method: "POST", url: `/v1/inboxes/${id}/verify` }] as const) {
      expect((await app.inject({ ...request, headers: otherHeaders })).statusCode).toBe(404);
    }
    expect((await stored(id)).workspaceId).toBe(owner.workspaceId);
    expect(smtpVerify).toHaveBeenCalledOnce();
  });

  it("retains old credentials on failed PATCH and stores only a safe verification error", async () => {
    const id = (await connect()).json().inbox.id as string;
    const before = await stored(id);
    smtpVerify.mockRejectedValue(Object.assign(new Error("replacement-secret"), { code: "EAUTH" }));
    const response = await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { password: "replacement-secret", host: "changed.example.com" } } });
    expect(response.statusCode).toBe(400);
    const after = await stored(id);
    expect(after.smtpPasswordEncrypted).toBe(before.smtpPasswordEncrypted);
    expect(after.imapPasswordEncrypted).toBe(before.imapPasswordEncrypted);
    expect(after.smtpHost).toBe(before.smtpHost);
    expect(after.lastVerifyError).not.toContain("replacement-secret");
    expect(after.lastVerifyError).toContain("authentication failed");
    expect((await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.id, id)))[0]?.status).toBe("error");
  });

  it("updates settings and secrets only after a successful re-verification", async () => {
    const id = (await connect()).json().inbox.id as string;
    const response = await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { email: " UPDATED@example.com ", displayName: "Updated Inbox", smtp: { password: "replacement-secret" } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().inbox).toMatchObject({ status: "active", displayName: "Updated Inbox", email: "updated@example.com" });
    expect(response.body).not.toContain("replacement-secret");
    const row = await stored(id);
    const read = await readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map([[row.keyVersion, key]]) });
    expect(read?.smtp.password).toBe("replacement-secret");
    expect(read?.imap.password).toBe(body.imap.password);
    expect(row.lastImapUid).toBe(50n);
  });

  it("updates verification health without replacing credentials or moving the polling cursor", async () => {
    const id = (await connect()).json().inbox.id as string;
    const before = await stored(id);
    imapConnect.mockRejectedValue(Object.assign(new Error(body.imap.password), { authenticationFailed: true }));
    expect((await app.inject({ method: "POST", url: `/v1/inboxes/${id}/verify`, headers: headers() })).statusCode).toBe(400);
    expect((await stored(id)).lastVerifyError).toContain("IMAP authentication failed");
    imapConnect.mockResolvedValue(undefined);
    const response = await app.inject({ method: "POST", url: `/v1/inboxes/${id}/verify`, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().inbox.status).toBe("active");
    const after = await stored(id);
    expect(after.lastVerifyError).toBeNull();
    expect(after.verifiedAt!.getTime()).toBeGreaterThanOrEqual(before.verifiedAt!.getTime());
    expect(after.smtpPasswordEncrypted).toBe(before.smtpPasswordEncrypted);
    expect(after.lastImapUid).toBe(before.lastImapUid);
  });

  it.each([
    ["re-verification", (id: string) => ({ method: "POST" as const, url: `/v1/inboxes/${id}/verify` })],
    ["a credentials save", (id: string) => ({ method: "PATCH" as const, url: `/v1/inboxes/${id}/smtp`, payload: { imap: { password: "replacement-imap-secret" } } })],
  ])("clears the worker's IMAP poll backoff and stuck-message state after %s", async (_label, request) => {
    const id = (await connect()).json().inbox.id as string;
    const broken = { imapPollFailures: 6, imapPollRetryAt: new Date(Date.now() + 3_600_000), imapStuckUid: 77n, imapStuckAttempts: 2, lastVerifyError: "Inbox sync keeps failing. Check the IMAP host, port and INBOX access." };
    await db.update(schema.mailboxCredentials).set(broken).where(eq(schema.mailboxCredentials.emailAccountId, id));

    // A failed attempt changes nothing: the mailbox is still broken, so it keeps backing off.
    imapConnect.mockRejectedValue(Object.assign(new Error(body.imap.password), { authenticationFailed: true }));
    expect((await app.inject({ ...request(id), headers: headers() })).statusCode).toBe(400);
    expect(await stored(id)).toMatchObject({ imapPollFailures: 6, imapPollRetryAt: broken.imapPollRetryAt, imapStuckUid: 77n, imapStuckAttempts: 2 });

    imapConnect.mockResolvedValue(undefined);
    expect((await app.inject({ ...request(id), headers: headers() })).statusCode).toBe(200);
    expect(await stored(id)).toMatchObject({ imapPollFailures: 0, imapPollRetryAt: null, imapStuckUid: null, imapStuckAttempts: 0, lastVerifyError: null, lastImapUid: 50n });
  });

  it("decrypts with the previous key and keeps current-key envelopes readable after its removal", async () => {
    const id = (await connect()).json().inbox.id as string;
    const currentKey = randomBytes(32).toString("base64");
    const rotatedEnv = { ...env, MAILBOX_CREDENTIALS_KEY: currentKey, MAILBOX_CREDENTIALS_KEY_PREVIOUS: key.toString("base64") };
    await app.close();
    app = await buildApp({ env: rotatedEnv, db, smtp });
    expect((await app.inject({ method: "POST", url: `/v1/inboxes/${id}/verify`, headers: headers() })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { password: "rotated-secret" } } })).statusCode).toBe(200);
    await app.close();
    app = await buildApp({ env: { ...rotatedEnv, MAILBOX_CREDENTIALS_KEY_PREVIOUS: undefined }, db, smtp });
    expect((await app.inject({ method: "POST", url: `/v1/inboxes/${id}/verify`, headers: headers() })).statusCode).toBe(200);
  });

  it("requires a password when only the host changes, and never attempts verification", async () => {
    const id = (await connect()).json().inbox.id as string;
    smtpVerify.mockClear();
    imapConnect.mockClear();
    const response = await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { host: "changed.example.com" } } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ field: "smtp.password", error: "Re-enter the password to change the server or username." });
    expect(smtpVerify).not.toHaveBeenCalled();
    expect(imapConnect).not.toHaveBeenCalled();
    expect((await stored(id)).smtpHost).toBe(body.smtp.host);
  });

  it("changes only `secure` without a password and still verifies", async () => {
    const id = (await connect()).json().inbox.id as string;
    const response = await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { secure: true } } });
    expect(response.statusCode).toBe(200);
    expect(smtpVerify).toHaveBeenCalled();
    const row = await stored(id);
    const read = await readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map([[row.keyVersion, key]]) });
    expect(read?.smtp).toMatchObject({ secure: true, host: body.smtp.host, password: body.smtp.password });
  });

  it("changes the host when the request supplies a fresh password", async () => {
    const id = (await connect()).json().inbox.id as string;
    const response = await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { host: "changed.example.com", password: "fresh-password" } } });
    expect(response.statusCode).toBe(200);
    const row = await stored(id);
    const read = await readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map([[row.keyVersion, key]]) });
    expect(read?.smtp).toMatchObject({ host: "changed.example.com", password: "fresh-password" });
  });

  it("resumes mailbox_auth_expired enrollments on a successful PATCH and a successful verify, leaving other reasons and other mailboxes untouched", async () => {
    const id = (await connect()).json().inbox.id as string;
    const otherMailboxId = (await app.inject({ method: "POST", url: "/v1/inboxes/smtp", headers: headers(), payload: { ...body, email: `smtp-other-${randomUUID()}@example.com` } })).json().inbox.id as string;
    const resumableOnPatch = await seedEnrollment(id, { statusBeforePause: "active" });
    const otherReason = await seedEnrollment(id, { stopReason: "manual_pause", statusBeforePause: "scheduled" });
    const otherMailbox = await seedEnrollment(otherMailboxId, { statusBeforePause: "active" });

    const patchResponse = await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { password: "patched-secret" } } });
    expect(patchResponse.statusCode).toBe(200);
    expect(await enrollmentStatus(resumableOnPatch)).toMatchObject({ status: "active", stopReason: null, statusBeforePause: null, pausedAt: null });
    expect((await enrollmentStatus(otherReason)).status).toBe("paused");
    expect((await enrollmentStatus(otherMailbox)).status).toBe("paused");

    const resumableOnVerify = await seedEnrollment(id, { statusBeforePause: "scheduled" });
    const verifyResponse = await app.inject({ method: "POST", url: `/v1/inboxes/${id}/verify`, headers: headers() });
    expect(verifyResponse.statusCode).toBe(200);
    expect(await enrollmentStatus(resumableOnVerify)).toMatchObject({ status: "scheduled", stopReason: null, statusBeforePause: null, pausedAt: null });
    expect((await enrollmentStatus(otherReason)).status).toBe("paused");
    expect((await enrollmentStatus(otherMailbox)).status).toBe("paused");
  });

  it("shares the 10/hour workspace budget across connect, PATCH and verify", async () => {
    const id = (await connect()).json().inbox.id as string;
    for (let attempt = 1; attempt < 10; attempt += 1) {
      const request = attempt % 2 ? { method: "POST", url: `/v1/inboxes/${id}/verify` } as const : { method: "PATCH", url: `/v1/inboxes/${id}/smtp`, payload: { displayName: "Verified" } } as const;
      expect((await app.inject({ ...request, headers: headers() })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "POST", url: `/v1/inboxes/${id}/verify`, headers: headers() })).statusCode).toBe(429);
    expect((await app.inject({ method: "PATCH", url: `/v1/inboxes/${id}/smtp`, headers: headers(), payload: { smtp: { password: "unused-secret" } } })).statusCode).toBe(429);
    expect((await connect()).statusCode).toBe(429);
  });
});
