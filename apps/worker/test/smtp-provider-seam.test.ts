import { describe, expect, it, vi } from "vitest";
import { createSmtpMailClient, type SmtpSendTransport } from "@inboxjoy/smtp";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]) }));

import { sendMessage } from "../src/jobs/send-message.js";

const payload = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  enrollmentId: "00000000-0000-4000-8000-000000000002",
  sequenceStepId: "00000000-0000-4000-8000-000000000003",
  idempotencyKey: "enrollment:step",
};

describe("SMTP provider seam", () => {
  it.each<{ method: "sendEmail" | "fetchReplies" | "findReply"; composioConfigured: boolean; failureCode?: string }>([
    { method: "sendEmail", composioConfigured: true },
    { method: "fetchReplies", composioConfigured: true },
    { method: "findReply", composioConfigured: true },
    { method: "sendEmail", composioConfigured: false },
    { method: "fetchReplies", composioConfigured: false },
    { method: "findReply", composioConfigured: false },
    { method: "sendEmail", composioConfigured: false, failureCode: "ETIMEDOUT" },
    { method: "sendEmail", composioConfigured: false, failureCode: "EMESSAGE" },
  ])("routes SMTP without Composio $method (configured=$composioConfigured, failure=$failureCode)", async ({ method, composioConfigured, failureCode }) => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    let messageStatus = "scheduled";
    const row = {
      id: "message",
      workspace_id: payload.workspaceId,
      enrollment_id: payload.enrollmentId,
      sequence_step_id: payload.sequenceStepId,
      sequence_id: "sequence",
      campaign_id: null,
      email_account_id: "smtp-mailbox",
      contact_id: "contact",
      recipient_email: "lead@example.com",
      normalized_recipient_email: "lead@example.com",
      subject: "Hello",
      tracking_token: "0123456789abcdef0123456789abcdef",
      metadata: { bodyText: "Hello", unsubscribeUrl: "https://api.test/u" },
      provider: "smtp",
      composio_connected_account_id: "connected",
      mailbox_user_id: "mailbox-user",
      mailbox_email: "sender@example.com",
      daily_limit: 50,
      hourly_limit: 10,
      ramp_started_on: null,
      ramp_paused_days: 0,
      workspace_daily_cap: 100,
      postal_address: null,
      gate_now: new Date("2026-09-01T12:00:00.000Z"),
      owner_email_verified: true,
      workspace_status: "active",
      kill_switch_enabled: false,
      campaign_status: null,
      sequence_status: "active",
      enrollment_status: "active",
      mailbox_status: "active",
      suppressed: false,
      already_replied: false,
      mailbox_today: "0",
      mailbox_hour: "0",
      workspace_today: "0",
      subscription_status: "active",
      subscription_trial_end: null,
      subscription_on_hold_grace_ends_at: null,
      in_sending_window: true,
      health_state: "healthy",
      effective_daily_limit: 50,
      throttled_until: null,
      attempt_count: "0",
      ...(method !== "sendEmail" ? { previous_accepted_at: new Date("2026-09-01T10:00:00.000Z") } : {}),
    };
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        statements.push({ text, values });
        if (text.includes("SELECT m.*")) return messageStatus === "failed" ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [row] };
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [{ ...row, message_status: "sending" }] };
        if (text.includes("UPDATE messages SET status=$2")) {
          messageStatus = String(values?.[1]);
          return { rowCount: 1, rows: [{ id: row.id }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const sendEmail = vi.fn();
    const smtpSendEmail = vi.fn().mockImplementation(async (input: { messageId: string }) => ({ providerMessageId: input.messageId, providerThreadId: input.messageId }));
    const mailClientFor = vi.fn().mockResolvedValue({ enabled: true, sendEmail: smtpSendEmail, findSentMessage: vi.fn() });
    const transport: SmtpSendTransport = {
      sendMail: vi.fn(async ({ raw }) => {
        for await (const chunk of raw) expect(chunk).toBeDefined();
        throw Object.assign(new Error("Lost or malformed final acknowledgement"), { command: "CONN", code: failureCode });
      }),
      close: vi.fn(),
    };
    let smtpClient: ReturnType<typeof createSmtpMailClient> | undefined;
    if (failureCode) {
      const config = { host: "mail.example.com", port: 587, secure: false, username: "sender@example.com", password: "secret" };
      smtpClient = createSmtpMailClient({ smtp: config, imap: { ...config, port: 993, secure: true }, transportFactory: () => transport });
      mailClientFor.mockResolvedValue(smtpClient);
    }
    const fetchReplies = vi.fn();
    const findReply = vi.fn();
    const composio = {
      enabled: true,
      sendEmail,
      ...(method === "fetchReplies" ? { fetchReplies } : {}),
      ...(method === "findReply" ? { findReply } : {}),
    };

    await expect(sendMessage(payload, {
      pool: pool as never,
      ...(composioConfigured ? { composio: composio as never } : {}),
      mailClientFor,
      apiBaseUrl: "https://api.test",
      authSecret: "secret",
      edition: "cloud",
    })).resolves.toBeUndefined();

    if (failureCode) {
      const failure = statements.find((statement) => statement.text.includes("UPDATE messages SET status=$2"));
      expect(failure?.values?.slice(1, 3)).toEqual(["failed", "unknown_provider_result"]);
      expect(statements.some((statement) => statement.text.includes("stop_reason='provider_result_unknown'"))).toBe(true);
      expect(statements.some((statement) => statement.text.includes("UPDATE enrollments SET status='cancelled'"))).toBe(false);
      await sendMessage(payload, { pool: pool as never, mailClientFor, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" });
      expect(transport.sendMail).toHaveBeenCalledOnce();
      expect(sendEmail).not.toHaveBeenCalled();
      smtpClient?.close();
      return;
    }

    expect(mailClientFor).toHaveBeenCalledWith({ provider: "smtp", emailAccountId: "smtp-mailbox" });
    expect(smtpSendEmail).toHaveBeenCalledOnce();
    expect(smtpSendEmail).toHaveBeenCalledWith(expect.objectContaining({ provider: "smtp", from: "sender@example.com", unsubscribeUrl: "https://api.test/u", messageId: expect.stringMatching(/^<.+>$/) }));
    expect(statements.some((statement) => statement.text.includes("UPDATE messages SET status=$2"))).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetchReplies).not.toHaveBeenCalled();
    expect(findReply).not.toHaveBeenCalled();
    expect(statements.find((statement) => statement.text.includes("SELECT state,failure_count,next_probe_at"))?.values)
      .toEqual(["smtp:smtp-mailbox"]);
    expect(statements.find((statement) => statement.text.includes("UPDATE messages SET status='accepted'"))?.values?.[1])
      .toBe(smtpSendEmail.mock.calls[0]?.[0].messageId);
  });
});
