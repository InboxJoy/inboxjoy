import { createImapClient, createSmtpTransport, type ImapFactoryOptions, type MailConnectionConfig, type SmtpFactoryOptions } from "./clients.js";
import { ImapError, SmtpSendError } from "./errors.js";

function failureField(error: unknown): "host" | "auth" | "tls" {
  const details = error && typeof error === "object" ? error as { code?: unknown; command?: unknown; authenticationFailed?: unknown; message?: unknown } : {};
  const code = typeof details.code === "string" ? details.code : "";
  const message = typeof details.message === "string" ? details.message : "";
  if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) || /certificate|STARTTLS|TLS|SSL/i.test(message)) return "tls";
  if (details.authenticationFailed === true || code === "EAUTH" || /AUTH|LOGIN/i.test(String(details.command ?? "")) || /authentication|invalid credentials|login failed/i.test(message)) return "auth";
  return "host";
}

export async function verifySmtp(config: MailConnectionConfig, opts: SmtpFactoryOptions = {}): Promise<void> {
  let transport;
  try {
    transport = await createSmtpTransport(config, opts);
    await transport.verify();
  } catch (error) {
    const field = failureField(error);
    const details = error && typeof error === "object" ? error as { code?: unknown; responseCode?: unknown; command?: unknown } : {};
    const code = typeof details.code === "string" && ["EAUTH", "ESOCKET", "ECONNECTION", "ETIMEDOUT", "ETLS", "ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(details.code) ? details.code : undefined;
    const responseCode = typeof details.responseCode === "number" && Number.isInteger(details.responseCode) && details.responseCode >= 100 && details.responseCode <= 599 ? details.responseCode : undefined;
    const verb = typeof details.command === "string" ? details.command.split(/\s+/, 1)[0]?.toUpperCase() : undefined;
    const command = verb && ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA"].includes(verb) ? verb : undefined;
    throw new SmtpSendError(field === "auth" ? "SMTP authentication failed. Check the username and password." : field === "tls" ? "SMTP TLS verification failed. Check the secure setting and server certificate." : "SMTP connection failed. Check the host and port.", { stage: field === "auth" ? "auth" : "connect", field: `smtp.${field}`, code, responseCode, command });
  } finally {
    try { transport?.close(); } catch {}
  }
}

export async function verifyImap(config: MailConnectionConfig, opts: ImapFactoryOptions = {}): Promise<{ uidValidity: bigint; uidNext: bigint }> {
  let client;
  let stage = "connect";
  try {
    client = await createImapClient(config, opts);
    client.on("error", () => {});
    await client.connect();
    stage = "mailbox";
    const mailbox = await client.mailboxOpen("INBOX");
    const uidNext = BigInt(mailbox.uidNext);
    if (mailbox.uidValidity <= 0n || uidNext < 1n) throw new Error("Invalid IMAP cursor.");
    return { uidValidity: mailbox.uidValidity, uidNext };
  } catch (error) {
    const field = failureField(error);
    throw new ImapError(field === "auth" ? "IMAP authentication failed. Check the username and password." : field === "tls" ? "IMAP TLS verification failed. Check the secure setting and server certificate." : stage === "mailbox" ? "IMAP INBOX could not be opened." : "IMAP connection failed. Check the host and port.", { stage: field === "auth" ? "auth" : field === "tls" ? "tls" : stage, field: `imap.${field}` });
  } finally {
    if (client) {
      try { await client.logout(); } catch { try { client.close(); } catch {} }
    }
  }
}
