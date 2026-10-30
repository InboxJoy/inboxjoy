import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignMime, replyMime } from "../src/index.js";

const input = {
  from: "sender@example.com", to: "lead@example.net", subject: "Hello ☀",
  body: "Hello,\nThis is a campaign.", html: "<p>Hello, <strong>campaign</strong>.</p>",
  messageId: "<campaign-123@inboxjoy.example>", inReplyTo: "<root@example.net>",
};

afterEach(() => vi.useRealTimers());

describe("reply MIME", () => {
  it("has the same MIME structure as campaigns without unsubscribe headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const campaign = campaignMime({ ...input, unsubscribeUrl: "https://app.example.com/unsubscribe" });
    const reply = replyMime(input);
    expect(reply).toBe(campaign.replace("List-Unsubscribe: <https://app.example.com/unsubscribe>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n", ""));
    expect(reply).not.toContain("List-Unsubscribe");
  });

  it("preserves complete References and the immediate parent separately", () => {
    const mime = replyMime({ ...input, inReplyTo: "<parent@example.net>", references: "<root@example.net> <parent@example.net>" });
    expect(mime).toContain("In-Reply-To: <parent@example.net>\r\nReferences: <root@example.net> <parent@example.net>\r\n");
  });

  it("supports an unthreaded text-only reply", () => {
    const mime = replyMime({ ...input, html: undefined, inReplyTo: undefined });
    expect(mime).not.toContain("text/html");
    expect(mime).not.toContain("In-Reply-To:");
    expect(mime).not.toContain("References:");
    expect(mime.endsWith("\r\n")).toBe(true);
  });

  it.each([
    { from: undefined }, { to: "lead@example.net\r\nBcc: other@example.net" },
    { messageId: undefined }, { inReplyTo: "<invalid>" },
    { references: "" }, { references: "<root@example.net>\r\nBcc: other@example.net" },
    { references: "<root@example.net> invalid" },
  ])("rejects unsafe headers %j", (overrides) => {
    expect(() => replyMime({ ...input, ...overrides })).toThrow();
  });

  it("encodes subjects rather than permitting header injection", () => {
    const mime = replyMime({ ...input, subject: "Reply\r\nBcc: other@example.net" });
    expect(mime).not.toContain("\r\nBcc:");
  });
});
