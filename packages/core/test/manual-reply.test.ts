import { schema } from "@inboxjoy/db";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { operations, runOperation, type MailboxProvider, type OperationContext, type ReplySender } from "../src/index.js";

type ManualReplyEvent = {
  id: string;
  eventType: string;
  metadata: Record<string, unknown>;
};

function replyFixture(provider: MailboxProvider = "smtp", edition: "cloud" | "selfhost" = "cloud") {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const emailAccount = { id: randomUUID(), workspaceId, userId, provider, email: "sender@example.com", composioConnectedAccountId: "connected-account" };
  const contact = { id: randomUUID(), workspaceId, email: "recipient@example.com", normalizedEmail: "recipient@example.com" };
  const reply = {
    id: randomUUID(), workspaceId, contactId: contact.id, emailAccountId: emailAccount.id,
    inReplyToMessageId: null as string | null, providerMessageId: "<inbound@example.com>" as string | null,
    providerThreadId: "<root@example.com>" as string | null, subject: "Hello",
  };
  const originalMessage = { id: randomUUID(), internetMessageId: "<outbound@example.com>" as string | null, providerMessageId: "provider-outbound" };
  const events: ManualReplyEvent[] = [];
  const selectedTables: unknown[] = [];
  const gate = {
    gate_now: new Date(), workspace_status: "active", kill_switch_enabled: false,
    workspace_daily_cap: 100, workspace_today: 0, owner_email_verified: true,
    subscription_status: "active", subscription_trial_end: null, subscription_grace_end: null,
    mailbox_status: "active", daily_limit: 50, hourly_limit: 10, ramp_started_on: null,
    ramp_paused_days: 0, mailbox_today: 0, mailbox_hour: 0, in_sending_window: true,
    next_allowed_at: null, health_state: null, effective_daily_limit: null,
    throttled_until: null, circuit_state: null, next_probe_at: null, suppressed: false,
  };
  const updateEvent = vi.fn(async (patch: Partial<ManualReplyEvent>) => {
    Object.assign(events[0]!, patch);
  });
  const db = {
    select: () => ({
      from: (table: unknown) => {
        selectedTables.push(table);
        const rows = table === schema.replies ? [reply]
          : table === schema.contacts ? [contact]
          : table === schema.emailAccounts ? [emailAccount]
          : table === schema.messages ? [originalMessage]
          : table === schema.messageEvents ? events : [];
        return { where: () => ({ limit: async () => rows }) };
      },
    }),
    execute: async () => ({ rows: [gate] }),
    insert: () => ({ values: async (event: ManualReplyEvent) => { events.push(event); } }),
    delete: () => ({ where: async () => { events.length = 0; } }),
    update: () => ({ set: (patch: Partial<ManualReplyEvent>) => ({ where: async () => updateEvent(patch) }) }),
    transaction: async (callback: (transaction: OperationContext["db"]) => Promise<unknown>): Promise<unknown> => callback(db as unknown as OperationContext["db"]),
  };
  const smtpSend = vi.fn<ReplySender["sendEmail"]>().mockResolvedValue({ providerMessageId: "<manual@example.com>", providerThreadId: "<root@example.com>" });
  const composioSend = vi.fn<ReplySender["sendEmail"]>().mockResolvedValue({ providerMessageId: "composio-message", logId: "composio-log" });
  const smtp: ReplySender = { enabled: true, sendEmail: smtpSend };
  const composio: ReplySender = { enabled: true, sendEmail: composioSend };
  const mailClientFor = vi.fn<NonNullable<OperationContext["mailClientFor"]>>().mockResolvedValue(smtp);
  const context: OperationContext = {
    db: db as unknown as OperationContext["db"], workspaceId, userId,
    env: { edition, authSecret: "manual-reply-test-secret-at-least-32-characters", apiBaseUrl: "https://api.example.test" },
    composio, mailClientFor, logger: { info: vi.fn(), warn: vi.fn() },
  };
  const operation = operations.find((candidate) => candidate.name === "replies.send")!;
  const input = { id: reply.id, body: "Yes, I can.", idempotencyKey: randomUUID() };
  const send = () => runOperation(operation, context, input);
  return { context, emailAccount, reply, originalMessage, events, selectedTables, gate, updateEvent, smtp, smtpSend, composio, composioSend, mailClientFor, input, send };
}

describe("manual reply provider routing", () => {
  it("uses SMTP RFC threading and a reserved Message-ID without a Gmail thread ID", async () => {
    const fixture = replyFixture();
    fixture.composio.enabled = false;
    fixture.reply.inReplyToMessageId = fixture.originalMessage.id;

    await expect(fixture.send()).resolves.toEqual({ sent: true, providerMessageId: "<manual@example.com>", threading: "in_thread" });
    expect(fixture.mailClientFor).toHaveBeenCalledWith({ provider: "smtp", emailAccountId: fixture.emailAccount.id });
    expect(fixture.smtpSend).toHaveBeenCalledWith({
      connectedAccountId: "connected-account", userId: fixture.emailAccount.userId, provider: "smtp",
      to: "recipient@example.com", subject: "Re: Hello", body: fixture.input.body, from: "sender@example.com",
      messageId: `<${fixture.events[0]!.id}@messages.inboxjoy.online>`,
      inReplyTo: "<inbound@example.com>", references: "<root@example.com> <outbound@example.com> <inbound@example.com>",
    });
    expect(fixture.composioSend).not.toHaveBeenCalled();
    expect(fixture.events[0]).toMatchObject({ eventType: "manual_reply_sent", metadata: { provider: "smtp", providerMessageId: "<manual@example.com>", threading: "in_thread" } });

    await expect(fixture.send()).resolves.toMatchObject({ sent: true, threading: "in_thread" });
    expect(fixture.smtpSend).toHaveBeenCalledTimes(1);
    expect(fixture.mailClientFor).toHaveBeenCalledTimes(1);
  });

  it("uses the sending mailbox's domain for the Message-ID in self-host, and still sends with no license", async () => {
    const fixture = replyFixture("smtp", "selfhost");
    fixture.composio.enabled = false;
    fixture.gate.subscription_status = null as unknown as string;

    await expect(fixture.send()).resolves.toMatchObject({ sent: true });
    expect(fixture.smtpSend).toHaveBeenCalledWith(expect.objectContaining({ messageId: `<${fixture.events[0]!.id}@example.com>` }));
  });

  it("lets an unlicensed cloud workspace answer a reply", async () => {
    const fixture = replyFixture();
    fixture.composio.enabled = false;
    fixture.gate.subscription_status = null as unknown as string;

    await expect(fixture.send()).resolves.toMatchObject({ sent: true });
    expect(fixture.smtpSend).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stored outbound RFC ID rather than an opaque provider ID", async () => {
    const fixture = replyFixture();
    fixture.reply.inReplyToMessageId = fixture.originalMessage.id;
    fixture.reply.providerMessageId = "opaque-inbound-id";
    fixture.reply.providerThreadId = "opaque-thread-id";

    await fixture.send();
    expect(fixture.smtpSend).toHaveBeenCalledWith(expect.objectContaining({ inReplyTo: "<outbound@example.com>", references: "<outbound@example.com>" }));
  });

  it("uses the SMTP provider message ID when it is the only stored RFC ID", async () => {
    const fixture = replyFixture();
    fixture.reply.inReplyToMessageId = fixture.originalMessage.id;
    fixture.reply.providerMessageId = null;
    fixture.reply.providerThreadId = null;
    fixture.originalMessage.internetMessageId = null;
    fixture.originalMessage.providerMessageId = "<smtp-outbound@example.com>";

    await fixture.send();
    expect(fixture.smtpSend).toHaveBeenCalledWith(expect.objectContaining({ inReplyTo: "<smtp-outbound@example.com>", references: "<smtp-outbound@example.com>" }));
  });

  it("sends without threading when there is no valid stored RFC ID", async () => {
    const fixture = replyFixture();
    fixture.reply.providerMessageId = "<inbound@example.com>\r\nBcc: injected@example.com";
    fixture.reply.providerThreadId = "gmail-only-thread";

    await expect(fixture.send()).resolves.toMatchObject({ threading: "new_thread" });
    const sentInput = fixture.smtpSend.mock.calls[0]![0];
    expect(sentInput).not.toHaveProperty("threadId");
    expect(sentInput).not.toHaveProperty("inReplyTo");
    expect(sentInput).not.toHaveProperty("references");
    expect(sentInput).not.toHaveProperty("unsubscribeUrl");
  });

  it.each(["gmail", "outlook"] as const)("preserves the exact %s fallback payload", async (provider) => {
    const fixture = replyFixture(provider);
    fixture.context.mailClientFor = undefined;
    fixture.reply.providerThreadId = "existing-provider-thread";
    fixture.reply.inReplyToMessageId = fixture.originalMessage.id;
    fixture.reply.subject = "Re: Hello";

    await expect(fixture.send()).resolves.toMatchObject({ threading: provider === "gmail" ? "in_thread" : "new_thread" });
    expect(fixture.composioSend).toHaveBeenCalledWith({
      connectedAccountId: "connected-account", userId: fixture.emailAccount.userId, provider,
      to: "recipient@example.com", subject: "Re: Hello", body: fixture.input.body,
      ...(provider === "gmail" ? { threadId: "existing-provider-thread" } : {}),
    });
    expect(fixture.selectedTables).not.toContain(schema.messages);
    expect(fixture.smtpSend).not.toHaveBeenCalled();
  });

  it.each(["gmail", "outlook"] as const)("resolves %s to the existing Composio sender", async (provider) => {
    const fixture = replyFixture(provider);
    fixture.mailClientFor.mockResolvedValue(fixture.composio);

    await fixture.send();
    expect(fixture.mailClientFor).toHaveBeenCalledWith({ provider, emailAccountId: fixture.emailAccount.id });
    expect(fixture.composioSend).toHaveBeenCalledTimes(1);
    expect(fixture.smtpSend).not.toHaveBeenCalled();
  });
});

describe("manual reply reservations", () => {
  it("applies the existing sending gate before resolving or sending SMTP", async () => {
    const fixture = replyFixture();
    fixture.gate.kill_switch_enabled = true;

    await expect(fixture.send()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.events).toHaveLength(0);
    expect(fixture.mailClientFor).not.toHaveBeenCalled();
    expect(fixture.smtpSend).not.toHaveBeenCalled();
  });

  it("releases the reservation when SMTP credentials cannot be resolved", async () => {
    const fixture = replyFixture();
    fixture.mailClientFor.mockRejectedValue(new Error("secret-credentials"));

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Reply sending is not configured." });
    expect(fixture.events).toHaveLength(0);
    expect(fixture.smtpSend).not.toHaveBeenCalled();
    expect(fixture.context.logger?.warn).not.toHaveBeenCalled();
  });

  it("does not route SMTP through Composio when the resolver is absent", async () => {
    const fixture = replyFixture();
    fixture.context.mailClientFor = undefined;

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Reply sending is not configured." });
    expect(fixture.events).toHaveLength(0);
    expect(fixture.composioSend).not.toHaveBeenCalled();
  });

  it("releases the reservation when the resolved sender is disabled", async () => {
    const fixture = replyFixture();
    fixture.smtp.enabled = false;

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fixture.events).toHaveLength(0);
    expect(fixture.smtpSend).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "auth", code: "EAUTH", responseCode: 535 },
    { stage: "mail", responseCode: 450 },
    { stage: "data", responseCode: 550 },
    { stage: "connect", code: "ECONNECTION" },
  ])("releases a definite SMTP rejection at $stage", async (details) => {
    const fixture = replyFixture();
    fixture.smtpSend.mockRejectedValue(Object.assign(new Error("SMTP send failed"), { name: "SmtpSendError", ...details }));

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fixture.events).toHaveLength(0);
    fixture.smtpSend.mockResolvedValue({ providerMessageId: "<retry@example.com>" });
    await expect(fixture.send()).resolves.toMatchObject({ sent: true });
    expect(fixture.smtpSend).toHaveBeenCalledTimes(2);
  });

  it.each(["ETIMEDOUT", "ECONNECTION", "EMESSAGE", undefined])("retains an ambiguous SMTP DATA %s reservation despite CONN diagnostics and rejects retry without resending", async (code) => {
    const fixture = replyFixture();
    fixture.smtpSend.mockRejectedValue(Object.assign(new Error("SMTP send failed"), { name: "SmtpSendError", stage: "data", command: "CONN", code }));

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE", message: "The send result is unknown. Check the conversation before trying again." });
    expect(fixture.events[0]?.eventType).toBe("manual_reply_pending");
    await expect(fixture.send()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.smtpSend).toHaveBeenCalledTimes(1);
  });

  it("retains the reservation when SMTP acceptance cannot be persisted", async () => {
    const fixture = replyFixture();
    fixture.updateEvent.mockRejectedValue(new Error("bookkeeping failed"));

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE", message: "The reply may have been sent. Check the conversation before trying again." });
    expect(fixture.events[0]?.eventType).toBe("manual_reply_pending");
    await expect(fixture.send()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.smtpSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stage: "auth", code: "EAUTH", responseCode: 535 },
    { stage: "mail", responseCode: 550 },
    { stage: "connect", code: "ECONNECTION" },
    { stage: "data", code: "ETIMEDOUT" },
  ])("never exposes SMTP credentials from a $stage error", async (details) => {
    const fixture = replyFixture();
    const password = "smtp-password-never-in-logs";
    fixture.smtpSend.mockRejectedValue(Object.assign(new Error(password), { name: "SmtpSendError", password, ...details }));

    const failure = await fixture.send().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "UNAVAILABLE" });
    expect(String(failure)).not.toContain(password);
    expect(JSON.stringify(fixture.events)).not.toContain(password);
    expect(JSON.stringify(vi.mocked(fixture.context.logger!.warn!).mock.calls)).not.toContain(password);
    expect(fixture.events).toHaveLength(details.stage === "data" ? 1 : 0);
  });

  it.each([400, 429, 500, 408])("preserves Composio reservation behavior for HTTP %i", async (status) => {
    const fixture = replyFixture("gmail");
    fixture.context.mailClientFor = undefined;
    fixture.composioSend.mockRejectedValue(Object.assign(new Error("Provider send failed"), { status }));

    await expect(fixture.send()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fixture.events).toHaveLength(status === 400 || status === 429 ? 0 : 1);
  });
});
