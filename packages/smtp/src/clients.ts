import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from "imapflow";
import { assertSafeMailHost } from "./guard.js";

export type MailConnectionConfig = { host: string; port: number; secure: boolean; username: string; password: string; connectionTimeout?: number; socketTimeout?: number; requireTLS?: boolean; rejectUnauthorized?: boolean; allowPrivateHosts?: boolean };
export type SmtpTransport = { verify(): Promise<unknown>; close(): void };
export type ImapClient = { connect(): Promise<unknown>; mailboxOpen(path: string): Promise<Pick<MailboxObject, "uidValidity" | "uidNext">>; logout(): Promise<void>; close(): void; on(event: "error", listener: (error: Error) => void): unknown };
export type SmtpFactoryOptions = { transportFactory?: (options: SMTPTransport.Options) => SmtpTransport; allowPrivateHosts?: boolean };
export type ImapFactoryOptions = { imapFactory?: (options: ImapFlowOptions) => ImapClient; allowPrivateHosts?: boolean };

export async function createSmtpTransport(config: MailConnectionConfig, opts: SmtpFactoryOptions = {}): Promise<SmtpTransport> {
  const [pinned] = await assertSafeMailHost(config.host, config.port, "smtp", { allowPrivate: opts.allowPrivateHosts ?? config.allowPrivateHosts ?? process.env.SMTP_ALLOW_PRIVATE_HOSTS === "true" });
  const options: SMTPTransport.Options = {
    host: pinned!.address, port: config.port, secure: config.secure, requireTLS: !config.secure ? true : undefined,
    auth: { user: config.username, pass: config.password },
    connectionTimeout: config.connectionTimeout ?? 10_000, socketTimeout: config.socketTimeout ?? 15_000,
    tls: { rejectUnauthorized: true, servername: config.host }, logger: false, debug: false,
  };
  return opts.transportFactory ? opts.transportFactory(options) : nodemailer.createTransport(options);
}

export async function imapConnectionOptions(config: MailConnectionConfig): Promise<ImapFlowOptions> {
  const [pinned] = await assertSafeMailHost(config.host, config.port, "imap", { allowPrivate: config.allowPrivateHosts ?? process.env.SMTP_ALLOW_PRIVATE_HOSTS === "true" });
  return {
    host: pinned!.address, servername: config.host, port: config.port, secure: config.secure, doSTARTTLS: config.requireTLS ?? (!config.secure ? true : undefined),
    auth: { user: config.username, pass: config.password },
    connectionTimeout: config.connectionTimeout ?? 10_000, socketTimeout: config.socketTimeout ?? 15_000,
    greetingTimeout: 10_000, tls: { rejectUnauthorized: config.rejectUnauthorized ?? true }, logger: false, disableAutoIdle: true,
  };
}

export async function createImapClient(config: MailConnectionConfig, opts: ImapFactoryOptions = {}): Promise<ImapClient> {
  const options = await imapConnectionOptions({ ...config, rejectUnauthorized: true, allowPrivateHosts: opts.allowPrivateHosts ?? config.allowPrivateHosts });
  return opts.imapFactory ? opts.imapFactory(options) : new ImapFlow(options);
}
