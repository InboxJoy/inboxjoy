import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto/secret-box.js";

export type MailboxConnection = { host: string; port: number; secure: boolean; username: string };
export type MailboxConnectionWithSecret = MailboxConnection & { password: string };
export type MailboxCredentials = {
  emailAccountId: string;
  workspaceId: string;
  smtp: MailboxConnection;
  imap: MailboxConnection;
  keyVersion: number;
  verifiedAt: Date | null;
  lastVerifyError: string | null;
  lastImapUid: bigint | null;
  lastImapUidvalidity: bigint | null;
  lastPolledAt: Date | null;
};
export type MailboxCredentialsWithSecrets = Omit<MailboxCredentials, "smtp" | "imap"> & {
  smtp: MailboxConnectionWithSecret;
  imap: MailboxConnectionWithSecret;
};
type CredentialsDb = Pick<InboxJoyDb, "select" | "insert">;

export class MailboxCredentialsError extends Error {
  constructor() {
    super("Mailbox credentials could not be decrypted.");
    this.name = "MailboxCredentialsError";
  }
}

export function readMailboxCredentials(db: CredentialsDb, emailAccountId: string): Promise<MailboxCredentials | undefined>;
export function readMailboxCredentials(db: CredentialsDb, emailAccountId: string, opts: { includeSecrets: true; keys: Map<number, Buffer> }): Promise<MailboxCredentialsWithSecrets | undefined>;
export async function readMailboxCredentials(db: CredentialsDb, emailAccountId: string, opts?: { includeSecrets: true; keys: Map<number, Buffer> }): Promise<MailboxCredentials | MailboxCredentialsWithSecrets | undefined> {
  const { smtpPasswordEncrypted, imapPasswordEncrypted, ...publicColumns } = schema.mailboxCredentials;
  const columns = {
    emailAccountId: publicColumns.emailAccountId, workspaceId: publicColumns.workspaceId,
    smtpHost: publicColumns.smtpHost, smtpPort: publicColumns.smtpPort, smtpSecure: publicColumns.smtpSecure, smtpUsername: publicColumns.smtpUsername,
    imapHost: publicColumns.imapHost, imapPort: publicColumns.imapPort, imapSecure: publicColumns.imapSecure, imapUsername: publicColumns.imapUsername,
    keyVersion: publicColumns.keyVersion, verifiedAt: publicColumns.verifiedAt, lastVerifyError: publicColumns.lastVerifyError,
    lastImapUid: publicColumns.lastImapUid, lastImapUidvalidity: publicColumns.lastImapUidvalidity, lastPolledAt: publicColumns.lastPolledAt,
  };
  const [row] = await db.select({ ...columns, ...(opts?.includeSecrets === true ? { smtpPasswordEncrypted, imapPasswordEncrypted } : {}) })
    .from(schema.mailboxCredentials).where(eq(schema.mailboxCredentials.emailAccountId, emailAccountId));
  if (!row) return undefined;
  const result: MailboxCredentials = {
    emailAccountId: row.emailAccountId, workspaceId: row.workspaceId,
    smtp: { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure, username: row.smtpUsername },
    imap: { host: row.imapHost, port: row.imapPort, secure: row.imapSecure, username: row.imapUsername },
    keyVersion: row.keyVersion, verifiedAt: row.verifiedAt, lastVerifyError: row.lastVerifyError,
    lastImapUid: row.lastImapUid, lastImapUidvalidity: row.lastImapUidvalidity, lastPolledAt: row.lastPolledAt,
  };
  if (!opts || opts.includeSecrets !== true) return result;
  try {
    return {
      ...result,
      smtp: { ...result.smtp, password: decryptSecret(row.smtpPasswordEncrypted!, { keys: opts.keys, aad: `${emailAccountId}:smtp_password` }) },
      imap: { ...result.imap, password: decryptSecret(row.imapPasswordEncrypted!, { keys: opts.keys, aad: `${emailAccountId}:imap_password` }) },
    };
  } catch {
    throw new MailboxCredentialsError();
  }
}

export async function writeMailboxCredentials(db: CredentialsDb, emailAccountId: string, input: {
  workspaceId: string;
  smtp: MailboxConnectionWithSecret;
  imap: MailboxConnectionWithSecret;
  verifiedAt?: Date;
  lastImapUid?: bigint;
  lastImapUidvalidity?: bigint;
}, opts: { key: Buffer; keyVersion: number }): Promise<void> {
  const values = {
    workspaceId: input.workspaceId,
    smtpHost: input.smtp.host, smtpPort: input.smtp.port, smtpSecure: input.smtp.secure, smtpUsername: input.smtp.username,
    smtpPasswordEncrypted: encryptSecret(input.smtp.password, { ...opts, aad: `${emailAccountId}:smtp_password` }),
    imapHost: input.imap.host, imapPort: input.imap.port, imapSecure: input.imap.secure, imapUsername: input.imap.username,
    imapPasswordEncrypted: encryptSecret(input.imap.password, { ...opts, aad: `${emailAccountId}:imap_password` }),
    keyVersion: opts.keyVersion, verifiedAt: input.verifiedAt, lastVerifyError: null,
    lastImapUid: input.lastImapUid, lastImapUidvalidity: input.lastImapUidvalidity, updatedAt: new Date(),
  };
  await db.insert(schema.mailboxCredentials).values({ emailAccountId, ...values })
    .onConflictDoUpdate({ target: schema.mailboxCredentials.emailAccountId, set: values });
}
