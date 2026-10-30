import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposioRequestError, createComposioClient, signWebhook, verifyWebhook } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("Composio client", () => {
  it("uses the connected account address when it is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ toolkit: { slug: "gmail" }, data: { email: "real@example.com" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.getConnectedAccount("ca_real")).resolves.toMatchObject({ email: "real@example.com", provider: "gmail" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the provider profile when the address is absent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ toolkit: { slug: "gmail" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ successful: true, data: { emailAddress: "profile@example.com" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.getConnectedAccount("ca_profile")).resolves.toMatchObject({ email: "profile@example.com", provider: "gmail" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://composio.test/api/v3.1/tools/execute/GMAIL_GET_PROFILE");
  });

  it("returns a null address when neither account nor profile provides one", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ toolkit: { slug: "outlook" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ successful: true, data: { displayName: "Mailbox owner" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.getConnectedAccount("ca_pending")).resolves.toMatchObject({ email: null, provider: "outlook" });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({ endpoint: "https://graph.microsoft.com/v1.0/me", method: "GET" });
  });

  it("executes Gmail sends through the v3.1 tool endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ successful: true, data: { message_id: "gmail-1", thread_id: "thread-1" }, log_id: "log-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.sendEmail({ connectedAccountId: "ca_1", userId: "user-1", provider: "gmail", to: "lead@example.com", subject: "Hello", body: "Hi" })).resolves.toEqual({ providerMessageId: "gmail-1", providerThreadId: "thread-1", logId: "log-1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://composio.test/api/v3.1/tools/execute/GMAIL_SEND_EMAIL");
    expect(JSON.parse(String(init.body))).toEqual({ connected_account_id: "ca_1", user_id: "user-1", version: "20260826_00", arguments: { recipient_email: "lead@example.com", subject: "Hello", body: "Hi", is_html: false } });
  });

  it("uses Outlook's current recipient shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ successful: true, data: {}, log_id: "log-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");
    await client.sendEmail({ connectedAccountId: "ca_2", userId: "user-2", provider: "outlook", to: "lead@example.com", subject: "Hello", body: "Hi" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ connected_account_id: "ca_2", user_id: "user-2", version: "20260826_00", arguments: { to_email: "lead@example.com", subject: "Hello", body: "Hi", is_html: false, save_to_sent_items: true, user_id: "me" } });
  });

  it("sends HTML when supplied while retaining the plaintext input contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ successful: true, data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");
    await client.sendEmail({ connectedAccountId: "ca_3", userId: "user-3", provider: "gmail", to: "lead@example.com", subject: "Hello", body: "Plain text", html: "<p>HTML</p>" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).arguments).toMatchObject({ body: "<p>HTML</p>", is_html: true });
  });

  it("preserves failed response details and Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "retry-after": "120" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    const error = await client.sendEmail({ connectedAccountId: "ca_4", userId: "user-4", provider: "gmail", to: "lead@example.com", subject: "Hello", body: "Hi" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ComposioRequestError);
    expect(error).toMatchObject({ status: 429, body: { error: "rate limited" }, retryAfter: new Date("2026-09-01T12:02:00.000Z") });
    vi.useRealTimers();
  });

  it("checks the prior provider thread for replies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ successful: true, data: { messages: [{ from: "lead@example.com", thread_id: "thread-1", received_at: "2026-09-01T11:00:00.000Z" }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createComposioClient("secret", "https://composio.test/api", "20260826_00");

    await expect(client.findReply?.({ connectedAccountId: "ca_5", userId: "user-5", provider: "gmail", senderEmail: "lead@example.com", threadId: "thread-1", after: new Date("2026-09-01T10:00:00.000Z") })).resolves.toBe(true);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).user_id).toBe("user-5");
    expect(JSON.parse(String(init.body)).arguments.query).toContain("from:lead@example.com");
  });
});

describe("webhook verification", () => {
  it("accepts a fresh matching signature and rejects changed content", () => {
    const body = JSON.stringify({ id: "event-1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${signWebhook(body, "hook-1", timestamp, "a".repeat(32))}`;
    expect(verifyWebhook(body, signature, "hook-1", timestamp, "a".repeat(32))).toBe(true);
    expect(verifyWebhook(`${body} `, signature, "hook-1", timestamp, "a".repeat(32))).toBe(false);
  });
});
