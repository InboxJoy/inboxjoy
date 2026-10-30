import { describe, expect, it, vi } from "vitest";
import { createImapClient, createSmtpTransport, verifyImap, verifySmtp, type ImapClient } from "../src/index.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));

const config = { host: "mail.example.com", port: 587, secure: false, username: "user@example.com", password: "never-echo-this-password" };

function imapClient(): ImapClient {
  return { connect: vi.fn().mockResolvedValue(undefined), mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 123n, uidNext: 51 }), logout: vi.fn().mockResolvedValue(undefined), close: vi.fn(), on: vi.fn() };
}

describe("mail client verification", () => {
  it("requires SMTP STARTTLS, certificate verification and bounded timeouts", async () => {
    const transport = { verify: vi.fn().mockResolvedValue(true), close: vi.fn() };
    const transportFactory = vi.fn().mockReturnValue(transport);
    await verifySmtp(config, { transportFactory });
    expect(transportFactory).toHaveBeenCalledWith(expect.objectContaining({ host: "8.8.8.8", secure: false, requireTLS: true, auth: { user: config.username, pass: config.password }, connectionTimeout: 10_000, socketTimeout: 15_000, tls: { rejectUnauthorized: true, servername: config.host }, logger: false, debug: false }));
    expect(transport.close).toHaveBeenCalledOnce();
    await createSmtpTransport({ ...config, secure: true, port: 465 }, { transportFactory });
    expect(transportFactory.mock.lastCall?.[0]).toMatchObject({ secure: true, requireTLS: undefined });
  });

  it.each([["EAUTH", "smtp.auth", "auth"], ["ESOCKET", "smtp.host", "connect"], ["CERT_HAS_EXPIRED", "smtp.tls", "connect"]])("attributes SMTP %s without leaking secrets", async (code, field, stage) => {
    const transport = { verify: vi.fn().mockRejectedValue(Object.assign(new Error(config.password), { code })), close: vi.fn() };
    const error = await verifySmtp(config, { transportFactory: () => transport }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "SmtpSendError", field, stage });
    expect(String(error)).not.toContain(config.password);
    expect(JSON.stringify(error)).not.toContain(config.password);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("connects, selects INBOX, returns bigint cursor values and logs out", async () => {
    const client = imapClient();
    const imapFactory = vi.fn().mockReturnValue(client);
    await expect(verifyImap({ ...config, port: 143 }, { imapFactory })).resolves.toEqual({ uidValidity: 123n, uidNext: 51n });
    expect(imapFactory).toHaveBeenCalledWith(expect.objectContaining({ host: "8.8.8.8", servername: config.host, secure: false, doSTARTTLS: true, tls: { rejectUnauthorized: true }, logger: false, disableAutoIdle: true }));
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(client.logout).toHaveBeenCalledOnce();
    await createImapClient({ ...config, port: 993, secure: true }, { imapFactory });
    expect(imapFactory.mock.lastCall?.[0]).toMatchObject({ secure: true, doSTARTTLS: undefined });
  });

  it.each([[{ authenticationFailed: true }, "imap.auth"], [{ code: "CERT_HAS_EXPIRED" }, "imap.tls"], [{ code: "ECONNREFUSED" }, "imap.host"]])("attributes IMAP failures without leaking secrets", async (details, field) => {
    const client = imapClient();
    vi.mocked(client.connect).mockRejectedValue(Object.assign(new Error(config.password), details));
    vi.mocked(client.logout).mockRejectedValue(new Error(config.password));
    const error = await verifyImap({ ...config, port: 993, secure: true }, { imapFactory: () => client }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "ImapError", field });
    expect(String(error)).not.toContain(config.password);
    expect(JSON.stringify(error)).not.toContain(config.password);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("rejects INBOX selection failures and invalid cursors with cleanup", async () => {
    const client = imapClient();
    vi.mocked(client.mailboxOpen).mockRejectedValue(new Error(config.password));
    await expect(verifyImap({ ...config, port: 993, secure: true }, { imapFactory: () => client })).rejects.toMatchObject({ stage: "mailbox", field: "imap.host" });
    expect(client.logout).toHaveBeenCalledOnce();
    vi.mocked(client.mailboxOpen).mockResolvedValue({ uidValidity: 0n, uidNext: 0 });
    await expect(verifyImap({ ...config, port: 993, secure: true }, { imapFactory: () => client })).rejects.toMatchObject({ stage: "mailbox" });
  });

  it("retains safe SMTP diagnostics without copying AUTH arguments or cleanup errors", async () => {
    const transport = { verify: vi.fn().mockRejectedValue(Object.assign(new Error(config.password), { code: "EAUTH", responseCode: 535, command: `AUTH ${config.password}` })), close: vi.fn().mockImplementation(() => { throw new Error(config.password); }) };
    const error = await verifySmtp(config, { transportFactory: () => transport }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "EAUTH", responseCode: 535, command: "AUTH", stage: "auth" });
    expect(JSON.stringify(error)).not.toContain(config.password);
    expect(String(error)).not.toContain(config.password);
  });
});
