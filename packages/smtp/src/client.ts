import type { FetchedReply, MailClient } from "@inboxjoy/core";
import { campaignMime, replyMime } from "@inboxjoy/email";
import { ImapFlow, type ImapFlowOptions, type ListResponse, type MailboxObject, type SearchObject } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool/index.js";
import { Readable } from "node:stream";
import { imapConnectionOptions, type MailConnectionConfig } from "./clients.js";
import { ImapError, SmtpSendError } from "./errors.js";
import { parseImapMessage, type InboxImapClient } from "./imap-inbox.js";
import { assertSafeMailHost } from "./guard.js";

export type SmtpSendTransport = {
  sendMail(input: { envelope: { from: string; to: string }; raw: Readable }): Promise<unknown>;
  close(): void;
  transporter?: { _connections?: { close(): void }[] };
};

export type SmtpSentImapClient = {
  connect(): Promise<unknown>;
  list(): Promise<Pick<ListResponse, "path" | "specialUse" | "flags">[]>;
  mailboxOpen(path: string): Promise<Pick<MailboxObject, "path">>;
  append(path: string, content: string, flags?: string[]): Promise<unknown>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;
  fetchOne?: InboxImapClient["fetchOne"];
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type SmtpMailClientOptions = {
  smtp: MailConnectionConfig;
  imap: MailConnectionConfig;
  transportFactory?: (options: SMTPPool.Options) => SmtpSendTransport;
  imapFactory?: (options: ImapFlowOptions) => SmtpSentImapClient;
  now?: () => Date;
  sendDeadlineMs?: number;
  logger?: { warn(message: string): void };
};

export type SmtpMailClient = MailClient & {
  /** Hard, synchronous shutdown: aborts any in-flight send/IMAP session immediately. Used at process shutdown. */
  close(): void;
  /**
   * Graceful retirement: closes right away if idle, otherwise waits for active sends/IMAP
   * lookups to settle (bounded by sendDeadlineMs) before closing the transport/IMAP sessions.
   * Never rejects.
   */
  retire(): Promise<void>;
};

function sendError(error: unknown, dataStarted = false): SmtpSendError {
  const details = error && typeof error === "object" ? error as { code?: unknown; command?: unknown; responseCode?: unknown } : {};
  const safeCodes = ["EAUTH", "EENVELOPE", "EMESSAGE", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETLS", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"];
  const code = typeof details.code === "string" && safeCodes.includes(details.code) ? details.code : undefined;
  const responseCode = typeof details.responseCode === "number" && Number.isInteger(details.responseCode) && details.responseCode >= 100 && details.responseCode <= 599 ? details.responseCode : undefined;
  const verb = typeof details.command === "string" ? details.command.trim().split(/\s+/, 1)[0]?.toUpperCase() : undefined;
  const command = verb && ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA"].includes(verb) ? verb : undefined;
  const stage = dataStarted || command === "DATA" ? "data" : code === "EAUTH" || command === "AUTH" ? "auth" : code === "EENVELOPE" || command === "MAIL" || command === "RCPT" ? "mail" : "connect";
  const messages = {
    connect: "SMTP connection failed.",
    auth: "SMTP authentication failed.",
    mail: "SMTP envelope submission failed.",
    data: "SMTP message submission failed.",
  };
  return new SmtpSendError(messages[stage], { stage, code, command, responseCode });
}

function imapFailureStage(error: unknown): "auth" | "connect" | "search" {
  const details = error && typeof error === "object" ? error as { code?: unknown; command?: unknown; authenticationFailed?: unknown; message?: unknown } : {};
  const code = typeof details.code === "string" ? details.code : "";
  const message = typeof details.message === "string" ? details.message : "";
  if (details.authenticationFailed === true || code === "EAUTH" || /AUTH|LOGIN/i.test(String(details.command ?? "")) || /authentication|invalid credentials|login failed/i.test(message)) {
    return "auth";
  }
  const connectCodes = ["ESOCKET", "ECONNECTION", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETLS", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"];
  if (connectCodes.includes(code) || /TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) || /certificate|STARTTLS|TLS|SSL|timed? ?out|timeout/i.test(message)) {
    return "connect";
  }
  return "search";
}

async function openSentMailbox(client: SmtpSentImapClient): Promise<string> {
  const folders = await client.list();
  const special = folders.find((folder) => folder.specialUse === "\\Sent" || folder.flags?.has("\\Sent"));
  if (special) {
    await client.mailboxOpen(special.path);
    return special.path;
  }
  for (const name of ["Sent", "Sent Items", "Sent Messages", "INBOX.Sent"]) {
    const path = folders.find((folder) => folder.path.toLowerCase() === name.toLowerCase())?.path ?? name;
    try {
      await client.mailboxOpen(path);
      return path;
    } catch {}
  }
  throw new Error("IMAP Sent folder could not be opened.");
}

export function createSmtpMailClient(opts: SmtpMailClientOptions): SmtpMailClient {
  const now = opts.now ?? (() => new Date());
  const activeImapClients = new Set<SmtpSentImapClient>();
  const activeSends = new Set<() => void>();
  let closed = false;

  // Tracks sends/IMAP lookups in flight so a graceful retire() never tears down the transport
  // or an IMAP session mid-operation; see retireClient() below.
  let activeOperations = 0;
  const idleWaiters = new Set<() => void>();
  function beginOperation(): void {
    activeOperations++;
  }
  function endOperation(): void {
    activeOperations--;
    if (activeOperations === 0) {
      for (const waiter of idleWaiters) waiter();
      idleWaiters.clear();
    }
  }

  async function withMailbox<Result>(operation: (client: SmtpSentImapClient, path: string) => Promise<Result>, inbox = false, sendClients?: Set<SmtpSentImapClient>, stopped?: () => boolean): Promise<Result> {
    if (closed) throw new Error("SMTP mail client is closed.");
    const options = await imapConnectionOptions(opts.imap);
    if (closed || stopped?.()) throw new Error("SMTP mail client is closed.");
    const client = opts.imapFactory ? opts.imapFactory(options) : new ImapFlow(options);
    activeImapClients.add(client);
    sendClients?.add(client);
    try {
      client.on("error", () => {});
      await client.connect();
      if (closed || stopped?.()) throw new Error("SMTP mail client is closed.");
      const path = inbox ? "INBOX" : await openSentMailbox(client);
      if (inbox) await client.mailboxOpen(path);
      return await operation(client, path);
    } finally {
      try { await client.logout(); } catch { try { client.close(); } catch {} }
      activeImapClients.delete(client);
      sendClients?.delete(client);
    }
  }

  async function lookupReplies(input: { senderEmail: string; after?: Date }): Promise<FetchedReply[]> {
    beginOperation();
    try {
      return await withMailbox(async (client) => {
        if (!client.fetchOne) throw new Error("IMAP reply fetching is unavailable.");
        const matches = await client.search({ from: input.senderEmail, ...(input.after ? { since: input.after } : {}) }, { uid: true });
        if (matches === false) throw new Error("IMAP reply search failed.");
        const replies: FetchedReply[] = [];
        for (const uid of [...new Set(matches)].sort((left, right) => left - right)) {
          const message = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
          if (!message) continue;
          if (!message.source) throw new Error("IMAP reply source is unavailable.");
          const { data } = await parseImapMessage(message.source, message.internalDate instanceof Date ? message.internalDate : now());
          const receivedAt = new Date(data.message_timestamp);
          if (data.from !== input.senderEmail.trim().toLowerCase() || (input.after && receivedAt < input.after)) continue;
          replies.push({
            providerMessageId: data.message_id, providerThreadId: data.thread_id,
            subject: data.subject, bodyText: data.message_text, from: data.from, receivedAt,
          });
        }
        return replies;
      }, true);
    } catch (error) {
      throw new ImapError("IMAP reply lookup failed.", { stage: imapFailureStage(error) });
    } finally {
      endOperation();
    }
  }

  async function sendEmailOperation(input: Parameters<MailClient["sendEmail"]>[0]): ReturnType<MailClient["sendEmail"]> {
      let raw: string;
      const mimeInput = { ...input, from: input.from ?? opts.smtp.username };
      try {
        raw = input.unsubscribeUrl !== undefined ? campaignMime(mimeInput) : replyMime(mimeInput);
      } catch {
        throw new SmtpSendError("SMTP message is invalid.", { stage: "mail", code: "EENVELOPE" });
      }
      let dataStarted = false;
      let stopped = false;
      let transport: SmtpSendTransport | undefined;
      const sendClients = new Set<SmtpSentImapClient>();
      const rawStream = new Readable({ read() { dataStarted = true; this.push(raw); this.push(null); } });
      const dispose = () => {
        const connections = [...(transport?.transporter?._connections ?? [])];
        try { transport?.close(); } catch {}
        for (const connection of connections) {
          try { connection.close(); } catch {}
        }
        transport = undefined;
        rawStream.destroy();
      };
      let rejectInterrupted!: (error: SmtpSendError) => void;
      const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
      const abort = () => {
        if (stopped) return;
        stopped = true;
        rejectInterrupted(sendError({ code: closed ? "ECONNECTION" : "ETIMEDOUT", command: "CONN" }, dataStarted));
        dispose();
        for (const client of sendClients) {
          try { client.close(); } catch {}
        }
      };
      const deadline = setTimeout(abort, opts.sendDeadlineMs ?? 120_000);
      deadline.unref();
      activeSends.add(abort);
      try {
        const submission = async () => {
          const [pinned] = await assertSafeMailHost(opts.smtp.host, opts.smtp.port, "smtp", { allowPrivate: opts.smtp.allowPrivateHosts ?? process.env.SMTP_ALLOW_PRIVATE_HOSTS === "true" });
          if (closed || stopped) throw new SmtpSendError("SMTP mail client is closed.", { stage: "connect", code: "ECONNECTION" });
          const options: SMTPPool.Options & { maxRequeues: number } = {
            host: pinned!.address, port: opts.smtp.port, secure: opts.smtp.secure,
            pool: true, maxConnections: 1, maxMessages: 1, maxRequeues: 0,
            getSocket(_options, callback) {
              callback(closed || stopped ? new SmtpSendError("SMTP mail client is closed.", { stage: "connect", code: "ECONNECTION" }) : null, false);
            },
            requireTLS: opts.smtp.requireTLS ?? (!opts.smtp.secure ? true : undefined),
            auth: { user: opts.smtp.username, pass: opts.smtp.password },
            connectionTimeout: opts.smtp.connectionTimeout ?? 10_000,
            greetingTimeout: 10_000, socketTimeout: opts.smtp.socketTimeout ?? 15_000,
            tls: { rejectUnauthorized: opts.smtp.rejectUnauthorized ?? true, servername: opts.smtp.host }, logger: false, debug: false,
          };
          transport = opts.transportFactory ? opts.transportFactory(options) : nodemailer.createTransport(options) as unknown as SmtpSendTransport;
          await transport.sendMail({ envelope: { from: mimeInput.from, to: input.to }, raw: rawStream });
        };
        try {
          await Promise.race([submission(), interrupted]);
        } catch (error) {
          throw sendError(error, dataStarted);
        }
        dispose();
        try {
          await Promise.race([withMailbox(async (client, path) => {
            const appended = await client.append(path, raw, ["\\Seen"]);
            if (appended === false) throw new Error("IMAP Sent append failed.");
          }, false, sendClients, () => stopped), interrupted]);
        } catch {
          try { (opts.logger ?? console).warn("SMTP send succeeded, but the IMAP Sent copy could not be saved."); } catch {}
        }
      } finally {
        clearTimeout(deadline);
        activeSends.delete(abort);
        dispose();
      }
      const references = raw.match(/^References: ([^\r\n]+)/m)?.[1];
      return { providerMessageId: input.messageId, providerThreadId: references?.trim().split(/\s+/)[0] ?? input.messageId };
  }

  async function findSentMessageOperation(input: Parameters<MailClient["findSentMessage"]>[0]): ReturnType<MailClient["findSentMessage"]> {
    if (closed || !input.messageId || !/^<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(input.messageId)) return "unknown";
    try {
      return await withMailbox(async (client) => {
        const matches = await client.search({ header: { "Message-ID": input.messageId! } }, { uid: true });
        if (matches === false) return "unknown";
        if (matches.length > 0) return "sent";
        return "unknown";
      });
    } catch {
      return "unknown";
    }
  }

  function closeClient(): void {
    if (closed) return;
    closed = true;
    for (const abort of activeSends) abort();
    activeSends.clear();
    for (const client of activeImapClients) {
      try { client.close(); } catch {}
    }
    activeImapClients.clear();
  }

  // Graceful retirement for TTL/credential-rotation eviction: closes right away when idle, or
  // waits for whatever send/IMAP lookup is in flight to settle (bounded by sendDeadlineMs, the
  // same deadline a send is already held to) before forcing the hard close. Never rejects, so a
  // caller can always safely fire-and-forget it.
  async function retireClient(): Promise<void> {
    if (closed) return;
    if (activeOperations === 0) {
      closeClient();
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      idleWaiters.add(finish);
      const forceTimer = setTimeout(finish, opts.sendDeadlineMs ?? 120_000);
      forceTimer.unref();
    });
    closeClient();
  }

  return {
    enabled: true,
    async sendEmail(input) {
      if (closed) throw new SmtpSendError("SMTP mail client is closed.", { stage: "connect", code: "ECONNECTION" });
      beginOperation();
      try {
        return await sendEmailOperation(input);
      } finally {
        endOperation();
      }
    },
    async findSentMessage(input) {
      beginOperation();
      try {
        return await findSentMessageOperation(input);
      } finally {
        endOperation();
      }
    },
    fetchReplies: lookupReplies,
    async findReply(input) {
      return (await lookupReplies(input)).length > 0;
    },
    close: closeClient,
    retire: retireClient,
  };
}
