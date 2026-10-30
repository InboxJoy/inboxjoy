import { afterEach, describe, expect, it, vi } from "vitest";

import { backfillReplies } from "../src/jobs/backfill-replies.js";

const candidate = {
  workspace_id: "00000000-0000-4000-8000-000000000001",
  contact_id: "00000000-0000-4000-8000-000000000002",
  contact_email: "lead@example.com",
  enrollment_id: "00000000-0000-4000-8000-000000000003",
  sequence_id: "00000000-0000-4000-8000-000000000004",
  email_account_id: "00000000-0000-4000-8000-000000000005",
  mailbox_user_id: "00000000-0000-4000-8000-000000000006",
  provider: "gmail" as const,
  composio_connected_account_id: "connected",
  first_message_id: "00000000-0000-4000-8000-000000000007",
  first_accepted_at: new Date("2026-09-01T00:00:00.000Z"),
};

afterEach(() => vi.unstubAllGlobals());

describe("backfillReplies", () => {
  it("skips cleanly when Composio configuration is missing", async () => {
    const query = vi.fn();
    await expect(backfillReplies({}, { pool: { query } as never })).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("marks an unmatched contact so the next batch can advance past it", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes("SELECT c.workspace_id")) return { rowCount: 1, rows: [candidate] };
      return { rowCount: 1, rows: [] };
    });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { messages: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await backfillReplies({}, { pool: { query } as never, composioApiKey: "test", sleep: async () => undefined });

    expect(calls[0]?.text).toContain("c.reply_backfill_checked_at");
    const bookkeeping = calls.find((call) => call.text.includes("UPDATE contacts SET reply_backfill_checked_at=now()"));
    expect(bookkeeping?.values?.[0]).toBe(candidate.contact_id);
    expect(bookkeeping?.text).not.toContain("updated_at");
    expect(calls.some((call) => call.text.includes("replyBackfillCheckedAt"))).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("resolves SMTP rows per mailbox without requiring a Composio API key", async () => {
    const smtpCandidate = { ...candidate, provider: "smtp" };
    const query = vi.fn(async (text: string) => text.includes("SELECT c.workspace_id")
      ? { rowCount: 1, rows: [smtpCandidate] }
      : { rowCount: 1, rows: [] });
    const fetchReplies = vi.fn().mockResolvedValue([{ providerMessageId: "<reply@example.com>", providerThreadId: "<sent@example.com>", from: candidate.contact_email, bodyText: "Let's talk", receivedAt: new Date("2026-09-02T00:00:00.000Z") }]);
    const mailClientFor = vi.fn().mockResolvedValue({ enabled: true, fetchReplies });

    await backfillReplies({}, { pool: { query } as never, mailClientFor, sleep: async () => undefined });

    expect(mailClientFor).toHaveBeenCalledWith({ provider: "smtp", emailAccountId: candidate.email_account_id });
    expect(fetchReplies).toHaveBeenCalledWith(expect.objectContaining({ provider: "smtp", senderEmail: candidate.contact_email, after: new Date("2026-08-31T00:00:00.000Z") }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO replies"), expect.arrayContaining(["<reply@example.com>", JSON.stringify({ provider: "smtp" })]));
  });

  it("keeps processing SMTP rows when a Composio row has no enabled client", async () => {
    const query = vi.fn(async (text: string) => text.includes("SELECT c.workspace_id")
      ? { rowCount: 2, rows: [candidate, { ...candidate, provider: "smtp" }] }
      : { rowCount: 1, rows: [] });
    const fetchReplies = vi.fn().mockResolvedValue([]);
    const mailClientFor = vi.fn().mockResolvedValueOnce({ enabled: false }).mockResolvedValueOnce({ enabled: true, fetchReplies });
    await backfillReplies({}, { pool: { query } as never, mailClientFor, sleep: async () => undefined });
    expect(mailClientFor).toHaveBeenCalledTimes(2);
    expect(fetchReplies).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("reply_backfill_checked_at=now()"), [candidate.contact_id]);
  });
});
