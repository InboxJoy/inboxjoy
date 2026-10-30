import type { ComposioClient } from "@inboxjoy/composio";
import { MailboxCredentialsError, readMailboxCredentials, type MailboxCredentialsWithSecrets } from "@inboxjoy/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailClientResolver, createSmtpMailClient, SmtpSendError, type MailClientResolver, type MailClientResolverDependencies, type SmtpMailClient, type SmtpSendTransport } from "../src/index.js";

vi.mock("@inboxjoy/core", async (importOriginal) => ({ ...await importOriginal<typeof import("@inboxjoy/core")>(), readMailboxCredentials: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));

const secret = "never-echo-this-password";
const keys = new Map([[42, Buffer.alloc(32, 7)]]);
const smtpMailbox = { provider: "smtp" as const, emailAccountId: "mailbox-1" };
const resolvers: MailClientResolver[] = [];

function credentials(emailAccountId = smtpMailbox.emailAccountId): MailboxCredentialsWithSecrets {
  return {
    emailAccountId, workspaceId: "workspace-1", keyVersion: 42,
    smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com", password: secret },
    imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com", password: secret },
    verifiedAt: null, lastVerifyError: null, lastImapUid: null, lastImapUidvalidity: null, lastPolledAt: null,
  };
}

function stubClient(): SmtpMailClient {
  // The fake has no notion of "busy", so retire() behaves like an idle client always does:
  // close immediately. Tests that care about work-in-flight semantics use the real
  // createSmtpMailClient instead (see the TTL/shutdown-while-busy tests below).
  const client: SmtpMailClient = {
    enabled: true, sendEmail: vi.fn().mockResolvedValue({}), findSentMessage: vi.fn().mockResolvedValue("unknown"),
    close: vi.fn(), retire: vi.fn().mockImplementation(async () => { client.close(); }),
  };
  return client;
}

// readMailboxCredentials is overloaded: a cheap metadata-only call (2 args) the resolver now
// makes on every cache hit to detect a rotated encryption key, and the full secret-decrypting
// call (3 args, { includeSecrets: true, keys }) made only on a cache miss/rebuild. Tests assert
// against this count, not the raw mock call count, so the new cheap check doesn't make every
// existing "reads credentials once" assertion flaky.
function secretReadCount(): number {
  return vi.mocked(readMailboxCredentials).mock.calls.filter((call) => call.length > 2).length;
}

function setup(overrides: Partial<MailClientResolverDependencies> = {}) {
  const db = {} as MailClientResolverDependencies["db"];
  const composio = { enabled: true, sendEmail: vi.fn(), findSentMessage: vi.fn() } as unknown as ComposioClient;
  const clients: SmtpMailClient[] = [];
  const smtpFactory = vi.fn().mockImplementation(() => {
    const client = stubClient();
    clients.push(client);
    return client;
  });
  const resolver = createMailClientResolver({ db, keys, composio, smtpFactory, ...overrides });
  resolvers.push(resolver);
  return { db, composio, smtpFactory, clients, resolver };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
  vi.mocked(readMailboxCredentials).mockReset().mockResolvedValue(credentials());
});

afterEach(() => {
  for (const resolver of resolvers.splice(0)) resolver.close();
  vi.useRealTimers();
});

describe("shared mail client resolver without database access", () => {
  it("sanitizes transient credential-read failures as connection failures and allows retry", async () => {
    vi.mocked(readMailboxCredentials).mockRejectedValueOnce(new Error(`database outage with ${secret}`));
    const { resolver, smtpFactory } = setup();
    const error = await resolver.getMailClientFor(smtpMailbox).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "SmtpSendError", stage: "connect", code: "ECONNECTION", message: "SMTP mailbox credentials could not be read." });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
    expect(smtpFactory).not.toHaveBeenCalled();
    await resolver.getMailClientFor(smtpMailbox);
    expect(smtpFactory).toHaveBeenCalledOnce();
  });

  it("TTL expiry never aborts a send in flight, and only closes the transport after it settles", async () => {
    const connection = { close: vi.fn() };
    let finishSend!: (value: unknown) => void;
    const transport: SmtpSendTransport = {
      sendMail: vi.fn(async ({ raw }) => {
        for await (const chunk of raw) expect(chunk).toBeDefined();
        return await new Promise((resolve) => { finishSend = resolve; });
      }),
      close: vi.fn(), transporter: { _connections: [connection] },
    };
    // The send succeeds in this test, so it proceeds to the IMAP Sent-copy append; stub IMAP out
    // so that step doesn't attempt a real network connection.
    const sentImap = {
      connect: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([{ path: "Sent", specialUse: "\\Sent", flags: new Set(["\\Sent"]) }]),
      mailboxOpen: vi.fn().mockResolvedValue({ path: "Sent" }),
      append: vi.fn().mockResolvedValue({ uid: 1 }), search: vi.fn().mockResolvedValue([]),
      logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn(),
    };
    const { resolver } = setup({ ttlMs: 1_000, smtpFactory: (options) => createSmtpMailClient({ ...options, transportFactory: () => transport, imapFactory: () => sentImap }) });
    const client = await resolver.getMailClientFor(smtpMailbox);
    const sent = client.sendEmail({ connectedAccountId: "mailbox-1", provider: "smtp", from: "sender@example.com", to: "lead@example.com", subject: "Reply", body: "Hello", messageId: "<manual@example.com>" });
    // The TTL fires while the send is still running: the client is evicted from the cache (a new
    // caller gets a fresh client) but its transport must not be torn down mid-DATA.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.close).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    const next = await resolver.getMailClientFor(smtpMailbox);
    expect(next).not.toBe(client);
    finishSend({});
    await expect(sent).resolves.toMatchObject({ providerMessageId: "<manual@example.com>" });
    expect(transport.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("TTL expiry on an idle client closes it right away", async () => {
    const { resolver, clients } = setup({ ttlMs: 1_000 });
    await resolver.getMailClientFor(smtpMailbox);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
  });

  it("an in-flight IMAP reply lookup survives a TTL retire, and the session closes once it settles", async () => {
    let finishConnect!: () => void;
    const imapClient = {
      connect: vi.fn(() => new Promise<void>((resolve) => { finishConnect = resolve; })),
      list: vi.fn().mockResolvedValue([{ path: "INBOX", flags: new Set() }]),
      mailboxOpen: vi.fn().mockResolvedValue({ path: "INBOX" }),
      append: vi.fn(), search: vi.fn().mockResolvedValue([]), fetchOne: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn(),
    };
    const { resolver } = setup({ ttlMs: 1_000, smtpFactory: (options) => createSmtpMailClient({ ...options, imapFactory: () => imapClient }) });
    const client = await resolver.getMailClientFor(smtpMailbox);
    const lookup = client.fetchReplies!({ connectedAccountId: "mailbox-1", provider: "smtp", senderEmail: "lead@example.com" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(imapClient.close).not.toHaveBeenCalled();
    expect(imapClient.logout).not.toHaveBeenCalled();
    finishConnect();
    await expect(lookup).resolves.toEqual([]);
    expect(imapClient.logout).toHaveBeenCalledOnce();
  });

  it("a forced resolver close at shutdown still aborts an in-flight send instead of waiting for it", async () => {
    const connection = { close: vi.fn() };
    const transport: SmtpSendTransport = {
      sendMail: vi.fn(async ({ raw }) => { for await (const chunk of raw) expect(chunk).toBeDefined(); return await new Promise<never>(() => {}); }),
      close: vi.fn(), transporter: { _connections: [connection] },
    };
    const { resolver } = setup({ smtpFactory: (options) => createSmtpMailClient({ ...options, transportFactory: () => transport }) });
    const client = await resolver.getMailClientFor(smtpMailbox);
    const sendPromise = client.sendEmail({ connectedAccountId: "mailbox-1", provider: "smtp", from: "sender@example.com", to: "lead@example.com", subject: "Reply", body: "Hello", messageId: "<manual@example.com>" });
    const rejected = expect(sendPromise).rejects.toMatchObject({ stage: "data", code: "ECONNECTION" });
    await vi.waitFor(() => expect(transport.sendMail.mock.calls[0]?.[0].raw.readableEnded).toBe(true));
    resolver.close();
    await rejected;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("returns the exact shared Composio object for Gmail and Outlook without reading SMTP credentials", async () => {
    const { resolver, composio, smtpFactory } = setup({ keys: undefined });
    await expect(resolver.getMailClientFor({ provider: "gmail", emailAccountId: "gmail-1" })).resolves.toBe(composio);
    await expect(resolver.getMailClientFor({ provider: "outlook", emailAccountId: "outlook-1" })).resolves.toBe(composio);
    expect(readMailboxCredentials).not.toHaveBeenCalled();
    expect(smtpFactory).not.toHaveBeenCalled();
  });

  it("reads decrypted SMTP/IMAP credentials once and caches the client for five minutes", async () => {
    const { resolver, db, smtpFactory, clients } = setup();
    const first = await resolver.getMailClientFor(smtpMailbox);
    expect(first).toBe(clients[0]);
    expect(readMailboxCredentials).toHaveBeenCalledWith(db, smtpMailbox.emailAccountId, { includeSecrets: true, keys });
    expect(smtpFactory).toHaveBeenCalledWith({ smtp: { ...credentials().smtp, allowPrivateHosts: undefined }, imap: { ...credentials().imap, allowPrivateHosts: undefined }, now: expect.any(Function) });
    vi.advanceTimersByTime(299_999);
    await expect(resolver.getMailClientFor(smtpMailbox)).resolves.toBe(first);
    // The cache hit still triggers a cheap key-version check (an extra, non-secret read), but
    // must not decrypt credentials again.
    expect(secretReadCount()).toBe(1);
    expect(clients[0]!.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    const next = await resolver.getMailClientFor(smtpMailbox);
    expect(next).not.toBe(first);
    expect(secretReadCount()).toBe(2);
  });

  it("reuses the cached client when the credential key version is unchanged, without a second decrypt", async () => {
    const { resolver, smtpFactory } = setup();
    const first = await resolver.getMailClientFor(smtpMailbox);
    expect(secretReadCount()).toBe(1);
    for (let i = 0; i < 3; i++) {
      await expect(resolver.getMailClientFor(smtpMailbox)).resolves.toBe(first);
    }
    expect(secretReadCount()).toBe(1);
    expect(smtpFactory).toHaveBeenCalledOnce();
  });

  it("rebuilds and retires the old client when the mailbox's encryption key version changes mid-TTL", async () => {
    const rotatedKeys = new Map([[42, Buffer.alloc(32, 7)], [43, Buffer.alloc(32, 9)]]);
    vi.mocked(readMailboxCredentials).mockResolvedValue(credentials());
    const { resolver, clients } = setup({ keys: rotatedKeys });
    const first = await resolver.getMailClientFor(smtpMailbox);
    expect(clients[0]!.retire).not.toHaveBeenCalled();
    // The master key rotates: the row's key_version now differs from what the cached client
    // was built with, even though the TTL has not expired.
    vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), keyVersion: 43 });
    const second = await resolver.getMailClientFor(smtpMailbox);
    expect(second).not.toBe(first);
    expect(clients[0]!.retire).toHaveBeenCalledOnce();
    expect(clients[0]!.close).toHaveBeenCalledOnce();
    await expect(resolver.getMailClientFor(smtpMailbox)).resolves.toBe(second);
  });

  it("rebuilds the client when the mailbox is saved again with the same key version", async () => {
    vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), verifiedAt: new Date("2026-10-08T12:00:00.000Z") });
    const { resolver, clients, smtpFactory } = setup();
    const first = await resolver.getMailClientFor(smtpMailbox);
    // A password change keeps key_version but stamps a new verified_at.
    vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), verifiedAt: new Date("2026-10-08T12:03:00.000Z") });
    const second = await resolver.getMailClientFor(smtpMailbox);
    expect(second).not.toBe(first);
    expect(clients[0]!.retire).toHaveBeenCalledOnce();
    expect(smtpFactory).toHaveBeenCalledTimes(2);
    await expect(resolver.getMailClientFor(smtpMailbox)).resolves.toBe(second);
  });

  it("uses the injected clock for lazy expiry and configurable TTL", async () => {
    let current = new Date("2026-10-08T12:00:00.000Z");
    const { resolver, clients } = setup({ now: () => current, ttlMs: 10_000 });
    const first = await resolver.getMailClientFor(smtpMailbox);
    current = new Date(current.getTime() + 10_000);
    const second = await resolver.getMailClientFor(smtpMailbox);
    expect(second).not.toBe(first);
    expect(clients[0]!.close).toHaveBeenCalledOnce();
  });

  it("maintains separate caches for different mailbox IDs", async () => {
    vi.mocked(readMailboxCredentials).mockImplementation(async (_db, emailAccountId) => credentials(emailAccountId));
    const { resolver, clients } = setup();
    const first = await resolver.getMailClientFor(smtpMailbox);
    const second = await resolver.getMailClientFor({ provider: "smtp", emailAccountId: "mailbox-2" });
    expect(first).not.toBe(second);
    expect(clients).toHaveLength(2);
    await expect(resolver.getMailClientFor(smtpMailbox)).resolves.toBe(first);
    await expect(resolver.getMailClientFor({ provider: "smtp", emailAccountId: "mailbox-2" })).resolves.toBe(second);
  });

  it("coalesces concurrent credential reads and transport creation", async () => {
    let finishRead!: (value: MailboxCredentialsWithSecrets) => void;
    vi.mocked(readMailboxCredentials).mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const { resolver, smtpFactory } = setup();
    const first = resolver.getMailClientFor(smtpMailbox);
    const second = resolver.getMailClientFor(smtpMailbox);
    expect(readMailboxCredentials).toHaveBeenCalledOnce();
    finishRead(credentials());
    const [firstClient, secondClient] = await Promise.all([first, second]);
    expect(firstClient).toBe(secondClient);
    expect(smtpFactory).toHaveBeenCalledOnce();
  });

  it.each([undefined, new Map<number, Buffer>()])("throws a static auth-stage error when keys are unavailable", async (missingKeys) => {
    const { resolver, smtpFactory } = setup({ keys: missingKeys });
    const error = await resolver.getMailClientFor(smtpMailbox).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SmtpSendError);
    expect(error).toMatchObject({ stage: "auth", code: "EAUTH", message: "SMTP mailbox credentials are unavailable." });
    expect(readMailboxCredentials).not.toHaveBeenCalled();
    expect(smtpFactory).not.toHaveBeenCalled();
  });

  it.each(["missing", "decryption", "unknown-version", "smtp-password", "imap-password"])("safely rejects %s credentials", async (failure) => {
    if (failure === "missing") vi.mocked(readMailboxCredentials).mockResolvedValue(undefined);
    if (failure === "decryption") vi.mocked(readMailboxCredentials).mockRejectedValue(new MailboxCredentialsError());
    if (failure === "unknown-version") vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), keyVersion: 99 });
    if (failure === "smtp-password") vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), smtp: { ...credentials().smtp, password: "" } });
    if (failure === "imap-password") vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), imap: { ...credentials().imap, password: "" } });
    const { resolver, smtpFactory } = setup();
    const error = await resolver.getMailClientFor(smtpMailbox).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "SmtpSendError", stage: "auth", code: "EAUTH" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
    expect(smtpFactory).not.toHaveBeenCalled();
  });

  it("uses the supplied current and previous version map unchanged", async () => {
    const rotatedKeys = new Map([[42, Buffer.alloc(32, 7)], [41, Buffer.alloc(32, 6)]]);
    vi.mocked(readMailboxCredentials).mockResolvedValue({ ...credentials(), keyVersion: 41 });
    const { resolver, db } = setup({ keys: rotatedKeys });
    await resolver.getMailClientFor(smtpMailbox);
    expect(readMailboxCredentials).toHaveBeenCalledWith(db, smtpMailbox.emailAccountId, { includeSecrets: true, keys: rotatedKeys });
    expect(rotatedKeys.size).toBe(2);
  });

  it("does not cache failures, allowing credentials to be repaired", async () => {
    vi.mocked(readMailboxCredentials).mockRejectedValueOnce(new MailboxCredentialsError());
    const { resolver, clients } = setup();
    await expect(resolver.getMailClientFor(smtpMailbox)).rejects.toMatchObject({ stage: "auth" });
    const repaired = await resolver.getMailClientFor(smtpMailbox);
    expect(repaired).toBe(clients[0]);
    expect(readMailboxCredentials).toHaveBeenCalledTimes(2);
  });

  it("sanitizes factory failures and allows a later retry", async () => {
    const { resolver, smtpFactory, clients } = setup();
    smtpFactory.mockImplementationOnce(() => { throw new Error(secret); });
    const error = await resolver.getMailClientFor(smtpMailbox).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ stage: "connect", message: "SMTP mail client could not be created." });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    const retried = await resolver.getMailClientFor(smtpMailbox);
    expect(retried).toBe(clients[0]);
  });

  it("closes cached clients and cancels expiry timers exactly once", async () => {
    const { resolver, clients } = setup();
    await resolver.getMailClientFor(smtpMailbox);
    await resolver.getMailClientFor({ provider: "smtp", emailAccountId: "mailbox-2" });
    resolver.close();
    resolver.close();
    vi.advanceTimersByTime(600_000);
    for (const client of clients) expect(client.close).toHaveBeenCalledOnce();
    await expect(resolver.getMailClientFor(smtpMailbox)).rejects.toMatchObject({ stage: "connect", message: "Mail client resolver is closed." });
  });

  it("does not construct a transport when shutdown occurs during a credential read", async () => {
    let finishRead!: (value: MailboxCredentialsWithSecrets) => void;
    vi.mocked(readMailboxCredentials).mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const { resolver, smtpFactory } = setup();
    const loading = resolver.getMailClientFor(smtpMailbox);
    resolver.close();
    finishRead(credentials());
    await expect(loading).rejects.toMatchObject({ stage: "connect", message: "Mail client resolver is closed." });
    expect(smtpFactory).not.toHaveBeenCalled();
  });

  it("swallows transport-close errors during timer expiry and shutdown", async () => {
    const { resolver, clients } = setup();
    await resolver.getMailClientFor(smtpMailbox);
    vi.mocked(clients[0]!.close).mockImplementation(() => { throw new Error(secret); });
    expect(() => vi.advanceTimersByTime(300_000)).not.toThrow();
    await resolver.getMailClientFor(smtpMailbox);
    vi.mocked(clients[1]!.close).mockImplementation(() => { throw new Error(secret); });
    expect(() => resolver.close()).not.toThrow();
  });
});
