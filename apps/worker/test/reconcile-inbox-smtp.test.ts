import { describe, expect, it, vi } from "vitest";

import { reconcileInbox } from "../src/jobs/reconcile-inbox.js";

const attemptedAt = new Date("2026-10-08T12:00:00.000Z");
const message = {
  id: "smtp-message",
  workspace_id: "workspace",
  enrollment_id: "enrollment",
  sequence_step_id: "step",
  email_account_id: "smtp-mailbox",
  contact_id: "contact",
  recipient_email: "lead@example.com",
  normalized_recipient_email: "lead@example.com",
  subject: "Hello",
  idempotency_key: "enrollment:step",
  metadata: { providerRfcMessageId: "<pinned@example.com>", providerAttemptedAt: attemptedAt.toISOString() },
  provider_message_id: null,
  provider_thread_id: null,
  provider: "smtp",
  composio_connected_account_id: null,
  daily_limit: 40,
  hourly_limit: 10,
  ramp_started_on: null,
  ramp_paused_days: 0,
  workspace_daily_cap: 200,
  status: "failed",
  postal_address: null,
  mailbox_email: "sender@example.com",
  campaign_id: null,
};

describe("SMTP send reconciliation", () => {
  it.each(["sent", "not_sent", "unknown"] as const)("routes SMTP with Composio disabled and preserves %s evidence", async (outcome) => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        statements.push({ text, values });
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [message] }), connect: vi.fn().mockResolvedValue(client) };
    const findSentMessage = vi.fn().mockResolvedValue(outcome);
    const mailClientFor = vi.fn().mockResolvedValue({ enabled: true, sendEmail: vi.fn(), findSentMessage });

    await reconcileInbox({}, { pool: pool as never, mailClientFor, apiBaseUrl: "https://api.test", authSecret: "secret" });

    expect(mailClientFor).toHaveBeenCalledWith({ provider: "smtp", emailAccountId: "smtp-mailbox" });
    expect(findSentMessage).toHaveBeenCalledWith(expect.objectContaining({ provider: "smtp", messageId: "<pinned@example.com>", after: attemptedAt }));
    expect(findSentMessage.mock.calls[0]?.[0]).not.toHaveProperty("attemptedAt");
    if (outcome === "sent") {
      const accepted = statements.find((statement) => statement.text.includes("UPDATE messages SET status='accepted'"));
      expect(accepted?.values?.slice(0, 3)).toEqual([message.id, "<pinned@example.com>", "<pinned@example.com>"]);
    } else if (outcome === "not_sent") {
      expect(statements.some((statement) => statement.text.includes("stop_reason='provider_not_sent'"))).toBe(true);
    } else {
      expect(statements.some((statement) => statement.text.includes("UPDATE messages") || statement.text.includes("UPDATE enrollments"))).toBe(false);
    }
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("leaves unconfigured Composio messages untouched", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ ...message, provider: "gmail" }] }), connect: vi.fn() };
    const mailClientFor = vi.fn();
    await reconcileInbox({}, { pool: pool as never, mailClientFor, apiBaseUrl: "https://api.test", authSecret: "secret" });
    expect(mailClientFor).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("restores the attempted SMTP reference root after an ambiguous follow-up", async () => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        statements.push({ text, values });
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ...message, metadata: { ...message.metadata, providerRfcThreadId: "<previous@example.com>" } }] }),
      connect: vi.fn().mockResolvedValue(client),
    };
    const mailClientFor = vi.fn().mockResolvedValue({ enabled: true, sendEmail: vi.fn(), findSentMessage: vi.fn().mockResolvedValue("sent") });

    await reconcileInbox({}, { pool: pool as never, mailClientFor, apiBaseUrl: "https://api.test", authSecret: "secret" });

    const accepted = statements.find((statement) => statement.text.includes("UPDATE messages SET status='accepted'"));
    expect(accepted?.values?.slice(0, 3)).toEqual([message.id, "<pinned@example.com>", "<previous@example.com>"]);
  });
});
