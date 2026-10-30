import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignMime } from "../src/index.js";

const input = {
  from: "sender@example.com",
  to: "lead@example.net",
  subject: "Hello ☀",
  body: "Hello,\nThis is a campaign.",
  html: "<p>Hello, <strong>campaign</strong>.</p>",
  unsubscribeUrl: "https://app.example.com/unsubscribe?token=fixed",
  messageId: "<campaign-123@inboxjoy.example>",
  inReplyTo: "<root@example.net>",
};

const goldenMime = [
  "From: sender@example.com",
  "To: lead@example.net",
  "Subject: =?UTF-8?B?SGVsbG8g4piA?=",
  "Date: Thu, 08 Oct 2026 12:00:00 GMT",
  "Message-ID: <campaign-123@inboxjoy.example>",
  "In-Reply-To: <root@example.net>",
  "References: <root@example.net>",
  "List-Unsubscribe: <https://app.example.com/unsubscribe?token=fixed>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="inboxjoy_859716dd85f6c8211dc442cf4fdeab8e"',
  "",
  "--inboxjoy_859716dd85f6c8211dc442cf4fdeab8e",
  'Content-Type: text/plain; charset="UTF-8"',
  "Content-Transfer-Encoding: base64",
  "",
  "SGVsbG8sClRoaXMgaXMgYSBjYW1wYWlnbi4=",
  "--inboxjoy_859716dd85f6c8211dc442cf4fdeab8e",
  'Content-Type: text/html; charset="UTF-8"',
  "Content-Transfer-Encoding: base64",
  "",
  "PHA+SGVsbG8sIDxzdHJvbmc+Y2FtcGFpZ248L3N0cm9uZz4uPC9wPg==",
  "--inboxjoy_859716dd85f6c8211dc442cf4fdeab8e--",
  "",
].join("\r\n");

afterEach(() => vi.useRealTimers());

describe("campaign MIME", () => {
  it("matches the exact pre-extraction golden snapshot, including CRLF and deterministic boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    expect(campaignMime(input)).toBe(goldenMime);
    expect(campaignMime(input)).toBe(goldenMime);
  });

  it("retains the unsubscribe requirement and validation", () => {
    expect(() => campaignMime({ ...input, unsubscribeUrl: undefined })).toThrow();
    expect(() => campaignMime({ ...input, unsubscribeUrl: "http://app.example.com/unsubscribe" })).toThrow("Invalid unsubscribe URL");
    expect(() => campaignMime({ ...input, unsubscribeUrl: `${input.unsubscribeUrl}\r\nInjected: true` })).toThrow("Invalid unsubscribe URL");
  });

  it.each([
    { from: "sender@example.com\r\nInjected: true" },
    { to: "lead@example.net\nInjected: true" },
    { messageId: undefined },
    { messageId: "<campaign@example.com>\r\nInjected: true" },
    { inReplyTo: "<root@example.net>\r\nInjected: true" },
  ])("retains address and threading safety for %j", (overrides) => {
    expect(() => campaignMime({ ...input, ...overrides })).toThrow();
  });

  it("omits HTML and threading when absent, preserving 76-character base64 folding", () => {
    const mime = campaignMime({ ...input, html: undefined, inReplyTo: undefined, body: "Long message ".repeat(25) });
    expect(mime).not.toContain("text/html");
    expect(mime).not.toContain("In-Reply-To:");
    expect(mime).not.toContain("References:");
    const encoded = mime.split("Content-Transfer-Encoding: base64\r\n\r\n")[1]!.split("\r\n--")[0]!;
    expect(encoded.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString()).toBe("Long message ".repeat(25));
  });
});
