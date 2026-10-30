import { buildSecretKeyMap, secretKeyVersion, isComposioProvider, readMailboxCredentials, removeMailbox, writeMailboxCredentials, warmupDailyLimit, warmupFullOn, type MailboxProvider, type MailboxConnection, type MailboxConnectionWithSecret } from "@inboxjoy/core";
import { createComposioClient, type ComposioClient, type MailProvider } from "@inboxjoy/composio";
import type { AppEnv } from "@inboxjoy/config";
import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertSafeMailHost, verifySmtp, verifyImap, SmtpSendError, ImapError, type SmtpFactoryOptions, type ImapFactoryOptions } from "@inboxjoy/smtp";

type InboxStatus = "connecting" | "active" | "expired" | "paused" | "error" | "disconnected" | "removed";
type Inbox = { id: string; provider: MailboxProvider; email: string | null; displayName: string; alias: string; status: InboxStatus; timezone: string; dailyLimit: number; hourlyLimit: number; sentToday: number; rampStartedOn: string | null; skipWarmup: boolean; warmupPercent: number; warmupCapToday: number; warmupFullOn: string | null; warmupPaused: boolean; composioConnectedAccountId: string; connectMode: "composio" | "smtp" | "disabled"; lastHealthCheckAt: string | null; smtp?: MailboxConnection; imap?: MailboxConnection };
type ScheduleInput = { dayOfWeek?: unknown; startTime?: unknown; endTime?: unknown; timezone?: unknown; isActive?: unknown };
export type InboxSmtpOptions = SmtpFactoryOptions & ImapFactoryOptions;
type SmtpBody = { email?: unknown; displayName?: unknown; smtp?: unknown; imap?: unknown };
type VerificationFailure = { error: string; field: string };

export function parseConnection(value: unknown, kind: "smtp" | "imap", existing?: MailboxConnectionWithSecret): { config: MailboxConnectionWithSecret } | VerificationFailure {
  if (value === undefined && existing) return { config: existing };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `Provide ${kind.toUpperCase()} connection settings.`, field: kind };
  const raw = { ...existing, ...value } as Record<string, unknown>;
  if (typeof raw.host !== "string" || !raw.host.trim() || raw.host.length > 253) return { error: "Provide a valid mail host.", field: `${kind}.host` };
  if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || !(kind === "smtp" ? [587, 465, 25, 2525] : [993, 143]).includes(raw.port)) return { error: "Choose an allowed mail port.", field: `${kind}.port` };
  if (typeof raw.secure !== "boolean") return { error: "Secure must be a boolean.", field: `${kind}.secure` };
  if (typeof raw.username !== "string" || !raw.username.trim() || raw.username.length > 320) return { error: "Provide a mail username.", field: `${kind}.username` };
  const host = raw.host.trim().toLowerCase();
  const username = raw.username.trim();
  // Reusing the stored password across a changed host/port/username would authenticate to a
  // different server with a secret the requester never supplied for that server. Require the
  // request's own value to carry a fresh password whenever the merged connection differs.
  if (existing && (host !== existing.host || raw.port !== existing.port || username !== existing.username)) {
    const ownPassword = (value as Record<string, unknown>).password;
    if (typeof ownPassword !== "string" || !ownPassword.length) return { error: "Re-enter the password to change the server or username.", field: `${kind}.password` };
  }
  if (typeof raw.password !== "string" || !raw.password.length || raw.password.length > 4096) return { error: "Provide a mail password.", field: `${kind}.password` };
  return { config: { host, port: raw.port, secure: raw.secure, username, password: raw.password } };
}

export function mailboxEmailFromProvider(value?: string | null): string | null {
  const match = value?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() ?? null;
}

export function registerInboxRoutes(app: FastifyInstance, env: AppEnv, db?: InboxJoyDb, composio = createComposioClient(env.COMPOSIO_API_KEY, undefined, env.COMPOSIO_TOOLKIT_VERSION), smtpOptions: InboxSmtpOptions = {}): (accountId: string) => Promise<void> {
  const pending = new Map<string, { provider: MailProvider; expiresAt: number }>();
  const memoryInboxes: Inbox[] = [];

  const warmupState = (rampStartedOn: string | null, dailyLimit: number, pausedDays = 0): Pick<Inbox, "rampStartedOn" | "skipWarmup" | "warmupPercent" | "warmupCapToday" | "warmupFullOn" | "warmupPaused"> => {
    const capToday = warmupDailyLimit(dailyLimit, rampStartedOn, new Date(), pausedDays);
    const percent = !rampStartedOn || dailyLimit <= 0 ? 100 : Math.min(100, Math.round((capToday / dailyLimit) * 100));
    return { rampStartedOn, skipWarmup: rampStartedOn === null, warmupPercent: percent, warmupCapToday: capToday, warmupFullOn: percent >= 100 ? null : warmupFullOn(dailyLimit, rampStartedOn, pausedDays), warmupPaused: pausedDays > 0 };
  };
  const toInbox = (row: typeof schema.emailAccounts.$inferSelect): Inbox => {
    return {
      id: row.id, provider: row.provider, email: row.email, displayName: row.displayName ?? row.email ?? "Address pending — reconnect", alias: row.alias,
      status: row.status, timezone: row.timezone, dailyLimit: row.dailyLimit, hourlyLimit: row.hourlyLimit, sentToday: 0,
      ...warmupState(row.rampStartedOn, row.dailyLimit, row.rampPausedDays ?? 0),
      composioConnectedAccountId: row.composioConnectedAccountId, connectMode: row.provider === "smtp" ? "smtp" : "composio", lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
    };
  };
  const allInboxes = async (workspaceId: string) => {
    if (!db) return memoryInboxes;
    const rows = await db.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, workspaceId), ne(schema.emailAccounts.status, "removed")));
    const today = new Date().toISOString().slice(0, 10);
    const usage = await db.select().from(schema.mailboxDailyUsage).where(and(eq(schema.mailboxDailyUsage.workspaceId, workspaceId), eq(schema.mailboxDailyUsage.usageDate, today)));
    const sentToday = new Map(usage.map((item) => [item.emailAccountId, item.acceptedCount]));
    return Promise.all(rows.map(async (row) => {
      const credentials = row.provider === "smtp" ? await readMailboxCredentials(db, row.id) : undefined;
      return { ...toInbox(row), sentToday: sentToday.get(row.id) ?? 0, ...(credentials ? { smtp: credentials.smtp, imap: credentials.imap } : {}) };
    }));
  };
  const findInbox = async (id: string, workspaceId: string) => (await allInboxes(workspaceId)).find((item) => item.id === id);
  const authConfig = (provider: MailProvider) => provider === "gmail" ? env.COMPOSIO_GMAIL_AUTH_CONFIG_ID : env.COMPOSIO_OUTLOOK_AUTH_CONFIG_ID;
  const canManageInboxes = (role: "owner" | "admin" | "member") => role === "owner" || role === "admin";
  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "Only workspace owners and admins can manage inboxes." });
  const verifyLimit = app.createRateLimit({ max: 10, timeWindow: 3_600_000, keyGenerator: (request) => request.workspaceId });
  const canVerify = async (request: FastifyRequest): Promise<boolean> => {
    const limit = await verifyLimit(request);
    return limit.isAllowed || !limit.isExceeded;
  };
  const smtpRouteOptions = {
    async preHandler(request: FastifyRequest, reply: FastifyReply) {
      if (env.SMTP_MAILBOXES_ENABLED && canManageInboxes(request.workspaceRole) && !await canVerify(request)) {
        return reply.code(429).send({ error: "SMTP mailbox verification is limited to 10 attempts per workspace per hour." });
      }
    },
    errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
      const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
      if (statusCode >= 500) request.log.error({ statusCode }, "SMTP mailbox request failed");
      return reply.code(statusCode).send({ error: statusCode < 500 ? "Invalid SMTP mailbox request." : "SMTP mailbox request failed." });
    },
  };
  const keys = buildSecretKeyMap({ current: env.MAILBOX_CREDENTIALS_KEY, previous: env.MAILBOX_CREDENTIALS_KEY_PREVIOUS });
  const key = env.MAILBOX_CREDENTIALS_KEY ? Buffer.from(env.MAILBOX_CREDENTIALS_KEY, "base64") : undefined;
  const keyVersion = key ? secretKeyVersion(key) : 1;
  const verifyConnections = async (smtp: MailboxConnectionWithSecret, imap: MailboxConnectionWithSecret): Promise<{ uidValidity: bigint; uidNext: bigint } | VerificationFailure> => {
    for (const [kind, config] of [["smtp", smtp], ["imap", imap]] as const) {
      try { await assertSafeMailHost(config.host, config.port, kind, { allowPrivate: env.SMTP_ALLOW_PRIVATE_HOSTS }); }
      catch { return { error: "Mail host must resolve to an allowed address.", field: `${kind}.host` }; }
    }
    try { await verifySmtp(smtp, { ...smtpOptions, allowPrivateHosts: env.SMTP_ALLOW_PRIVATE_HOSTS }); }
    catch (error) {
      const field = error instanceof SmtpSendError && error.field === "smtp.auth" ? "smtp.auth" : error instanceof SmtpSendError && error.field === "smtp.tls" ? "smtp.tls" : "smtp.host";
      return { error: field === "smtp.auth" ? "SMTP authentication failed. Check the username and password." : field === "smtp.tls" ? "SMTP TLS verification failed. Check the secure setting and server certificate." : "SMTP connection failed. Check the host and port.", field };
    }
    try { return await verifyImap(imap, { ...smtpOptions, allowPrivateHosts: env.SMTP_ALLOW_PRIVATE_HOSTS }); }
    catch (error) {
      const field = error instanceof ImapError && error.field === "imap.auth" ? "imap.auth" : error instanceof ImapError && error.field === "imap.tls" ? "imap.tls" : "imap.host";
      return { error: field === "imap.auth" ? "IMAP authentication failed. Check the username and password." : field === "imap.tls" ? "IMAP TLS verification failed. Check the secure setting and server certificate." : "IMAP verification failed. Check the host, port and INBOX access.", field };
    }
  };
  const setVerifyFailure = async (emailAccountId: string, workspaceId: string, failure: VerificationFailure) => {
    await db!.transaction(async (tx) => {
      await tx.update(schema.emailAccounts).set({ status: "error", lastHealthCheckAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.emailAccounts.id, emailAccountId), eq(schema.emailAccounts.workspaceId, workspaceId)));
      await tx.update(schema.mailboxCredentials).set({ lastVerifyError: failure.error, updatedAt: new Date() }).where(and(eq(schema.mailboxCredentials.emailAccountId, emailAccountId), eq(schema.mailboxCredentials.workspaceId, workspaceId)));
    });
  };
  // A mailbox that just passed verification is polled on the next sweep: the worker's
  // IMAP backoff and its stuck-message counter are cleared along with the credentials.
  const imapPollHealthReset = { imapPollFailures: 0, imapPollRetryAt: null, imapStuckUid: null, imapStuckAttempts: 0 };
  // A mailbox reactivated after an auth failure must resume the enrollments the worker paused
  // for it (stop_reason 'mailbox_auth_expired'), or a fixed password never resumes sending.
  // workspaceId is optional only to keep the Composio reconnect callback's existing (unscoped)
  // behavior byte-for-byte unchanged; the SMTP PATCH/verify routes always pass it.
  const resumeAuthExpiredEnrollments = (tx: Pick<InboxJoyDb, "update">, emailAccountId: string, now: Date, workspaceId?: string) =>
    tx.update(schema.enrollments).set({
      status: sql`COALESCE(${schema.enrollments.statusBeforePause}, 'active'::enrollment_status)`,
      statusBeforePause: null,
      pausedAt: null,
      stopReason: null,
      updatedAt: now,
    }).where(and(
      eq(schema.enrollments.emailAccountId, emailAccountId),
      eq(schema.enrollments.status, "paused"),
      eq(schema.enrollments.stopReason, "mailbox_auth_expired"),
      ...(workspaceId ? [eq(schema.enrollments.workspaceId, workspaceId)] : []),
    ));

  async function connectLink(provider: MailProvider, workspaceId: string, userId: string) {
    const authConfigId = authConfig(provider);
    if (!composio.enabled || !authConfigId) return null;
    const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    if (db) {
      await db.delete(schema.connectStates).where(lt(schema.connectStates.expiresAt, new Date()));
      await db.insert(schema.connectStates).values({ id: randomUUID(), workspaceId, userId, provider, state: stateHash, expiresAt });
    } else {
      pending.set(state, { provider, expiresAt: expiresAt.getTime() });
    }
    const callbackUrl = new URL(`${env.API_BASE_URL}/v1/inboxes/connect/callback`);
    callbackUrl.searchParams.set("provider", provider);
    callbackUrl.searchParams.set("state", state);
    try {
      return await composio.createConnectLink({ authConfigId, userId, callbackUrl: callbackUrl.toString() });
    } catch (error) {
      if (db) await db.delete(schema.connectStates).where(eq(schema.connectStates.state, stateHash));
      else pending.delete(state);
      throw error;
    }
  }

  app.get("/v1/inboxes", async (request) => ({ workspaceId: request.workspaceId, inboxes: await allInboxes(request.workspaceId), features: { smtp: env.SMTP_MAILBOXES_ENABLED } }));

  app.post<{ Body: SmtpBody }>("/v1/inboxes/smtp", smtpRouteOptions, async (request, reply) => {
    if (!env.SMTP_MAILBOXES_ENABLED) return reply.code(404).send({ error: "Route not found." });
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    if (!db || !key) return reply.code(503).send({ error: "SMTP mailbox storage is unavailable." });
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return reply.code(400).send({ error: "Provide a valid email address.", field: "email" });
    const displayName = request.body?.displayName;
    if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim() || displayName.trim().length > 160)) return reply.code(400).send({ error: "Display name must be 1-160 characters.", field: "displayName" });
    const smtp = parseConnection(request.body?.smtp, "smtp");
    if ("error" in smtp) return reply.code(400).send(smtp);
    const imap = parseConnection(request.body?.imap, "imap");
    if ("error" in imap) return reply.code(400).send(imap);
    const verified = await verifyConnections(smtp.config, imap.config);
    if ("error" in verified) return reply.code(400).send(verified);
    const id = randomUUID();
    const now = new Date();
    try {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${request.workspaceId}:${email}`}, 0))`);
        const [duplicate] = await tx.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, request.workspaceId), eq(schema.emailAccounts.normalizedEmail, email), eq(schema.emailAccounts.status, "active")));
        if (duplicate) return undefined;
        const [saved] = await tx.insert(schema.emailAccounts).values({ id, workspaceId: request.workspaceId, userId: request.userId, provider: "smtp", composioConnectedAccountId: `smtp:${id}`, email, normalizedEmail: email, displayName: typeof displayName === "string" ? displayName.trim() : email.slice(0, 160), alias: `smtp-${id}`, status: "active", rampStartedOn: sql`CURRENT_DATE`, lastHealthCheckAt: now }).returning();
        await writeMailboxCredentials(tx, id, { workspaceId: request.workspaceId, smtp: smtp.config, imap: imap.config, verifiedAt: now, lastImapUidvalidity: verified.uidValidity, lastImapUid: verified.uidNext - 1n }, { key, keyVersion });
        return saved;
      });
      if (!row) return reply.code(409).send({ error: "An active inbox with this email address already exists in this workspace." });
      return reply.code(201).send({ inbox: { ...toInbox(row), smtp: { host: smtp.config.host, port: smtp.config.port, secure: smtp.config.secure, username: smtp.config.username }, imap: { host: imap.config.host, port: imap.config.port, secure: imap.config.secure, username: imap.config.username } } });
    } catch { return reply.code(503).send({ error: "Could not save the SMTP mailbox." }); }
  });

  app.patch<{ Params: { id: string }; Body: SmtpBody }>("/v1/inboxes/:id/smtp", smtpRouteOptions, async (request, reply) => {
    if (!env.SMTP_MAILBOXES_ENABLED) return reply.code(404).send({ error: "Route not found." });
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox || inbox.provider !== "smtp") return reply.code(404).send({ error: "SMTP inbox not found." });
    if (!db || !key) return reply.code(503).send({ error: "SMTP mailbox storage is unavailable." });
    try {
      const existing = await readMailboxCredentials(db, inbox.id, { includeSecrets: true, keys });
      if (!existing) return reply.code(404).send({ error: "SMTP inbox credentials not found." });
      const displayName = request.body?.displayName;
      if (displayName !== undefined && (typeof displayName !== "string" || !displayName.trim() || displayName.trim().length > 160)) return reply.code(400).send({ error: "Display name must be 1-160 characters.", field: "displayName" });
      const email = request.body?.email === undefined ? inbox.email ?? "" : typeof request.body.email === "string" ? request.body.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return reply.code(400).send({ error: "Provide a valid email address.", field: "email" });
      const smtp = parseConnection(request.body?.smtp, "smtp", existing.smtp);
      if ("error" in smtp) return reply.code(400).send(smtp);
      const imap = parseConnection(request.body?.imap, "imap", existing.imap);
      if ("error" in imap) return reply.code(400).send(imap);
      const verified = await verifyConnections(smtp.config, imap.config);
      if ("error" in verified) { await setVerifyFailure(inbox.id, request.workspaceId, verified); return reply.code(400).send(verified); }
      const now = new Date();
      const saved = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${request.workspaceId}:${email}`}, 0))`);
        const [duplicate] = await tx.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, request.workspaceId), eq(schema.emailAccounts.normalizedEmail, email), eq(schema.emailAccounts.status, "active"), ne(schema.emailAccounts.id, inbox.id)));
        if (duplicate) return false;
        await writeMailboxCredentials(tx, inbox.id, { workspaceId: request.workspaceId, smtp: smtp.config, imap: imap.config, verifiedAt: now }, { key, keyVersion });
        await tx.update(schema.mailboxCredentials).set(imapPollHealthReset).where(and(eq(schema.mailboxCredentials.emailAccountId, inbox.id), eq(schema.mailboxCredentials.workspaceId, request.workspaceId)));
        await tx.update(schema.emailAccounts).set({ status: "active", email, normalizedEmail: email, displayName: typeof displayName === "string" ? displayName.trim() : undefined, lastHealthCheckAt: now, updatedAt: now }).where(and(eq(schema.emailAccounts.id, inbox.id), eq(schema.emailAccounts.workspaceId, request.workspaceId)));
        await resumeAuthExpiredEnrollments(tx, inbox.id, now, request.workspaceId);
        return true;
      });
      if (!saved) return reply.code(409).send({ error: "An active inbox with this email address already exists in this workspace." });
      return { inbox: await findInbox(inbox.id, request.workspaceId) };
    } catch { return reply.code(503).send({ error: "Could not update the SMTP mailbox." }); }
  });

  app.post<{ Params: { id: string } }>("/v1/inboxes/:id/verify", smtpRouteOptions, async (request, reply) => {
    if (!env.SMTP_MAILBOXES_ENABLED) return reply.code(404).send({ error: "Route not found." });
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox || inbox.provider !== "smtp") return reply.code(404).send({ error: "SMTP inbox not found." });
    if (!db || !key) return reply.code(503).send({ error: "SMTP mailbox storage is unavailable." });
    try {
      const credentials = await readMailboxCredentials(db, inbox.id, { includeSecrets: true, keys });
      if (!credentials) return reply.code(404).send({ error: "SMTP inbox credentials not found." });
      const verified = await verifyConnections(credentials.smtp, credentials.imap);
      if ("error" in verified) { await setVerifyFailure(inbox.id, request.workspaceId, verified); return reply.code(400).send(verified); }
      const now = new Date();
      const saved = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${request.workspaceId}:${inbox.email}`}, 0))`);
        const [duplicate] = await tx.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, request.workspaceId), eq(schema.emailAccounts.normalizedEmail, inbox.email!), eq(schema.emailAccounts.status, "active"), ne(schema.emailAccounts.id, inbox.id)));
        if (duplicate) return false;
        await tx.update(schema.emailAccounts).set({ status: "active", lastHealthCheckAt: now, updatedAt: now }).where(and(eq(schema.emailAccounts.id, inbox.id), eq(schema.emailAccounts.workspaceId, request.workspaceId)));
        await tx.update(schema.mailboxCredentials).set({ verifiedAt: now, lastVerifyError: null, updatedAt: now, ...imapPollHealthReset }).where(and(eq(schema.mailboxCredentials.emailAccountId, inbox.id), eq(schema.mailboxCredentials.workspaceId, request.workspaceId)));
        await resumeAuthExpiredEnrollments(tx, inbox.id, now, request.workspaceId);
        return true;
      });
      if (!saved) return reply.code(409).send({ error: "An active inbox with this email address already exists in this workspace." });
      return { inbox: await findInbox(inbox.id, request.workspaceId) };
    } catch { return reply.code(503).send({ error: "Could not verify the SMTP mailbox." }); }
  });

  app.post<{ Body: { provider?: unknown } }>("/v1/inboxes/connect-link", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const provider = request.body?.provider;
    if (provider !== "gmail" && provider !== "outlook") return reply.code(400).send({ error: "Choose Gmail or Outlook." });
    if (!composio.enabled) return reply.code(503).send({ error: "Mailbox connection is temporarily unavailable." });
    if (!authConfig(provider)) return reply.code(503).send({ error: `${provider === "gmail" ? "Gmail" : "Outlook"} connection is not configured yet.` });
    const result = await connectLink(provider, request.workspaceId, request.userId);
    if (!result) return reply.code(503).send({ error: "Mailbox connection is temporarily unavailable." });
    return { provider, mode: "composio", connectUrl: result.url, expiresAt: result.expiresAt.toISOString() };
  });

  app.get<{ Querystring: { provider?: unknown; state?: unknown; status?: unknown; connectedAccountId?: unknown; connected_account_id?: unknown } }>("/v1/inboxes/connect/callback", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const { provider, state } = request.query;
    const connectedAccountId = request.query.connectedAccountId ?? request.query.connected_account_id;
    if ((provider !== "gmail" && provider !== "outlook") || typeof state !== "string") return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=failed`);
    const stateHash = createHash("sha256").update(state).digest("hex");
    const item = db
      ? (await db.delete(schema.connectStates).where(and(eq(schema.connectStates.state, stateHash), eq(schema.connectStates.provider, provider), eq(schema.connectStates.workspaceId, request.workspaceId), eq(schema.connectStates.userId, request.userId), gt(schema.connectStates.expiresAt, new Date()))).returning())[0]
      : pending.get(state);
    if (!db) pending.delete(state);
    if (!item || request.query.status === "failed" || typeof connectedAccountId !== "string") return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=failed`);
    const account = await composio.getConnectedAccount(connectedAccountId);
    if (!account || account.provider !== provider) return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=failed`);
    const now = new Date();
    const mailboxEmail = mailboxEmailFromProvider(account.email);
    const normalized = mailboxEmail;
    const alias = `${provider}-${account.id.slice(-8).toLowerCase()}`;
    let trigger: { triggerId: string; triggerSlug: string } | undefined;
    let setupFailed = !env.COMPOSIO_WEBHOOK_SECRET || !mailboxEmail;
    if (!setupFailed) {
      try {
        trigger = await composio.ensureInboundMessageTrigger({ connectedAccountId: account.id, provider, userId: request.userId });
      } catch (error) {
        request.log.warn({ err: error, provider, connectedAccountId: account.id }, "Inbound message trigger setup failed");
        setupFailed = true;
      }
    }
    if (db) {
      // A Composio connected-account id already claimed by another workspace must not be
      // updatable from here — the upsert below would otherwise overwrite that tenant's mailbox.
      const [existingAccount] = await db.select({ workspaceId: schema.emailAccounts.workspaceId }).from(schema.emailAccounts).where(eq(schema.emailAccounts.composioConnectedAccountId, account.id));
      if (existingAccount && existingAccount.workspaceId !== request.workspaceId) return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=failed`);
      await db.transaction(async (tx) => {
        const [savedAccount] = await tx.insert(schema.emailAccounts).values({ id: randomUUID(), workspaceId: request.workspaceId, userId: request.userId, provider, composioConnectedAccountId: account.id, email: mailboxEmail, normalizedEmail: normalized, displayName: account.displayName ?? account.email, alias, status: setupFailed ? "error" : "active", timezone: "UTC", dailyLimit: 20, hourlyLimit: 5, rampStartedOn: sql`CURRENT_DATE`, lastHealthCheckAt: now, providerMetadata: trigger ?? {} }).onConflictDoUpdate({ target: schema.emailAccounts.composioConnectedAccountId, set: { email: mailboxEmail, normalizedEmail: normalized, displayName: account.displayName ?? account.email, status: setupFailed ? "error" : "active", lastHealthCheckAt: now, providerMetadata: trigger ?? {}, updatedAt: now } }).returning({ id: schema.emailAccounts.id });
        if (!setupFailed && savedAccount) {
          await resumeAuthExpiredEnrollments(tx, savedAccount.id, now);
        }
      });
    } else {
      const existing = memoryInboxes.find((inbox) => inbox.composioConnectedAccountId === account.id);
      if (existing) Object.assign(existing, { status: setupFailed ? "error" : "active", email: mailboxEmail, displayName: account.displayName ?? account.email ?? "Address pending — reconnect", lastHealthCheckAt: now.toISOString() });
      else memoryInboxes.unshift({ id: randomUUID(), provider, email: mailboxEmail, displayName: account.displayName ?? account.email ?? "Address pending — reconnect", alias, status: setupFailed ? "error" : "active", timezone: "UTC", dailyLimit: 20, hourlyLimit: 5, sentToday: 0, ...warmupState(now.toISOString().slice(0, 10), 20), composioConnectedAccountId: account.id, connectMode: "composio", lastHealthCheckAt: now.toISOString() });
    }
    return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=${setupFailed ? "needs-attention" : provider}`);
  });

  app.get<{ Params: { id: string } }>("/v1/inboxes/:id/status", async (request, reply) => {
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    return { inbox: { id: inbox.id, status: inbox.status, lastHealthCheckAt: inbox.lastHealthCheckAt } };
  });
  app.post<{ Params: { id: string } }>("/v1/inboxes/:id/pause", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    if (db) await db.update(schema.emailAccounts).set({ status: "paused", updatedAt: new Date() }).where(and(eq(schema.emailAccounts.id, inbox.id), eq(schema.emailAccounts.workspaceId, request.workspaceId)));
    else inbox.status = "paused";
    return { inbox: { ...inbox, status: "paused" } };
  });
  app.post<{ Params: { id: string } }>("/v1/inboxes/:id/resume", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    if (db) await db.update(schema.emailAccounts).set({ status: "active", updatedAt: new Date() }).where(and(eq(schema.emailAccounts.id, inbox.id), eq(schema.emailAccounts.workspaceId, request.workspaceId)));
    else inbox.status = "active";
    return { inbox: { ...inbox, status: "active" } };
  });
  app.post<{ Params: { id: string } }>("/v1/inboxes/:id/disconnect", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    if (db) await db.update(schema.emailAccounts).set({ status: "disconnected", updatedAt: new Date() }).where(and(eq(schema.emailAccounts.id, inbox.id), eq(schema.emailAccounts.workspaceId, request.workspaceId)));
    else inbox.status = "disconnected";
    return { inbox: { ...inbox, status: "disconnected" } };
  });
  // Delete from the app. The row stays (status 'removed') because sent messages, campaigns
  // and reply threads reference it. Only 'active' mailboxes send, so it stops sending; it is
  // hidden from every list; reconnecting the same account through Composio revives it.
  // removeMailbox also settles its open leads (moved to other senders, or stopped when
  // already threaded) and keeps campaign sender lists intact; see its comment.
  app.delete<{ Params: { id: string } }>("/v1/inboxes/:id", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    if (db) {
      await removeMailbox(db, { workspaceId: request.workspaceId, mailboxId: inbox.id });
    } else {
      const index = memoryInboxes.findIndex((item) => item.id === inbox.id);
      if (index >= 0) memoryInboxes.splice(index, 1);
    }
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/v1/inboxes/:id/reconnect", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    if (!isComposioProvider(inbox.provider)) return reply.code(503).send({ error: "Mailbox reconnection is temporarily unavailable." });
    const result = await connectLink(inbox.provider, request.workspaceId, request.userId);
    if (!result) return reply.code(503).send({ error: "Mailbox reconnection is temporarily unavailable." });
    return { inbox, connectUrl: result.url, expiresAt: result.expiresAt.toISOString() };
  });
  app.patch<{ Params: { id: string }; Body: { dailyLimit?: unknown; hourlyLimit?: unknown; timezone?: unknown; skipWarmup?: unknown } }>("/v1/inboxes/:id/settings", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    const dailyLimit = typeof request.body?.dailyLimit === "number" && Number.isInteger(request.body.dailyLimit) && request.body.dailyLimit > 0 && request.body.dailyLimit <= 200 ? request.body.dailyLimit : inbox.dailyLimit;
    const hourlyLimit = typeof request.body?.hourlyLimit === "number" && Number.isInteger(request.body.hourlyLimit) && request.body.hourlyLimit > 0 && request.body.hourlyLimit <= 50 ? request.body.hourlyLimit : inbox.hourlyLimit;
    const timezone = typeof request.body?.timezone === "string" && request.body.timezone.trim() ? request.body.timezone.trim() : inbox.timezone;
    const rampStartedOn = typeof request.body?.skipWarmup === "boolean" ? (request.body.skipWarmup ? null : new Date().toISOString().slice(0, 10)) : inbox.rampStartedOn;
    if (db) {
      const [updated] = await db.update(schema.emailAccounts).set({ dailyLimit, hourlyLimit, timezone, rampStartedOn, updatedAt: new Date() }).where(and(eq(schema.emailAccounts.id, inbox.id), eq(schema.emailAccounts.workspaceId, request.workspaceId))).returning();
      return { inbox: updated ? { ...toInbox(updated), sentToday: inbox.sentToday } : { ...inbox, dailyLimit, hourlyLimit, timezone, ...warmupState(rampStartedOn, dailyLimit) } };
    }
    Object.assign(inbox, { dailyLimit, hourlyLimit, timezone, ...warmupState(rampStartedOn, dailyLimit) });
    return { inbox };
  });

  const validTimezone = (value: string) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
  };
  const normalizeSchedules = (value: unknown): Array<{ dayOfWeek: number; startTime: string; endTime: string; timezone: string; isActive: boolean }> | null => {
    if (!Array.isArray(value)) return null;
    const seenDays = new Set<number>();
    const schedules: Array<{ dayOfWeek: number; startTime: string; endTime: string; timezone: string; isActive: boolean }> = [];
    for (const raw of value) {
      const item = raw as ScheduleInput;
      const dayOfWeek = item.dayOfWeek;
      const startTime = item.startTime;
      const endTime = item.endTime;
      const timezone = item.timezone;
      if (typeof dayOfWeek !== "number" || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 || seenDays.has(dayOfWeek)
        || typeof startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
        || typeof endTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)
        || startTime >= endTime || typeof timezone !== "string" || !timezone.trim() || !validTimezone(timezone.trim())) return null;
      seenDays.add(dayOfWeek);
      schedules.push({ dayOfWeek, startTime, endTime, timezone: timezone.trim(), isActive: item.isActive !== false });
    }
    return schedules;
  };

  app.get<{ Params: { id: string } }>("/v1/inboxes/:id/schedules", async (request, reply) => {
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    if (!db) return { schedules: [] };
    const schedules = await db.select({ dayOfWeek: schema.mailboxSchedules.dayOfWeek, startTime: schema.mailboxSchedules.startTime, endTime: schema.mailboxSchedules.endTime, timezone: schema.mailboxSchedules.timezone, isActive: schema.mailboxSchedules.isActive })
      .from(schema.mailboxSchedules)
      .where(and(eq(schema.mailboxSchedules.workspaceId, request.workspaceId), eq(schema.mailboxSchedules.emailAccountId, inbox.id)))
      .orderBy(schema.mailboxSchedules.dayOfWeek);
    return {
      schedules: schedules.map((schedule) => ({
        ...schedule,
        startTime: schedule.startTime.slice(0, 5),
        endTime: schedule.endTime.slice(0, 5),
      })),
    };
  });

  app.put<{ Params: { id: string }; Body: { schedules?: unknown } }>("/v1/inboxes/:id/schedules", async (request, reply) => {
    if (!canManageInboxes(request.workspaceRole)) return forbidden(reply);
    const inbox = await findInbox(request.params.id, request.workspaceId);
    if (!inbox) return reply.code(404).send({ error: "Inbox not found." });
    const schedules = normalizeSchedules(request.body?.schedules);
    if (!schedules) return reply.code(400).send({ error: "Schedules must use unique days 0-6, HH:MM start/end times, and valid timezones." });
    if (!db) return { schedules };
    await db.transaction(async (tx) => {
      await tx.delete(schema.mailboxSchedules).where(and(eq(schema.mailboxSchedules.workspaceId, request.workspaceId), eq(schema.mailboxSchedules.emailAccountId, inbox.id)));
      if (schedules.length) await tx.insert(schema.mailboxSchedules).values(schedules.map((schedule) => ({ id: randomUUID(), workspaceId: request.workspaceId, emailAccountId: inbox.id, ...schedule })));
    });
    return { schedules };
  });

  return async (accountId: string) => {
    // A deleted mailbox stays deleted: its old connection expiring must not bring it back.
    if (db) await db.update(schema.emailAccounts).set({ status: "expired", lastHealthCheckAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.emailAccounts.composioConnectedAccountId, accountId), ne(schema.emailAccounts.status, "removed")));
    else { const inbox = memoryInboxes.find((item) => item.composioConnectedAccountId === accountId); if (inbox) Object.assign(inbox, { status: "expired", lastHealthCheckAt: new Date().toISOString() }); }
  };
}
