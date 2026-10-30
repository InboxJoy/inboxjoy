import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposioClient } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());
const client = () => createComposioClient("test", "https://proxy.test/api");
const input = { connectedAccountId: "ca", userId: "user", provider: "gmail" as const, from: "sender@example.com", to: "lead@example.com", subject: "Hello ✓", body: "Hello\nUnsubscribe", html: "<p>Hello</p>", unsubscribeUrl: "https://example.com/api/v1/unsubscribe?token=signed", messageId: "<unique-1@messages.inboxjoy.online>" };
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe("provider sending safety", () => {
  it("sends a multipart Gmail message with one-click and unique Message-ID headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 200, data: { id: "sent", threadId: "thread" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().sendEmail(input)).resolves.toMatchObject({ providerMessageId: "sent" });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(request.endpoint).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const mime = Buffer.from(request.body.raw, "base64url").toString();
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n");
    expect(mime).toContain(`List-Unsubscribe: <${input.unsubscribeUrl}>`);
    expect(mime).toContain(`Message-ID: ${input.messageId}`);
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
  });
  it("sends Outlook MIME as raw base64 without JSON quoting and preserves reply headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await client().sendEmail({ ...input, provider: "outlook", inReplyTo: "<previous@messages.inboxjoy.online>" });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(request.endpoint).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(request.binary_body.content_type).toBe("text/plain");
    const mime = Buffer.from(Buffer.from(request.binary_body.base64, "base64").toString(), "base64").toString();
    expect(mime).toContain("In-Reply-To: <previous@messages.inboxjoy.online>");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });
  it("propagates upstream rejection and does not retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 429, data: { error: "slow down" }, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().sendEmail(input)).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects header injection before contacting a provider", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(client().sendEmail({ ...input, from: "a@example.com\r\nBcc: victim@example.com" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("matches display-name senders and numeric Gmail timestamps", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ successful: true, data: { messages: [{ from: "Jane Doe <LEAD@example.com>", internalDate: "1788260400000" }] } })));
    await expect(client().findReply!({ connectedAccountId: "ca", userId: "user", provider: "gmail", senderEmail: "lead@example.com", after: new Date("2026-09-01T10:00:00Z") })).resolves.toBe(true);
  });
  it("keeps legacy uncertain sends paused without searching by subject", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(client().findSentMessage({ connectedAccountId: "ca", provider: "gmail", recipientEmail: "lead@example.com", subject: "Hello" })).resolves.toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("requires exact Sent-folder Message-ID, recipient and timestamp evidence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ status: 200, data: { messages: [{ id: "m" }] } }))
      .mockResolvedValueOnce(response({ status: 200, data: { labelIds: ["SENT"], internalDate: "1788260400000", payload: { headers: [{ name: "Message-ID", value: input.messageId }, { name: "To", value: "lead@example.com" }] } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().findSentMessage({ connectedAccountId: "ca", provider: "gmail", recipientEmail: "lead@example.com", subject: "Hello", messageId: input.messageId, after: new Date("2026-09-01T10:00:00Z") })).resolves.toBe("sent");
  });
  it("does not accept an unrelated old message even when search returns it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: 200, data: { value: [{ internetMessageId: "<old@example.com>", sentDateTime: "2026-09-01T12:00:00Z", toRecipients: [{ emailAddress: { address: "lead@example.com" } }] }] } })));
    await expect(client().findSentMessage({ connectedAccountId: "ca", provider: "outlook", recipientEmail: "lead@example.com", subject: "Hello", messageId: input.messageId, after: new Date("2026-09-01T10:00:00Z") })).resolves.toBe("unknown");
  });
});
