export { SmtpSendError, ImapError } from "./errors.js";
export { createSmtpMailClient, type SmtpMailClient, type SmtpMailClientOptions, type SmtpSendTransport, type SmtpSentImapClient } from "./client.js";
export { createMailClientResolver, type MailClientResolver, type MailClientResolverDependencies } from "./mail-client-resolver.js";
export { createInboxImapClient, parseImapMessage, type InboxImapClient, type InboxImapFactory } from "./imap-inbox.js";
export { assertSafeMailHost } from "./guard.js";
export { verifySmtp, verifyImap } from "./verify.js";
export { createSmtpTransport, createImapClient, type MailConnectionConfig, type SmtpTransport, type ImapClient, type SmtpFactoryOptions, type ImapFactoryOptions } from "./clients.js";
