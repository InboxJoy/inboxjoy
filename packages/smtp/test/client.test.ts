import { lookup } from "node:dns/promises";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmtpMailClient, SmtpSendError, type SmtpMailClientOptions, type SmtpSentImapClient } from "../src/index.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
beforeEach(() => vi.mocked(lookup).mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never));

async function readRaw(raw: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of raw) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const secret = "never-echo-this-password";
const smtp = { host: "mail.example.com", port: 587, secure: false, username: "sender@example.com", password: secret };
const imap = { ...smtp, port: 993, secure: true };
const input = {
  connectedAccountId: "mailbox-1", userId: "user-1", provider: "smtp" as const,
  from: smtp.username, to: "lead@example.net", subject: "Hello", body: "Hello there", html: "<p>Hello there</p>",
  unsubscribeUrl: "https://app.example.com/unsubscribe?token=fixed", messageId: "<campaign-123@inboxjoy.example>",
};
const findInput = { connectedAccountId: "mailbox-1", provider: "smtp" as const, recipientEmail: input.to, subject: input.subject, messageId: input.messageId };
const fixedNow = new Date("2026-10-08T12:00:00.000Z");

function stubImap(): SmtpSentImapClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([{ path: "Gesendet", specialUse: "\\Sent", flags: new Set(["\\Sent"]) }]),
    mailboxOpen: vi.fn().mockResolvedValue({ path: "Gesendet" }),
    append: vi.fn().mockResolvedValue({ uid: 123 }), search: vi.fn().mockResolvedValue([]),
    logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn(),
  };
}

function setup(overrides: Partial<SmtpMailClientOptions> = {}) {
  const rawMessages: string[] = [];
  const connection = { close: vi.fn() };
  const transport = { sendMail: vi.fn(async (sent: { raw: Readable; envelope: { from: string; to: string } }) => {
    rawMessages.push(await readRaw(sent.raw));
    return { messageId: "rewritten-by-provider" };
  }), close: vi.fn(), transporter: { _connections: [connection] } };
  const imapClient = stubImap();
  const transportFactory = vi.fn().mockReturnValue(transport);
  const imapFactory = vi.fn().mockReturnValue(imapClient);
  const logger = { warn: vi.fn() };
  const client = createSmtpMailClient({ smtp, imap, transportFactory, imapFactory, logger, now: () => fixedNow, ...overrides });
  return { client, transport, connection, rawMessages, imapClient, transportFactory, imapFactory, logger };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("SMTP mail client", () => {
  it.each(["ETIMEDOUT", "ECONNECTION", "EMESSAGE", "unrecognized"])("tracks DATA consumption even when nodemailer reports CONN %s", async (code) => {
    const { client, transport, connection, imapFactory } = setup();
    transport.sendMail.mockImplementation(async ({ raw }) => {
      await readRaw(raw);
      throw Object.assign(new Error(secret), { command: "CONN", code });
    });
    await expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "data", command: "CONN" });
    expect(connection.close).toHaveBeenCalledOnce();
    expect(imapFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("treats a DATA command timeout as an unknown result even before MIME consumption", async () => {
    const { client, transport } = setup();
    transport.sendMail.mockRejectedValue(Object.assign(new Error(secret), { command: "DATA", code: "ETIMEDOUT" }));
    await expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "data", code: "ETIMEDOUT" });
    client.close();
  });

  it.each([false, true])("enforces an absolute deadline and force-closes a busy pool (dataStarted=%s)", async (consume) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, transport, connection, imapFactory } = setup({ sendDeadlineMs: 1_000 });
    transport.sendMail.mockImplementation(async ({ raw }) => {
      if (consume) await readRaw(raw);
      return await new Promise<never>(() => {});
    });
    const rejected = expect(client.sendEmail(input)).rejects.toMatchObject({ stage: consume ? "data" : "connect", code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(imapFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("does not start a connection after a deadline during DNS resolution", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finishLookup!: (addresses: { address: string; family: number }[]) => void;
    vi.mocked(lookup).mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve as typeof finishLookup; }) as never);
    const { client, transportFactory } = setup({ sendDeadlineMs: 1_000 });
    const rejected = expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "connect", code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    finishLookup([{ address: "8.8.8.8", family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(transportFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("keeps acceptance when the remaining overall deadline aborts a stalled Sent APPEND", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, imapClient, logger } = setup({ sendDeadlineMs: 1_000 });
    vi.mocked(imapClient.append).mockImplementation(() => new Promise(() => {}));
    const accepted = expect(client.sendEmail(input)).resolves.toMatchObject({ providerMessageId: input.messageId });
    await vi.advanceTimersByTimeAsync(1_000);
    await accepted;
    expect(imapClient.close).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    client.close();
  });

  it("shutdown force-closes an active DATA submission instead of leaving it in the pool", async () => {
    const { client, transport, connection } = setup();
    transport.sendMail.mockImplementation(async ({ raw }) => { await readRaw(raw); return await new Promise<never>(() => {}); });
    const rejected = expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "data", code: "ECONNECTION" });
    await vi.waitFor(() => expect(transport.sendMail.mock.calls[0]?.[0].raw.readableEnded).toBe(true));
    client.close();
    await rejected;
    expect(connection.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("rejects a deferred pool connection after disposal instead of opening a late socket", async () => {
    const { client, transport, transportFactory } = setup();
    transport.sendMail.mockImplementation(() => new Promise<never>(() => {}));
    const rejected = expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "connect", code: "ECONNECTION" });
    await vi.waitFor(() => expect(transportFactory).toHaveBeenCalledOnce());
    const options = transportFactory.mock.calls[0]![0];
    const callback = vi.fn();
    options.getSocket(options, callback);
    expect(callback).toHaveBeenLastCalledWith(null, false);
    client.close();
    await rejected;
    options.getSocket(options, callback);
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ code: "ECONNECTION" }), false);
  });

  it("revalidates SMTP, Sent and reply connections rather than re-resolving a checked hostname", async () => {
    const { client, transportFactory, imapFactory } = setup();
    await client.sendEmail(input);
    expect(vi.mocked(lookup)).toHaveBeenCalledTimes(2);
    vi.mocked(lookup).mockResolvedValue([{ address: "10.0.0.1", family: 4 }] as never);
    await expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "connect" });
    await expect(client.findSentMessage(findInput)).resolves.toBe("unknown");
    await expect(client.fetchReplies!({ connectedAccountId: "mailbox-1", provider: "smtp", senderEmail: input.to })).rejects.toMatchObject({ name: "ImapError" });
    expect(transportFactory).toHaveBeenCalledOnce();
    expect(imapFactory).toHaveBeenCalledOnce();
    client.close();
  });

  it("sends streamed campaign MIME over a pinned single-submission pool without internal requeues", async () => {
    const { client, transport, rawMessages, imapClient, transportFactory, imapFactory } = setup();
    await expect(client.sendEmail(input)).resolves.toEqual({ providerMessageId: input.messageId, providerThreadId: input.messageId });
    expect(transportFactory).toHaveBeenCalledWith(expect.objectContaining({ host: "8.8.8.8", pool: true, maxConnections: 1, maxMessages: 1, maxRequeues: 0, requireTLS: true, tls: { rejectUnauthorized: true, servername: smtp.host }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000, logger: false, debug: false }));
    const sent = transport.sendMail.mock.calls[0]![0];
    expect(sent.envelope).toEqual({ from: smtp.username, to: input.to });
    expect(rawMessages[0]).toContain(`Message-ID: ${input.messageId}\r\n`);
    expect(rawMessages[0]).toContain(`List-Unsubscribe: <${input.unsubscribeUrl}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n`);
    expect(imapClient.mailboxOpen).toHaveBeenCalledWith("Gesendet");
    expect(imapClient.append).toHaveBeenCalledWith("Gesendet", rawMessages[0], ["\\Seen"]);
    expect(imapFactory).toHaveBeenCalledWith(expect.objectContaining({ host: "8.8.8.8", servername: imap.host, secure: true, tls: { rejectUnauthorized: true }, logger: false }));
    expect(imapClient.logout).toHaveBeenCalledOnce();
    await client.sendEmail({ ...input, messageId: "<campaign-124@inboxjoy.example>" });
    expect(transportFactory).toHaveBeenCalledTimes(2);
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(client.fetchReplies).toBeTypeOf("function");
    expect(client.findReply).toBeTypeOf("function");
    client.close();
  });

  it("uses reply MIME without unsubscribe, falls back to the authenticated sender and roots References", async () => {
    const { client, transport, rawMessages } = setup();
    await expect(client.sendEmail({ ...input, from: undefined, unsubscribeUrl: undefined, inReplyTo: "<parent@example.net>", references: "<root@example.net> <parent@example.net>" })).resolves.toEqual({ providerMessageId: input.messageId, providerThreadId: "<root@example.net>" });
    const sent = transport.sendMail.mock.calls[0]![0];
    expect(sent.envelope.from).toBe(smtp.username);
    expect(rawMessages[0]).not.toContain("List-Unsubscribe");
    expect(rawMessages[0]).toContain("In-Reply-To: <parent@example.net>\r\nReferences: <root@example.net> <parent@example.net>\r\n");
    client.close();
  });

  it("roots campaign threading in the unchanged single References header", async () => {
    const { client } = setup();
    await expect(client.sendEmail({ ...input, inReplyTo: "<root@example.net>" })).resolves.toMatchObject({ providerThreadId: "<root@example.net>" });
    client.close();
  });

  it("uses STARTTLS for nonsecure IMAP and implicit TLS for secure SMTP", async () => {
    const transport = { sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() };
    const transportFactory = vi.fn().mockReturnValue(transport);
    const imapFactory = vi.fn().mockReturnValue(stubImap());
    const client = createSmtpMailClient({ smtp: { ...smtp, secure: true, port: 465, connectionTimeout: 12_000, socketTimeout: 30_000 }, imap: { ...imap, secure: false, port: 143 }, transportFactory, imapFactory });
    await client.sendEmail(input);
    expect(transportFactory.mock.lastCall?.[0]).toMatchObject({ requireTLS: undefined, tls: { rejectUnauthorized: true }, connectionTimeout: 12_000, socketTimeout: 30_000 });
    expect(imapFactory.mock.lastCall?.[0]).toMatchObject({ doSTARTTLS: true, tls: { rejectUnauthorized: true } });
    client.close();
  });

  it("allows explicit additive TLS configuration without weakening the defaults", async () => {
    const transportFactory = vi.fn().mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}), close: vi.fn() });
    const imapFactory = vi.fn().mockReturnValue(stubImap());
    const client = createSmtpMailClient({ smtp: { ...smtp, requireTLS: false, rejectUnauthorized: false }, imap: { ...imap, secure: false, requireTLS: false, rejectUnauthorized: false }, transportFactory, imapFactory });
    await client.sendEmail(input);
    expect(transportFactory.mock.lastCall?.[0]).toMatchObject({ requireTLS: false, tls: { rejectUnauthorized: false } });
    expect(imapFactory.mock.lastCall?.[0]).toMatchObject({ doSTARTTLS: false, tls: { rejectUnauthorized: false } });
    client.close();
  });

  it.each(["connect", "list-and-open", "append", "append-false", "factory"])("never fails an accepted send when IMAP %s fails", async (failure) => {
    const { client, imapClient, imapFactory, logger } = setup();
    if (failure === "connect") vi.mocked(imapClient.connect).mockRejectedValue(new Error(secret));
    if (failure === "list-and-open") {
      vi.mocked(imapClient.list).mockRejectedValue(new Error(secret));
      vi.mocked(imapClient.mailboxOpen).mockRejectedValue(new Error(secret));
    }
    if (failure === "append") vi.mocked(imapClient.append).mockRejectedValue(new Error(secret));
    if (failure === "append-false") vi.mocked(imapClient.append).mockResolvedValue(false);
    if (failure === "factory") imapFactory.mockImplementation(() => { throw new Error(secret); });
    await expect(client.sendEmail(input)).resolves.toMatchObject({ providerMessageId: input.messageId });
    expect(logger.warn).toHaveBeenCalledWith("SMTP send succeeded, but the IMAP Sent copy could not be saved.");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    client.close();
  });

  it("swallows log and logout failures after a successful append", async () => {
    const { client, imapClient, logger } = setup();
    vi.mocked(imapClient.logout).mockRejectedValue(new Error(secret));
    await expect(client.sendEmail(input)).resolves.toMatchObject({ providerMessageId: input.messageId });
    expect(imapClient.close).toHaveBeenCalledOnce();
    vi.mocked(imapClient.append).mockRejectedValue(new Error(secret));
    logger.warn.mockImplementation(() => { throw new Error(secret); });
    await expect(client.sendEmail(input)).resolves.toMatchObject({ providerMessageId: input.messageId });
    client.close();
  });

  it.each([
    ["EAUTH", `AUTH ${secret}`, 535, "auth", "AUTH"],
    ["EENVELOPE", `RCPT TO:<${secret}@example.net>`, 450, "mail", "RCPT"],
    ["ESOCKET", "MAIL FROM:<sender@example.com>", 550, "mail", "MAIL"],
    ["ESOCKET", "RCPT TO:<lead@example.net>", 451, "mail", "RCPT"],
    ["EMESSAGE", "DATA", 554, "data", "DATA"],
    ["ETIMEDOUT", "DATA", undefined, "data", "DATA"],
    ["ESOCKET", "DATA", undefined, "data", "DATA"],
    ["ECONNRESET", "DATA", undefined, "data", "DATA"],
    ["EPIPE", "DATA", undefined, "data", "DATA"],
    ["ECONNECTION", "CONN", undefined, "connect", "CONN"],
    ["ETIMEDOUT", "EHLO", undefined, "connect", "EHLO"],
    ["ESOCKET", "STARTTLS", undefined, "connect", "STARTTLS"],
    ["EDNS", "CONN", undefined, "connect", "CONN"],
    [secret, secret, 999, "connect", undefined],
  ])("safely maps %s at %s to %s", async (code, command, responseCode, stage, safeCommand) => {
    const { client, transport, imapFactory } = setup();
    transport.sendMail.mockImplementation(async ({ raw }) => {
      if (command === "DATA") await readRaw(raw);
      throw Object.assign(new Error(secret), { code, command, responseCode, response: secret });
    });
    const error = await client.sendEmail(input).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SmtpSendError);
    expect(error).toMatchObject({ stage, command: safeCommand, code: code === secret ? undefined : code, responseCode: responseCode === 999 ? undefined : responseCode });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
    expect(imapFactory).not.toHaveBeenCalled();
    client.close();
  });

  it("sanitizes transport construction errors", async () => {
    const client = createSmtpMailClient({ smtp, imap, transportFactory: () => { throw Object.assign(new Error(secret), { code: "EAUTH", command: `AUTH ${secret}` }); } });
    const error = await client.sendEmail(input).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "SmtpSendError", stage: "auth", command: "AUTH" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });

  it.each([{ unsubscribeUrl: "" }, { messageId: undefined }, { to: "invalid\r\nBcc: bad@example.com" }, { unsubscribeUrl: "http://app.example.com/unsubscribe" }])("rejects invalid MIME without sending %j", async (overrides) => {
    const { client, transport } = setup();
    await expect(client.sendEmail({ ...input, ...overrides })).rejects.toMatchObject({ name: "SmtpSendError", stage: "mail", code: "EENVELOPE", message: "SMTP message is invalid." });
    expect(transport.sendMail).not.toHaveBeenCalled();
    client.close();
  });

  it("closes idempotently and refuses sends and IMAP lookups after shutdown", async () => {
    const { client, transport, imapFactory } = setup();
    client.close();
    client.close();
    expect(transport.close).not.toHaveBeenCalled();
    await expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "connect", code: "ECONNECTION" });
    await expect(client.findSentMessage(findInput)).resolves.toBe("unknown");
    expect(imapFactory).not.toHaveBeenCalled();
  });

  it("closes an active IMAP session synchronously", async () => {
    const { client, imapClient } = setup();
    let finishConnect!: () => void;
    vi.mocked(imapClient.connect).mockImplementation(() => new Promise<void>((resolve) => { finishConnect = resolve; }));
    const finding = client.findSentMessage(findInput);
    await vi.waitFor(() => expect(imapClient.connect).toHaveBeenCalledOnce());
    client.close();
    expect(imapClient.close).toHaveBeenCalledOnce();
    finishConnect();
    await finding;
  });

  it("retire() closes immediately when the client is idle", async () => {
    const { client } = setup();
    await client.retire();
    await expect(client.sendEmail(input)).rejects.toMatchObject({ stage: "connect", code: "ECONNECTION" });
  });

  it("retire() waits for an in-flight send to settle, then closes the transport", async () => {
    const { client, transport, connection } = setup();
    let finishSend!: (value: unknown) => void;
    transport.sendMail.mockImplementation(async ({ raw }) => {
      await readRaw(raw);
      return await new Promise((resolve) => { finishSend = resolve; });
    });
    const sent = client.sendEmail(input);
    await vi.waitFor(() => expect(transport.sendMail).toHaveBeenCalledOnce());
    const retiring = client.retire();
    expect(transport.close).not.toHaveBeenCalled();
    finishSend({ messageId: "x" });
    await sent;
    await retiring;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("retire() force-closes a stuck IMAP lookup after the bounded wait instead of waiting forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, imapClient } = setup({ sendDeadlineMs: 5_000 });
    let finishConnect!: () => void;
    vi.mocked(imapClient.connect).mockImplementation(() => new Promise<void>((resolve) => { finishConnect = resolve; }));
    const finding = client.findSentMessage(findInput);
    await vi.waitFor(() => expect(imapClient.connect).toHaveBeenCalledOnce());
    const retiring = client.retire();
    await vi.advanceTimersByTimeAsync(5_000);
    await retiring;
    expect(imapClient.close).toHaveBeenCalledOnce();
    finishConnect();
    await expect(finding).resolves.toBe("unknown");
  });
});

describe("conservative SMTP Sent reconciliation", () => {
  it("returns sent only after a successful exact Message-ID header search", async () => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.search).mockResolvedValue([123]);
    await expect(client.findSentMessage(findInput)).resolves.toBe("sent");
    expect(imapClient.search).toHaveBeenCalledWith({ header: { "Message-ID": input.messageId } }, { uid: true });
    expect(imapClient.logout).toHaveBeenCalledOnce();
    client.close();
  });

  it.each([
    [undefined, "unknown"], [new Date("invalid"), "unknown"],
    [new Date(fixedNow.getTime() + 60_000), "unknown"], [new Date(fixedNow.getTime() - 599_999), "unknown"],
    [new Date(fixedNow.getTime() - 600_000), "unknown"], [new Date(fixedNow.getTime() - 600_001), "unknown"],
    [new Date("2020-01-01"), "unknown"],
  ])("never treats an empty Sent folder as non-submission, regardless of age: %s", async (after, expected) => {
    const { client } = setup();
    await expect(client.findSentMessage({ ...findInput, after })).resolves.toBe(expected);
    client.close();
  });

  it.each(["connect", "list", "open", "search", "search-false", "factory"])("returns unknown, never not_sent, when %s fails", async (failure) => {
    const { client, imapClient, imapFactory } = setup();
    if (failure === "connect") vi.mocked(imapClient.connect).mockRejectedValue(new Error(secret));
    if (failure === "list") vi.mocked(imapClient.list).mockRejectedValue(new Error(secret));
    if (failure === "open") vi.mocked(imapClient.mailboxOpen).mockRejectedValue(new Error(secret));
    if (failure === "search") vi.mocked(imapClient.search).mockRejectedValue(new Error(secret));
    if (failure === "search-false") vi.mocked(imapClient.search).mockResolvedValue(false);
    if (failure === "factory") imapFactory.mockImplementation(() => { throw new Error(secret); });
    await expect(client.findSentMessage({ ...findInput, after: new Date(fixedNow.getTime() - 900_000) })).resolves.toBe("unknown");
    if (failure === "list") {
      expect(imapClient.mailboxOpen).not.toHaveBeenCalled();
      expect(imapClient.search).not.toHaveBeenCalled();
    }
    client.close();
  });

  it.each([undefined, "missing-brackets@example.net", "<root@example.net>\r\nInjected: true"])("avoids IMAP for invalid or absent Message-ID %s", async (messageId) => {
    const { client, imapFactory } = setup();
    await expect(client.findSentMessage({ ...findInput, messageId })).resolves.toBe("unknown");
    expect(imapFactory).not.toHaveBeenCalled();
    client.close();
  });

  it.each(["Sent", "Sent Items", "Sent Messages", "INBOX.Sent"])("supports Sent name fallback %s", async (folder) => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.list).mockResolvedValue([]);
    vi.mocked(imapClient.mailboxOpen).mockImplementation(async (path) => {
      if (path !== folder) throw new Error(secret);
      return { path };
    });
    vi.mocked(imapClient.search).mockResolvedValue([123]);
    await expect(client.findSentMessage(findInput)).resolves.toBe("sent");
    expect(imapClient.mailboxOpen).toHaveBeenLastCalledWith(folder);
    client.close();
  });

  it("honors special-use flags and real folder casing before fallbacks", async () => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.list).mockResolvedValue([{ path: "Localized/Sent", flags: new Set(["\\Sent"]) }]);
    await client.findSentMessage(findInput);
    expect(imapClient.mailboxOpen).toHaveBeenCalledWith("Localized/Sent");
    vi.mocked(imapClient.list).mockResolvedValue([{ path: "SENT", flags: new Set() }]);
    await client.findSentMessage(findInput);
    expect(imapClient.mailboxOpen).toHaveBeenLastCalledWith("SENT");
    client.close();
  });

  it("does not turn failure to open the actual special-use folder into absence in a guessed folder", async () => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.mailboxOpen).mockRejectedValueOnce(new Error(secret)).mockResolvedValue({ path: "Sent" });
    await expect(client.findSentMessage({ ...findInput, after: new Date(fixedNow.getTime() - 900_000) })).resolves.toBe("unknown");
    expect(imapClient.mailboxOpen).toHaveBeenCalledOnce();
    expect(imapClient.search).not.toHaveBeenCalled();
    client.close();
  });
});

describe("SMTP reply lookups", () => {
  const after = new Date("2026-10-08T10:00:00.000Z");
  const lookup = { connectedAccountId: "mailbox-1", userId: "user-1", provider: "smtp" as const, senderEmail: "lead@example.net", after };

  function replySource(uid: number, date = "Thu, 08 Oct 2026 11:00:00 +0000", from = lookup.senderEmail): Buffer {
    return Buffer.from([
      `From: Lead <${from}>`, `To: ${smtp.username}`, "Subject: Re: Hello",
      `Message-ID: <reply-${uid}@example.net>`, "References: <root@example.net> <parent@example.net>",
      "In-Reply-To: <parent@example.net>", `Date: ${date}`, "Content-Type: text/plain; charset=utf-8", "", "Let's talk.",
    ].join("\r\n"));
  }

  it("searches INBOX by sender and date and maps RFC reply identifiers", async () => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.search).mockResolvedValue([2, 1]);
    imapClient.fetchOne = vi.fn(async (uid) => ({ uid: Number(uid), source: replySource(Number(uid)), internalDate: fixedNow }));

    await expect(client.fetchReplies!(lookup)).resolves.toEqual([1, 2].map((uid) => ({
      providerMessageId: `<reply-${uid}@example.net>`, providerThreadId: "<root@example.net>",
      subject: "Re: Hello", bodyText: "Let's talk.", from: lookup.senderEmail, receivedAt: new Date("2026-10-08T11:00:00.000Z"),
    })));
    expect(imapClient.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(imapClient.list).not.toHaveBeenCalled();
    expect(imapClient.search).toHaveBeenCalledWith({ from: lookup.senderEmail, since: after }, { uid: true });
    expect(imapClient.fetchOne).toHaveBeenNthCalledWith(1, "1", { source: true, internalDate: true }, { uid: true });
    expect(imapClient.logout).toHaveBeenCalledOnce();
    client.close();
  });

  it("filters same-day messages before the exact cutoff and partial FROM matches", async () => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.search).mockResolvedValue([1, 2, 3]);
    imapClient.fetchOne = vi.fn(async (uid) => ({ uid: Number(uid), source: uid === "1"
      ? replySource(1, "Thu, 08 Oct 2026 09:00:00 +0000")
      : replySource(Number(uid), undefined, uid === "2" ? "other-lead@example.net" : lookup.senderEmail) }));
    await expect(client.fetchReplies!(lookup)).resolves.toMatchObject([{ providerMessageId: "<reply-3@example.net>" }]);
    await expect(client.findReply!(lookup)).resolves.toBe(true);
    vi.mocked(imapClient.search).mockResolvedValue([]);
    await expect(client.findReply!(lookup)).resolves.toBe(false);
    client.close();
  });

  it("uses In-Reply-To when References is absent and internalDate when Date is absent", async () => {
    const { client, imapClient } = setup();
    vi.mocked(imapClient.search).mockResolvedValue([1]);
    imapClient.fetchOne = vi.fn().mockResolvedValue({ uid: 1, internalDate: fixedNow, source: Buffer.from([
      `From: ${lookup.senderEmail}`, "Message-ID: <reply@example.net>", "In-Reply-To: <parent@example.net>", "", "Hello",
    ].join("\r\n")) });
    await expect(client.fetchReplies!({ ...lookup, after: undefined })).resolves.toMatchObject([{ providerThreadId: "<parent@example.net>", receivedAt: fixedNow }]);
    expect(imapClient.search).toHaveBeenCalledWith({ from: lookup.senderEmail }, { uid: true });
    client.close();
  });

  it.each(["search", "fetch", "closed"])("fails safely instead of claiming no reply after %s failure, tagged with the \"search\" stage so the worker retries instead of cancelling the lead", async (failure) => {
    const { client, imapClient, imapFactory } = setup();
    imapClient.fetchOne = vi.fn().mockRejectedValue(new Error(secret));
    vi.mocked(imapClient.search).mockResolvedValue(failure === "search" ? false : [1]);
    if (failure === "closed") client.close();
    await expect(client.fetchReplies!(lookup)).rejects.toMatchObject({ name: "ImapError", stage: "search", message: "IMAP reply lookup failed." });
    if (failure === "closed") expect(imapFactory).not.toHaveBeenCalled();
    else expect(imapClient.logout).toHaveBeenCalledOnce();
    client.close();
  });

  it("maps an IMAP authentication failure to the auth stage", async () => {
    const { client, imapClient } = setup();
    imapClient.connect = vi.fn().mockRejectedValue(Object.assign(new Error(secret), { authenticationFailed: true }));
    const rejection = await client.fetchReplies!(lookup).catch((error) => error);
    expect(rejection).toMatchObject({ name: "ImapError", stage: "auth" });
    expect(rejection.message).not.toContain(secret);
    client.close();
  });

  it("maps an IMAP connection timeout to the connect stage", async () => {
    const { client, imapClient } = setup();
    imapClient.connect = vi.fn().mockRejectedValue(Object.assign(new Error(secret), { code: "ETIMEDOUT" }));
    const rejection = await client.fetchReplies!(lookup).catch((error) => error);
    expect(rejection).toMatchObject({ name: "ImapError", stage: "connect" });
    expect(rejection.message).not.toContain(secret);
    client.close();
  });
});
