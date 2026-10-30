import { randomBytes } from "node:crypto";
import type { InboxJoyDb } from "@inboxjoy/db";
import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto/secret-box.js";
import { MailboxCredentialsError, readMailboxCredentials, writeMailboxCredentials } from "../src/mailbox-credentials.js";

describe("mailbox credential storage boundaries", () => {
  const key = randomBytes(32);
  const id = "mailbox-id";
  const row = {
    emailAccountId: id, workspaceId: "workspace-id",
    smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: false, smtpUsername: "smtp-user",
    imapHost: "imap.example.com", imapPort: 993, imapSecure: true, imapUsername: "imap-user",
    smtpPasswordEncrypted: encryptSecret("smtp-secret", { key, keyVersion: 1, aad: `${id}:smtp_password` }),
    imapPasswordEncrypted: encryptSecret("imap-secret", { key, keyVersion: 1, aad: `${id}:imap_password` }),
    keyVersion: 1, verifiedAt: new Date(), lastVerifyError: null, lastImapUid: 50n, lastImapUidvalidity: 123n, lastPolledAt: null,
  };

  function fakeDb(records = [row]) {
    const select = vi.fn().mockImplementation(() => ({ from: () => ({ where: vi.fn().mockResolvedValue(records) }) }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    return { db: { select, insert } as unknown as InboxJoyDb, select, values, onConflictDoUpdate };
  }

  it("does not select or return ciphertext/passwords unless explicitly requested", async () => {
    const { db, select } = fakeDb();
    const result = await readMailboxCredentials(db, id);
    expect(select.mock.calls[0]?.[0]).not.toHaveProperty("smtpPasswordEncrypted");
    expect(select.mock.calls[0]?.[0]).not.toHaveProperty("imapPasswordEncrypted");
    expect(result?.smtp).toEqual({ host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure, username: row.smtpUsername });
    expect(result?.smtp).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("smtpPasswordEncrypted");
    expect(result?.imap).not.toHaveProperty("password");
    const explicitFalse = await readMailboxCredentials(db, id, { includeSecrets: false, keys: new Map([[1, key]]) } as never);
    expect(explicitFalse?.smtp).not.toHaveProperty("password");
  });

  it("decrypts both secrets only through the explicit includeSecrets option", async () => {
    const { db } = fakeDb();
    const result = await readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map([[1, key]]) });
    expect(result?.smtp.password).toBe("smtp-secret");
    expect(result?.imap.password).toBe("imap-secret");
    expect(result).not.toHaveProperty("smtpPasswordEncrypted");
    await expect(readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map() })).rejects.toThrow();
  });

  it("returns undefined for missing credentials", async () => {
    const { db } = fakeDb([]);
    expect(await readMailboxCredentials(db, id)).toBeUndefined();
  });

  it("distinguishes secret corruption and unknown keys from database read errors", async () => {
    const { db, select } = fakeDb();
    await expect(readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map() })).rejects.toBeInstanceOf(MailboxCredentialsError);
    const tampered = fakeDb([{ ...row, smtpPasswordEncrypted: "sensitive-invalid-envelope" }]);
    await expect(readMailboxCredentials(tampered.db, id, { includeSecrets: true, keys: new Map([[1, key]]) })).rejects.toMatchObject({ name: "MailboxCredentialsError", message: "Mailbox credentials could not be decrypted." });
    const unavailable = new Error("sensitive database connection error");
    select.mockImplementation(() => { throw unavailable; });
    await expect(readMailboxCredentials(db, id, { includeSecrets: true, keys: new Map([[1, key]]) })).rejects.toBe(unavailable);
  });

  it("encrypts writes and upserts with distinct account-and-field AAD", async () => {
    const { db, values, onConflictDoUpdate } = fakeDb();
    await writeMailboxCredentials(db, id, {
      workspaceId: row.workspaceId,
      smtp: { host: row.smtpHost, port: row.smtpPort, secure: row.smtpSecure, username: row.smtpUsername, password: "new-smtp-secret" },
      imap: { host: row.imapHost, port: row.imapPort, secure: row.imapSecure, username: row.imapUsername, password: "new-imap-secret" },
      verifiedAt: row.verifiedAt, lastImapUid: 50n, lastImapUidvalidity: 123n,
    }, { key, keyVersion: 1 });
    const stored = values.mock.calls[0]?.[0] as Record<string, unknown>;
    const update = onConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    for (const [field, plaintext] of [["smtp", "new-smtp-secret"], ["imap", "new-imap-secret"]]) {
      const ciphertext = stored[`${field}PasswordEncrypted`] as string;
      expect(ciphertext).toMatch(/^v1\.1\./);
      expect(ciphertext).not.toContain(plaintext);
      expect(decryptSecret(ciphertext, { keys: new Map([[1, key]]), aad: `${id}:${field}_password` })).toBe(plaintext);
      expect(() => decryptSecret(ciphertext, { keys: new Map([[1, key]]), aad: `${id}:other_field` })).toThrow();
      expect(update.set[`${field}PasswordEncrypted`]).toBe(ciphertext);
    }
    expect(JSON.stringify(stored, (_name, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain("new-smtp-secret");
  });
});
