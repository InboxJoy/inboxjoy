import { lookup } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAutoReply } from "../../core/src/inbound/classify.js";
import { createInboxImapClient, parseImapMessage } from "../src/imap-inbox.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));
beforeEach(() => vi.mocked(lookup).mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never));

describe("IMAP inbound normalization", () => {
  it.each(["Auto-Submitted: auto-replied", "Precedence: auto_reply", "X-Autoreply: yes", "X-Autorespond: yes"])("preserves %s in the shared classifier's exact header shape", async (header) => {
    const { data } = await parseImapMessage(Buffer.from([
      "From: Lead <lead@example.com>", "To: Sender <sender@example.com>", "Subject: Re: Intro", header,
      "Message-ID: <reply@example.com>", "References: <root@example.com>\r\n <parent@example.com>",
      "In-Reply-To: <parent@example.com>", "Date: Thu, 08 Oct 2026 12:00:00 +0000", "", "Automatic response.",
    ].join("\r\n")));
    expect(data).toMatchObject({ from: "lead@example.com", to: ["sender@example.com"], message_id: "<reply@example.com>", thread_id: "<root@example.com>", message_text: "Automatic response.", message_timestamp: "2026-10-08T12:00:00.000Z" });
    expect(isAutoReply(data)).toBe(true);
  });

  it("extracts only delivery-status fields, including multiple recipients and Original-Recipient fallback", async () => {
    const { bounce, data } = await parseImapMessage(Buffer.from([
      "From: postmaster@example.com", "To: sender@example.com", "Subject: Delivery report",
      "Content-Type: multipart/report;\r\n report-type=\"delivery-status\"; boundary=dsn", "", "--dsn",
      "Content-Type: text/plain", "", "Undeliverable message; diagnostic mentions 550.", "--dsn",
      "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; example.com", "Original-Message-ID: <sent@example.com>", "",
      "Final-Recipient: rfc822; LEAD@example.com", "Action: failed", "Status: 5.1.1", "",
      "Original-Recipient: rfc822; later@example.com", "Action: delayed", "Status: 4.2.2", "Diagnostic-Code: smtp; 550 unrelated diagnostic", "--dsn--", "",
    ].join("\r\n")));
    expect(bounce).toEqual([
      { recipient: "lead@example.com", action: "failed", status: "5.1.1" },
      { recipient: "later@example.com", action: "delayed", status: "4.2.2" },
    ]);
    expect(data.original_message_id).toBe("<sent@example.com>");
  });

  it("marks malformed or nonfailure delivery reports as DSNs rather than human replies", async () => {
    const { bounce } = await parseImapMessage(Buffer.from([
      "From: lead@example.com", "Content-Type: multipart/report; report-type=delivery-status; boundary=dsn", "", "--dsn",
      "Content-Type: message/delivery-status", "", "Final-Recipient: rfc822; lead@example.com", "Action: delivered", "Status: 2.0.0", "--dsn--",
    ].join("\r\n")));
    expect(bounce).toEqual([{ recipient: "lead@example.com", action: "delivered", status: "2.0.0" }]);
  });

  it("creates secure, pinned and bounded IMAP connections without exposing credentials in logs", async () => {
    const factory = vi.fn().mockReturnValue({});
    await createInboxImapClient({ host: "imap.example.com", port: 143, secure: false, username: "sender@example.com", password: "secret" }, factory);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: "8.8.8.8", servername: "imap.example.com", doSTARTTLS: true, tls: { rejectUnauthorized: true }, logger: false, disableAutoIdle: true, connectionTimeout: 10_000, socketTimeout: 15_000 }));
  });

  it("revalidates the inbox reader on each connection and pins IPv6 without disabling hostname verification", async () => {
    const config = { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com", password: "secret" };
    const factory = vi.fn().mockReturnValue({});
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "2001:4860:4860::8888", family: 6 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    await createInboxImapClient(config, factory);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: "2001:4860:4860::8888", servername: config.host, tls: { rejectUnauthorized: true } }));
    await expect(createInboxImapClient(config, factory)).rejects.toThrow("public");
    expect(factory).toHaveBeenCalledOnce();
    vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    await createInboxImapClient({ ...config, allowPrivateHosts: true }, factory);
    expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ host: "127.0.0.1", servername: config.host, tls: { rejectUnauthorized: true } }));
  });
});
