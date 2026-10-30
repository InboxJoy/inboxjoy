import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposioClient } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe("fetchReplies", () => {
  it("normalizes Gmail replies and filters unrelated results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      successful: true,
      data: {
        messages: [
          {
            id: "gmail-reply-1",
            thread_id: "gmail-thread-1",
            subject: "Re: Hello",
            message_text: "Thanks for reaching out.",
            from: "Jane Lead <JANE@example.com>",
            internal_date: "1790006400000",
          },
          {
            id: "gmail-unrelated",
            from: "other@example.com",
            internal_date: "1790006401000",
          },
        ],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.fetchReplies!({
      connectedAccountId: "ca-gmail",
      userId: "user-gmail",
      provider: "gmail",
      senderEmail: "jane@example.com",
      after: new Date("2026-09-20T00:00:00.000Z"),
    })).resolves.toEqual([{
      providerMessageId: "gmail-reply-1",
      providerThreadId: "gmail-thread-1",
      subject: "Re: Hello",
      bodyText: "Thanks for reaching out.",
      from: "jane@example.com",
      receivedAt: new Date("2026-09-21T16:00:00.000Z"),
    }]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({ connected_account_id: "ca-gmail", user_id: "user-gmail" });
    expect(payload.arguments.query).toContain("from:jane@example.com after:");
  });

  it("normalizes Outlook replies and converts an HTML-only body to text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      successful: true,
      data: {
        value: [{
          id: "outlook-reply-1",
          conversationId: "outlook-thread-1",
          subject: "RE: Quick question",
          sender: { emailAddress: { address: "lead@example.com" } },
          receivedDateTime: "2026-09-21T09:15:00.000Z",
          body: { contentType: "html", content: "<p>Hello &amp; thanks.</p><p>Let's talk.</p>" },
        }],
      },
    })));
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.fetchReplies!({
      connectedAccountId: "ca-outlook",
      provider: "outlook",
      senderEmail: "lead@example.com",
    })).resolves.toEqual([{
      providerMessageId: "outlook-reply-1",
      providerThreadId: "outlook-thread-1",
      subject: "RE: Quick question",
      bodyText: "Hello & thanks.\nLet's talk.",
      from: "lead@example.com",
      receivedAt: new Date("2026-09-21T09:15:00.000Z"),
    }]);
  });

  // Regression: the original parser was written against imagined field names and
  // passed its tests while returning nothing in production, because the tool it
  // called (GMAIL_SEARCH_EMAILS) did not exist and had never returned a response.
  // This payload is the shape a live GMAIL_FETCH_EMAILS call actually returns.
  it("parses the real GMAIL_FETCH_EMAILS response shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      successful: true,
      data: {
        messages: [
          {
            messageId: "199a2f1c",
            threadId: "199a2f00",
            subject: "Re: Quick question",
            messageText: "Happy to chat, how is Thursday?",
            sender: "Charles Wilbrand <cwilbrand@knudsenlaw.com>",
            messageTimestamp: "2026-09-16T10:00:29Z",
            labelIds: ["INBOX"],
          },
        ],
        nextPageToken: null,
        resultSizeEstimate: 1,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createComposioClient("key");
    const replies = await client.fetchReplies!({
      connectedAccountId: "ca_1",
      userId: "user-1",
      provider: "gmail",
      senderEmail: "cwilbrand@knudsenlaw.com",
      after: new Date("2026-09-15T00:00:00Z"),
    });

    expect(fetchMock.mock.calls[0][0]).toContain("GMAIL_FETCH_EMAILS");
    expect(replies).toHaveLength(1);
    // receivedAt is what the backfill filters on -- if it is undefined the reply
    // is silently dropped and the backfill inserts nothing.
    expect(replies[0].receivedAt?.toISOString()).toBe("2026-09-16T10:00:29.000Z");
    expect(replies[0].bodyText).toBe("Happy to chat, how is Thursday?");
    expect(replies[0].providerMessageId).toBe("199a2f1c");
    expect(replies[0].providerThreadId).toBe("199a2f00");
    expect(replies[0].subject).toBe("Re: Quick question");
  });
});
