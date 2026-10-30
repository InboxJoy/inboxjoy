import { describe, expect, it, vi } from "vitest";
import { FREE_PLAN_MONTHLY_SEND_LIMIT } from "@inboxjoy/core";
import { ComposioRequestError } from "@inboxjoy/composio";
import { ImapError, SmtpSendError } from "@inboxjoy/smtp";
import { loadEnv } from "../src/env.js";
import { claimMessage, completeAcceptedBookkeeping, errorClass, preSendReplyCheck, recordAccepted, recordFailure, render, renderEmailHtml, sanitizedComposioErrorMessage, sendMessage } from "../src/jobs/send-message.js";

const payload = { workspaceId: "00000000-0000-4000-8000-000000000001", enrollmentId: "00000000-0000-4000-8000-000000000002", sequenceStepId: "00000000-0000-4000-8000-000000000003", idempotencyKey: "enrollment:step" };
const claimedMessage = {
  id: "message", workspace_id: payload.workspaceId, enrollment_id: payload.enrollmentId, sequence_id: "sequence", sequence_step_id: payload.sequenceStepId,
  email_account_id: "inbox", contact_id: "contact", recipient_email: "lead@example.com", normalized_recipient_email: "lead@example.com",
  subject: "Hello", tracking_token: "0123456789abcdef0123456789abcdef", metadata: { bodyText: "Hello", unsubscribeUrl: "https://api.test/u" }, provider: "gmail" as const,
  composio_connected_account_id: "connected", daily_limit: 50, hourly_limit: 10, ramp_started_on: null, workspace_daily_cap: 100,
  mailbox_user_id: "mailbox-user",
  campaign_id: "campaign", postal_address: "123 Main St\nAustin, TX 78701", mailbox_email: "sender@example.com",
};

const decisionRow = {
  ...claimedMessage,
  gate_now: new Date("2026-09-01T12:00:00.000Z"), workspace_status: "active", kill_switch_enabled: false,
  owner_email_verified: true,
  campaign_status: "active", sequence_status: "active", enrollment_status: "active", mailbox_status: "active", suppressed: false, already_replied: false,
  mailbox_today: "0", mailbox_hour: "0", workspace_today: "0", workspace_month: "0", in_sending_window: true,
  subscription_status: "active", subscription_trial_end: null, subscription_on_hold_grace_ends_at: null,
  health_state: "healthy", effective_daily_limit: 50, health_consecutive_failures: 0, health_temp_failures_24h: 0,
  health_perm_failures_24h: 0, throttled_until: null, circuit_state: "closed", circuit_failure_count: 0,
  next_probe_at: null, attempt_count: "0", previous_provider_thread_id: null,
};

const safePreSendState = {
  message_status: "sending",
  workspace_status: "active",
  kill_switch_enabled: false,
  campaign_status: "active",
  sequence_status: "active",
  enrollment_status: "active",
  mailbox_status: "active",
  suppressed: false,
  already_replied: false,
  owner_email_verified: true,
  workspace_daily_cap: 100,
  workspace_today: "0", workspace_month: "0",
  postal_address: null,
  daily_limit: 50,
  hourly_limit: 10,
  ramp_started_on: null,
  ramp_paused_days: 0,
  mailbox_today: "0",
  mailbox_hour: "0",
  in_sending_window: true,
  subscription_status: "active",
  subscription_trial_end: null,
  subscription_on_hold_grace_ends_at: null,
  health_state: "healthy",
  effective_daily_limit: 50,
  throttled_until: null,
  circuit_state: "closed",
  next_probe_at: null,
};

describe("delivery safety", () => {
  it("treats an empty optional Composio key as disabled", () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/inboxjoy",
      API_BASE_URL: "http://localhost:4000",
      AUTH_SECRET: "test-auth-secret-with-at-least-32-characters",
      COMPOSIO_API_KEY: "",
    });
    expect(env.COMPOSIO_API_KEY).toBeUndefined();
  });

  it("skips without touching the database when send configuration is incomplete", async () => {
    const connect = vi.fn(() => { throw new Error("database must not be touched"); });
    await expect(sendMessage(payload, { pool: { connect } } as never)).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it("leaves Composio messages scheduled when only SMTP is configured", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [decisionRow] };
        return { rowCount: 1, rows: [] };
      }),
    };
    await expect(claimMessage(client as never, payload, { composioConfigured: false, edition: "cloud" })).resolves.toEqual({});
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((text) => text.includes("UPDATE messages"))).toBe(false);
    expect(statements.some((text) => text.includes("INSERT INTO send_attempts"))).toBe(false);
  });

  it.each<{ stage: SmtpSendError["stage"]; code?: string; responseCode?: number; kind: "mailbox" | "retryable" | "permanent" | "unknown"; ambiguous: boolean }>([
    { stage: "auth", code: "EAUTH", kind: "mailbox", ambiguous: false },
    { stage: "auth", code: "EAUTH", responseCode: 454, kind: "retryable", ambiguous: false },
    { stage: "auth", code: "EAUTH", responseCode: 421, kind: "retryable", ambiguous: false },
    { stage: "auth", code: "EAUTH", responseCode: 450, kind: "retryable", ambiguous: false },
    { stage: "auth", responseCode: 535, kind: "mailbox", ambiguous: false },
    { stage: "auth", code: "ETIMEDOUT", kind: "retryable", ambiguous: false },
    { stage: "mail", responseCode: 535, kind: "mailbox", ambiguous: false },
    { stage: "data", responseCode: 534, kind: "mailbox", ambiguous: false },
    { stage: "mail", responseCode: 530, kind: "mailbox", ambiguous: false },
    { stage: "mail", responseCode: 538, kind: "mailbox", ambiguous: false },
    { stage: "mail", responseCode: 451, kind: "retryable", ambiguous: false },
    { stage: "mail", responseCode: 550, kind: "permanent", ambiguous: false },
    { stage: "connect", code: "ETIMEDOUT", kind: "retryable", ambiguous: false },
    { stage: "connect", code: "EDNS", kind: "retryable", ambiguous: false },
    { stage: "data", code: "ETIMEDOUT", kind: "unknown", ambiguous: true },
    { stage: "data", code: "ESOCKET", kind: "unknown", ambiguous: true },
    { stage: "data", code: "ECONNRESET", kind: "unknown", ambiguous: true },
    { stage: "data", code: "EMESSAGE", kind: "unknown", ambiguous: true },
    { stage: "data", kind: "unknown", ambiguous: true },
    { stage: "data", code: "unexpected-code", kind: "unknown", ambiguous: true },
    { stage: "data", responseCode: 451, kind: "retryable", ambiguous: false },
    { stage: "data", responseCode: 554, kind: "permanent", ambiguous: false },
  ])("classifies SMTP $stage $code $responseCode as $kind", ({ stage, code, responseCode, kind, ambiguous }) => {
    const classified = errorClass(new SmtpSendError("password-without-a-label", { stage, code, responseCode }));
    expect(classified.kind).toBe(kind);
    expect(classified.ambiguousProviderResult === true).toBe(ambiguous);
    expect(classified.status).toBe(responseCode);
    expect(classified.message).not.toContain("password-without-a-label");
    expect(classified.providerFailure).toBe(kind !== "mailbox");
  });

  it.each<{ stage: string; kind: "mailbox" | "retryable" }>([
    { stage: "search", kind: "retryable" },
    { stage: "connect", kind: "retryable" },
    { stage: "auth", kind: "mailbox" },
  ])("classifies an IMAP reply-lookup failure at stage $stage as $kind, so one IMAP hiccup cannot cancel a lead's follow-ups", ({ stage, kind }) => {
    const classified = errorClass(new ImapError("IMAP reply lookup failed.", { stage }));
    expect(classified.kind).toBe(kind);
    expect(classified.ambiguousProviderResult).toBeUndefined();
    expect(classified.providerFailure).toBe(kind === "retryable");
  });

  it("defers a claimed message for one hour when the owner is unverified", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [{ ...decisionRow, owner_email_verified: false }] };
        if (text.includes("SELECT state,failure_count,next_probe_at")) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await expect(claimMessage(client as never, payload, { edition: "cloud" })).resolves.toMatchObject({ deniedReason: "email_unverified" });

    expect(calls.some((call) => call.text.includes("JOIN auth_users au ON au.id=om.user_id"))).toBe(true);
    const denial = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(denial?.values?.[1]).toBe("scheduled");
    expect(denial?.values?.[2]).toBe("email_unverified");
    expect(denial?.values?.[3]).toEqual(new Date("2026-09-01T13:00:00.000Z"));
  });

  it("renders paragraphs, compliance details, and the tracking pixel", () => {
    const html = renderEmailHtml("Hello\n\nSecond paragraph\n\n---\n123 Main St\nAustin, TX 78701\nPrefer not to receive these emails? Unsubscribe: https://api.test/u", "https://api.test/u", "https://api.test/t/token.gif", "123 Main St\nAustin, TX 78701");
    expect(html).toContain("<p style=\"margin:0 0 16px\">Hello</p>");
    expect(html).toContain("href=\"https://api.test/u\"");
    expect(html).toContain("123 Main St<br>Austin, TX 78701");
    expect(html).toContain("src=\"https://api.test/t/token.gif\"");
  });

  it("strips CRLF characters from merge-tag values", () => {
    expect(render("Hello {{firstName}} at {{company}}", {
      first_name: "Ada\r\nBcc: attacker@example.com",
      company: "Analytical\nEngine",
    })).toBe("Hello AdaBcc: attacker@example.com at AnalyticalEngine");
  });

  it("routes ambiguous provider failures to reconciliation without retrying timeouts or throttles incorrectly", () => {
    expect(errorClass(new ComposioRequestError(503, { error: "unavailable" })).kind).toBe("unknown");
    expect(errorClass(new ComposioRequestError(429, { error: "rate limited" })).kind).toBe("retryable");
    expect(errorClass(new Error("socket timeout")).kind).toBe("retryable");
    expect(errorClass(new ComposioRequestError(401, {})).kind).toBe("mailbox");
    expect(errorClass(new ComposioRequestError(403, {})).kind).toBe("mailbox");
  });

  it("persists useful Composio details without leaking credentials", () => {
    const error = new ComposioRequestError(400, {
      error: { code: 1811, message: "Missing user_id", token: "must-not-leak" },
      request_id: "internal-request-id",
      authorization: "Bearer secret-value",
    });
    expect(sanitizedComposioErrorMessage(error)).toContain("Missing user_id");
    expect(sanitizedComposioErrorMessage(error)).toContain("1811");
    expect(sanitizedComposioErrorMessage(error)).not.toContain("must-not-leak");
    expect(sanitizedComposioErrorMessage(error)).not.toContain("secret-value");
    expect(errorClass(error).message).toBe(sanitizedComposioErrorMessage(error));
  });

  it("emits one completion notification when the final campaign enrollment finishes", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("UPDATE messages SET status='accepted'")) return { rowCount: 1, rows: [{ id: "message" }] };
        if (text.includes("SELECT metadata FROM messages")) return { rowCount: 1, rows: [{ metadata: { acceptanceBookkeepingPending: true } }] };
        if (text.includes("SELECT step_order")) return { rowCount: 1, rows: [{ step_order: 1 }] };
        if (text.includes("FROM enrollments WHERE id")) return { rowCount: 1, rows: [{ status: "active", email_account_id: null }] };
        if (text.includes("JOIN sequence_steps")) return { rowCount: 0, rows: [] };
        if (text.includes("SELECT id, name, status, launched_at, completed_at FROM campaigns")) return { rowCount: 1, rows: [{ id: "campaign", name: "Launch", status: "active", launched_at: new Date(), completed_at: null }] };
        if (text.includes("count(*)::text") && text.includes("campaign_id")) return { rowCount: 1, rows: [{ count: "0" }] };
        return { rowCount: 1, rows: [] };
      }),
    };
    await recordAccepted(client as never, claimedMessage, 1, {}, { pool: {} as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" });
    expect(statements.some((statement) => statement.includes("INSERT INTO notifications"))).toBe(true);
    expect(statements.some((statement) => statement.includes("completed_at ="))).toBe(true);
  });

  it("retries deadlocked accepted bookkeeping without another provider send", async () => {
    const statements: string[] = [];
    const claimClient = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [decisionRow] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const preflightClient = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const acceptedClient = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("UPDATE messages SET status='accepted'")) return { rowCount: 1, rows: [{ id: "message" }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const finalGateClient = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const bookkeepingClient = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes("SELECT metadata FROM messages")) return { rowCount: 1, rows: [{ metadata: { acceptanceBookkeepingPending: true } }] };
        if (text.includes("INSERT INTO mailbox_daily_usage")) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(preflightClient).mockResolvedValueOnce(finalGateClient).mockResolvedValueOnce(acceptedClient).mockResolvedValueOnce(bookkeepingClient) };
    const composio = { enabled: true, createConnectLink: vi.fn(), getConnectedAccount: vi.fn(), ensureInboundMessageTrigger: vi.fn(), findSentMessage: vi.fn(), sendEmail: vi.fn().mockResolvedValue({ providerMessageId: "provider-1" }) };

    await expect(sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" })).resolves.toBeUndefined();

    expect(pool.connect).toHaveBeenCalledTimes(5);
    expect(statements.some((statement) => statement.includes("UPDATE messages SET status=$2"))).toBe(false);
    expect(statements.some((statement) => statement.includes("UPDATE messages SET status='accepted'"))).toBe(true);
    expect(bookkeepingClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(statements.some((statement) => statement.includes("metadata=metadata-'acceptanceBookkeepingPending'"))).toBe(false);
    const retryClient = { query: vi.fn(async (text: string) => {
      if (text.includes("SELECT metadata FROM messages")) return { rowCount: 1, rows: [{ metadata: { acceptanceBookkeepingPending: true } }] };
      if (text.includes("SELECT status,email_account_id FROM enrollments")) return { rowCount: 1, rows: [{ status: "active", email_account_id: "inbox" }] };
      return { rowCount: 0, rows: [] };
    }) };
    await expect(completeAcceptedBookkeeping(retryClient as never, claimedMessage, { pool: pool as never })).resolves.toBe(true);
    expect(retryClient.query).toHaveBeenCalledWith("COMMIT");
    expect(retryClient.query.mock.calls.some(([text]) => text.includes("metadata=metadata-'acceptanceBookkeepingPending'"))).toBe(true);
    expect(composio.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends when the workspace has no postal address (optional by owner decision)", async () => {
    const withoutAddress = { ...decisionRow, postal_address: null };
    const claimClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [withoutAddress] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const gateClient = () => ({
      query: vi.fn(async (text: string) => {
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [{ ...safePreSendState, postal_address: null }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    });
    const acceptedClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes("UPDATE messages SET status='accepted'")) return { rowCount: 1, rows: [{ id: "message" }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(gateClient()).mockResolvedValueOnce(gateClient()).mockResolvedValueOnce(acceptedClient).mockResolvedValueOnce(gateClient()) };
    const composio = { enabled: true, createConnectLink: vi.fn(), getConnectedAccount: vi.fn(), ensureInboundMessageTrigger: vi.fn(), findSentMessage: vi.fn(), sendEmail: vi.fn().mockResolvedValue({ providerMessageId: "provider-no-address" }) };

    await expect(sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" })).resolves.toBeUndefined();

    expect(composio.sendEmail).toHaveBeenCalledTimes(1);
    const sent = composio.sendEmail.mock.calls[0]![0] as { body: string; html: string };
    expect(sent.body).toContain("Unsubscribe: https://api.test/u");
    expect(sent.html).not.toContain("https://api.test/t/");
  });

  it.each([
    { setting: undefined, pixel: false },
    { setting: false, pixel: false },
    { setting: true, pixel: true },
  ])("adds the open-tracking image only when the workspace turned it on ($setting)", async ({ setting, pixel }) => {
    const row = { ...decisionRow, open_tracking_enabled: setting };
    const claimClient = {
      query: vi.fn(async (text: string) => text.includes("SELECT m.*") ? { rowCount: 1, rows: [row] } : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    const gateClient = () => ({
      query: vi.fn(async (text: string) => text.includes("AS already_replied") ? { rowCount: 1, rows: [safePreSendState] } : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    });
    const acceptedClient = {
      query: vi.fn(async (text: string) => text.includes("UPDATE messages SET status='accepted'") ? { rowCount: 1, rows: [{ id: "message" }] } : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(gateClient()).mockResolvedValueOnce(gateClient()).mockResolvedValueOnce(acceptedClient).mockResolvedValueOnce(gateClient()) };
    const composio = { enabled: true, createConnectLink: vi.fn(), getConnectedAccount: vi.fn(), ensureInboundMessageTrigger: vi.fn(), findSentMessage: vi.fn(), sendEmail: vi.fn().mockResolvedValue({ providerMessageId: "provider-tracking" }) };

    await expect(sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" })).resolves.toBeUndefined();

    const sent = composio.sendEmail.mock.calls[0]![0] as { html: string };
    if (pixel) expect(sent.html).toContain(`src="https://api.test/t/${decisionRow.tracking_token}.gif"`);
    else expect(sent.html).not.toContain("<img");
  });

  it("expires the mailbox, pauses its enrollments, and keeps an auth failure retryable", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 5, new ComposioRequestError(401, { error: "expired" }));

    const messageUpdate = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(messageUpdate?.values?.[1]).toBe("retryable");
    expect(messageUpdate?.values?.[2]).toBe("mailbox_authentication");
    expect(calls.some((call) => call.text.includes("UPDATE email_accounts SET status='expired'"))).toBe(true);
    expect(calls.some((call) => call.text.includes("stop_reason='mailbox_auth_expired'"))).toBe(true);
    expect(calls.some((call) => call.text.includes("mailbox_reconnect_required"))).toBe(true);
    expect(calls.some((call) => call.text.includes("status='cancelled'"))).toBe(false);
  });

  it("does not automatically retry ambiguous provider submission timeouts", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 1, new Error("socket timeout while waiting for provider"));

    const messageUpdate = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(messageUpdate?.values?.[1]).toBe("failed");
    expect(messageUpdate?.values?.[2]).toBe("unknown_provider_result");
    expect(calls.some((call) => call.text.includes("stop_reason='provider_result_unknown'"))).toBe(true);
  });

  it.each([421, 450, 454])("retries temporary AUTH %s without expiring the mailbox or pausing enrollments", async (responseCode) => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rowCount: 1, rows: text.includes("UPDATE messages SET status=$2") ? [{ id: "message" }] : [] };
      }),
    };
    await recordFailure(client as never, claimedMessage, 1, new SmtpSendError("SMTP authentication failed.", { stage: "auth", code: "EAUTH", responseCode }));
    expect(calls.find((call) => call.text.includes("UPDATE messages SET status=$2"))?.values?.slice(1, 3)).toEqual(["retryable", "provider_retryable"]);
    expect(calls.some((call) => call.text.includes("UPDATE email_accounts SET status='expired'"))).toBe(false);
    expect(calls.some((call) => call.text.includes("UPDATE enrollments SET status='paused'"))).toBe(false);
  });

  it("pauses a sequence once after three identical permanent provider failures", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        if (text.includes("SELECT count(*)::text AS count")) return { rowCount: 1, rows: [{ count: "3" }] };
        if (text.includes("UPDATE sequences SET status='paused'")) return { rowCount: 1, rows: [{ id: "sequence", name: "Outbound" }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 1, new ComposioRequestError(400, { error: { code: 1811, message: "Missing user_id" } }));

    expect(calls.some((call) => call.text.includes("failed_message.updated_at>=now()-interval '15 minutes'"))).toBe(true);
    expect(calls.some((call) => call.text.includes("SET status='paused',paused_at=now()"))).toBe(true);
    expect(calls.some((call) => call.text.includes("stop_reason='repeated_provider_failure'"))).toBe(true);
    expect(calls.filter((call) => call.text.includes("'sequence_auto_paused'")).length).toBe(1);
    expect(calls.some((call) => call.text.includes("provider_circuit"))).toBe(false);
  });

  it("pauses a sequence once after three identical sender-side SMTP MAIL FROM rejections on the same mailbox", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        if (text.includes("SELECT count(*)::text AS count")) return { rowCount: 1, rows: [{ count: "3" }] };
        if (text.includes("UPDATE sequences SET status='paused'")) return { rowCount: 1, rows: [{ id: "sequence", name: "Outbound" }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 1, new SmtpSendError("Daily sending quota exceeded.", { stage: "mail", responseCode: 550, command: "MAIL" }));

    const repeatedCall = calls.find((call) => call.text.includes("SELECT count(*)::text AS count"));
    expect(repeatedCall?.text).toContain("failed_message.email_account_id=$3");
    expect(repeatedCall?.values).toEqual([claimedMessage.sequence_id, "SMTP mail failed (550) [MAIL]", claimedMessage.email_account_id]);
    expect(calls.some((call) => call.text.includes("SET status='paused',paused_at=now()"))).toBe(true);
    expect(calls.some((call) => call.text.includes("stop_reason='repeated_provider_failure'"))).toBe(true);
    expect(calls.filter((call) => call.text.includes("'sequence_auto_paused'")).length).toBe(1);
  });

  it("pauses a sequence once after three identical SMTP DATA-stage rejections on the same mailbox", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        if (text.includes("SELECT count(*)::text AS count")) return { rowCount: 1, rows: [{ count: "3" }] };
        if (text.includes("UPDATE sequences SET status='paused'")) return { rowCount: 1, rows: [{ id: "sequence", name: "Outbound" }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 1, new SmtpSendError("Message content rejected.", { stage: "data", responseCode: 554, command: "DATA" }));

    expect(calls.some((call) => call.text.includes("SET status='paused',paused_at=now()"))).toBe(true);
    expect(calls.some((call) => call.text.includes("stop_reason='repeated_provider_failure'"))).toBe(true);
  });

  it("never trips the repeated-failure guard for RCPT-stage SMTP rejections; each cancels only its own lead", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        // Even if the count query were reached and returned a tripping count, the
        // RCPT branch must never issue it in the first place.
        if (text.includes("SELECT count(*)::text AS count")) return { rowCount: 1, rows: [{ count: "3" }] };
        if (text.includes("UPDATE sequences SET status='paused'")) return { rowCount: 1, rows: [{ id: "sequence", name: "Outbound" }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 1, new SmtpSendError("Recipient rejected.", { stage: "mail", responseCode: 550, command: "RCPT" }));

    const cancelCall = calls.find((call) => call.text.includes("UPDATE enrollments SET status='cancelled'"));
    expect(cancelCall?.values?.[1]).toBe("provider_permanent_failure");
    expect(calls.some((call) => call.text.includes("sequence-send-failure"))).toBe(false);
    expect(calls.some((call) => call.text.includes("SELECT count(*)::text AS count"))).toBe(false);
    expect(calls.some((call) => call.text.includes("SET status='paused',paused_at=now()"))).toBe(false);
    expect(calls.some((call) => call.text.includes("stop_reason='repeated_provider_failure'"))).toBe(false);
  });

  it("does not treat different SMTP response codes as identical failures for the repeated-failure guard", async () => {
    const paramsByCode = new Map<number, unknown[] | undefined>();

    for (const responseCode of [550, 553]) {
      const calls: Array<{ text: string; values?: unknown[] }> = [];
      const client = {
        query: vi.fn(async (text: string, values?: unknown[]) => {
          calls.push({ text, values });
          if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
          if (text.includes("SELECT count(*)::text AS count")) return { rowCount: 1, rows: [{ count: "1" }] };
          return { rowCount: 1, rows: [] };
        }),
      };
      await recordFailure(client as never, claimedMessage, 1, new SmtpSendError("Rejected.", { stage: "mail", responseCode, command: "MAIL" }));
      paramsByCode.set(responseCode, calls.find((call) => call.text.includes("SELECT count(*)::text AS count"))?.values);
    }

    expect(paramsByCode.get(550)?.[1]).toBe("SMTP mail failed (550) [MAIL]");
    expect(paramsByCode.get(553)?.[1]).toBe("SMTP mail failed (553) [MAIL]");
    expect(paramsByCode.get(550)?.[1]).not.toEqual(paramsByCode.get(553)?.[1]);
  });

  it("cancels a claimed follow-up when reply evidence appears before provider I/O", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [{ ...safePreSendState, already_replied: true }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await expect(preSendReplyCheck(client as never, claimedMessage, 2, false, { edition: "cloud" })).resolves.toBe(false);
    expect(calls.some((statement) => statement.includes("blocked_reason='already_replied'"))).toBe(true);
    expect(calls.some((statement) => statement.includes("status='replied'"))).toBe(true);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("checks the provider before a follow-up when webhook processing is delayed", async () => {
    const calls: string[] = [];
    const followUpDecision = { ...decisionRow, previous_provider_thread_id: "thread-1", previous_accepted_at: new Date("2026-09-01T09:00:00.000Z") };
    const claimClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [followUpDecision] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const preflightClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const replyClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const persistCalls: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(preflightClient).mockResolvedValueOnce(replyClient),
      query: vi.fn(async (text: string, values?: unknown[]) => { persistCalls.push({ text, values }); return { rowCount: 1, rows: [] }; }),
    };
    const composio = {
      enabled: true,
      createConnectLink: vi.fn(),
      getConnectedAccount: vi.fn(),
      ensureInboundMessageTrigger: vi.fn(),
      findSentMessage: vi.fn(),
      fetchReplies: vi.fn().mockResolvedValue([{
        providerMessageId: "reply-123",
        providerThreadId: "thread-1",
        subject: "Re: Hello",
        bodyText: "Sounds good",
        from: "lead@example.com",
        receivedAt: new Date("2026-09-01T10:00:00.000Z"),
      }]),
      sendEmail: vi.fn(),
    };

    await expect(sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" })).resolves.toBeUndefined();
    expect(composio.fetchReplies).toHaveBeenCalledWith(expect.objectContaining({ senderEmail: "lead@example.com", threadId: "thread-1" }));
    expect(persistCalls.some((call) => call.text.includes("INSERT INTO replies") && call.values?.includes("reply-123"))).toBe(true);
    expect(persistCalls.some((call) => call.text.includes("INSERT INTO message_events") && call.values?.some((value) => typeof value === "string" && value.startsWith("provider-reply:")))).toBe(true);
    expect(composio.sendEmail).not.toHaveBeenCalled();
    expect(calls.some((statement) => statement.includes("blocked_reason='already_replied'"))).toBe(true);
  });

  it("retries reply persistence before sending and saves the reply on the next attempt", async () => {
    const calls: string[] = [];
    const makeClaimClient = () => ({
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [{ ...decisionRow, previous_provider_thread_id: "thread-1", previous_accepted_at: new Date("2026-09-01T09:00:00.000Z") }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    });
    const makePreflightClient = () => ({
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    });
    const failureClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push(text);
        if (text.includes("UPDATE messages SET status=$2")) {
          expect(values?.[1]).toBe("retryable");
          return { rowCount: 1, rows: [{ id: "message" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const replyClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const persistCalls: string[] = [];
    const pool = {
      connect: vi.fn()
        .mockResolvedValueOnce(makeClaimClient())
        .mockResolvedValueOnce(makePreflightClient())
        .mockResolvedValueOnce(failureClient)
        .mockResolvedValueOnce(makeClaimClient())
        .mockResolvedValueOnce(makePreflightClient())
        .mockResolvedValueOnce(replyClient),
      query: vi.fn()
        .mockRejectedValueOnce(new Error("database connection temporarily unavailable"))
        .mockImplementation(async (text: string) => { persistCalls.push(text); return { rowCount: 1, rows: [] }; }),
    };
    const composio = {
      enabled: true,
      createConnectLink: vi.fn(),
      getConnectedAccount: vi.fn(),
      ensureInboundMessageTrigger: vi.fn(),
      findSentMessage: vi.fn(),
      fetchReplies: vi.fn().mockResolvedValue([{
        providerMessageId: "reply-retry-123",
        providerThreadId: "thread-1",
        bodyText: "Thanks",
        from: "lead@example.com",
        receivedAt: new Date("2026-09-01T10:00:00.000Z"),
      }]),
      sendEmail: vi.fn(),
    };
    const deps = { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" as const };

    await expect(sendMessage(payload, deps)).resolves.toBeUndefined();
    expect(composio.sendEmail).not.toHaveBeenCalled();
    expect(calls.some((text) => text.includes("UPDATE enrollments SET status='cancelled'"))).toBe(false);
    expect(calls.some((text) => text.includes("UPDATE messages SET status=$2") && text.includes("error_class=$3"))).toBe(true);

    await expect(sendMessage(payload, deps)).resolves.toBeUndefined();
    expect(composio.fetchReplies).toHaveBeenCalledTimes(2);
    expect(persistCalls).toEqual(expect.arrayContaining([expect.stringContaining("INSERT INTO replies"), expect.stringContaining("INSERT INTO message_events")]));
    expect(composio.sendEmail).not.toHaveBeenCalled();
    expect(calls.some((text) => text.includes("blocked_reason='already_replied'"))).toBe(true);
  });

  it("runs a final suppression gate after provider reply lookup and before sending", async () => {
    const calls: string[] = [];
    const followUpDecision = { ...decisionRow, previous_provider_thread_id: "thread-1", previous_accepted_at: new Date("2026-09-01T09:00:00.000Z") };
    const claimClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [followUpDecision] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const preflightClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const finalGateClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [{ ...safePreSendState, suppressed: true }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(preflightClient).mockResolvedValueOnce(finalGateClient) };
    const composio = {
      enabled: true,
      createConnectLink: vi.fn(),
      getConnectedAccount: vi.fn(),
      ensureInboundMessageTrigger: vi.fn(),
      findSentMessage: vi.fn(),
      fetchReplies: vi.fn().mockResolvedValue([]),
      sendEmail: vi.fn(),
    };

    await expect(sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" })).resolves.toBeUndefined();
    expect(composio.fetchReplies).toHaveBeenCalled();
    expect(composio.sendEmail).not.toHaveBeenCalled();
    expect(calls.some((statement) => statement.includes("blocked_reason=$3"))).toBe(true);
    expect(calls.some((statement) => statement.includes("status='unsubscribed'"))).toBe(true);
  });

  it("sends using the mailbox owner's Composio user id", async () => {
    const claimClient = {
      query: vi.fn(async (text: string) => text.includes("SELECT m.*") ? { rowCount: 1, rows: [decisionRow] } : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    const preflightClient = {
      query: vi.fn(async (text: string) => text.includes("AS already_replied")
        ? { rowCount: 1, rows: [safePreSendState] }
        : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    const acceptedClient = {
      query: vi.fn(async (text: string) => text.includes("UPDATE messages SET status='accepted'")
        ? { rowCount: 1, rows: [{ id: "message" }] }
        : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    const finalGateClient = {
      query: vi.fn(async (text: string) => text.includes("AS already_replied")
        ? { rowCount: 1, rows: [safePreSendState] }
        : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };
    const bookkeepingClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes("SELECT metadata FROM messages")) return { rowCount: 1, rows: [{ metadata: {} }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(preflightClient).mockResolvedValueOnce(finalGateClient).mockResolvedValueOnce(acceptedClient).mockResolvedValueOnce(bookkeepingClient) };
    const composio = { enabled: true, createConnectLink: vi.fn(), getConnectedAccount: vi.fn(), ensureInboundMessageTrigger: vi.fn(), findSentMessage: vi.fn(), sendEmail: vi.fn().mockResolvedValue({}) };

    await sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" });

    expect(composio.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ userId: "mailbox-user", connectedAccountId: "connected" }));
  });
});

  it("allows a staggered claim when the mailbox last sent 40 seconds ago", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [decisionRow] };
        if (text.includes("SELECT GREATEST(")) return { rowCount: 1, rows: [{ last_send_at: new Date("2026-09-01T11:59:20.000Z") }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await expect(claimMessage(client as never, payload, { edition: "cloud" })).resolves.toMatchObject({ attemptNumber: 1 });

    expect(calls.some((call) => call.text.includes("INSERT INTO send_attempts"))).toBe(true);
    expect(calls.some((call) => call.text.includes("blocked_reason='mailbox_min_gap'"))).toBe(false);
  });

  const claimWith = async (edition: "cloud" | "selfhost", row: Record<string, unknown>) => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        // Earlier claims reassign decisionRow.metadata, so start from a never-attempted message.
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [{ ...decisionRow, metadata: { bodyText: "Hello", unsubscribeUrl: "https://api.test/u" }, ...row }] };
        if (text.includes("SELECT GREATEST(")) return { rowCount: 1, rows: [{ last_send_at: null }] };
        return { rowCount: 1, rows: [] };
      }),
    };
    return { result: await claimMessage(client as never, payload, { edition }), calls };
  };

  it.each([
    ["a licensed cloud workspace", "cloud", { subscription_status: "active", legacy_free_until: null }, false, "<message@messages.inboxjoy.online>"],
    ["legacy Free", "cloud", { subscription_status: null, legacy_free_until: new Date("2026-09-20T00:00:00.000Z") }, true, "<message@messages.inboxjoy.online>"],
    ["a self-hosted workspace with no subscription", "selfhost", { subscription_status: null, legacy_free_until: null }, false, "<message@example.com>"],
    ["a self-hosted workspace with a stale legacy window", "selfhost", { subscription_status: null, legacy_free_until: new Date("2026-09-20T00:00:00.000Z") }, false, "<message@example.com>"],
  ] as const)("sets the footer and Message-ID at claim time for %s", async (_label, edition, row, sentVia, rfcMessageId) => {
    const { result, calls } = await claimWith(edition, row);

    expect(result.message?.sent_via).toBe(sentVia);
    expect(result.message?.metadata?.providerRfcMessageId).toBe(rfcMessageId);
    expect(calls.find((call) => call.text.includes("SELECT m.*"))?.text).toContain("w.legacy_free_until");
  });

  it("blocks an unlicensed cloud claim with payment_required and no send attempt", async () => {
    const { result, calls } = await claimWith("cloud", { subscription_status: null, legacy_free_until: null });

    expect(result).toMatchObject({ deniedReason: "payment_required" });
    const denial = calls.find((call) => call.text.includes("blocked_reason=$3"));
    // Rechecked in 6 hours (PAYMENT_REQUIRED_RETRY_MS), the same retry the scheduler writes.
    expect(denial?.values?.slice(1, 4)).toEqual(["scheduled", "payment_required", new Date("2026-09-01T18:00:00.000Z")]);
    expect(calls.some((call) => call.text.includes("INSERT INTO send_attempts"))).toBe(false);
  });

  it("reuses the Message-ID an earlier attempt sent with", async () => {
    const { result } = await claimWith("selfhost", { metadata: { ...claimedMessage.metadata, providerRfcMessageId: "<message@messages.inboxjoy.online>" } });

    expect(result.message?.metadata?.providerRfcMessageId).toBe("<message@messages.inboxjoy.online>");
  });

  it("defers an overdue claim to exactly the deterministic floor when the mailbox sent 10 seconds ago", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [decisionRow] };
        if (text.includes("SELECT GREATEST(")) return { rowCount: 1, rows: [{ last_send_at: new Date("2026-09-01T11:59:50.000Z") }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await expect(claimMessage(client as never, payload, { edition: "cloud" })).resolves.toMatchObject({ deniedReason: "mailbox_min_gap" });

    const defer = calls.find((call) => call.text.includes("blocked_reason='mailbox_min_gap'"));
    expect(defer?.values?.[1]).toBeInstanceOf(Date);
    expect(defer?.values?.[1]).toEqual(new Date("2026-09-01T12:00:20.000Z"));
    const lastSendLookup = calls.find((call) => call.text.includes("SELECT GREATEST("));
    expect(lastSendLookup?.text).toContain("manual_reply_event.workspace_id=$2");
    expect(lastSendLookup?.values).toEqual([claimedMessage.email_account_id, payload.workspaceId]);
    expect(calls.some((call) => call.text.includes("INSERT INTO send_attempts"))).toBe(false);
  });

  it.each([
    { attemptNumber: 4, expectedStatus: "retryable", cancelled: false },
    { attemptNumber: 5, expectedStatus: "failed", cancelled: true },
  ])("caps transient pre-send retries at five attempts", async ({ attemptNumber, expectedStatus, cancelled }) => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, attemptNumber, new Error("reply lookup temporarily unavailable"), false);

    const update = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(update?.values?.[1]).toBe(expectedStatus);
    expect(update?.values?.[2]).toBe("reply_check_failed");
    expect(calls.some((call) => call.text.includes("status='cancelled'") && call.text.includes("enrollments"))).toBe(cancelled);
    expect(calls.some((call) => call.text.includes("INSERT INTO mailbox_health"))).toBe(false);
    expect(calls.some((call) => call.text.includes("provider-circuit:"))).toBe(false);
  });

  it.each([
    { attemptNumber: 1, expectedStatus: "retryable", cancelled: false },
    { attemptNumber: 4, expectedStatus: "retryable", cancelled: false },
    { attemptNumber: 5, expectedStatus: "failed", cancelled: true },
  ])("retries a one-off IMAP reply-lookup failure instead of cancelling the enrollment on the first attempt, only giving up after five (attempt $attemptNumber)", async ({ attemptNumber, expectedStatus, cancelled }) => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, attemptNumber, new ImapError("IMAP reply lookup failed.", { stage: "search" }), false);

    const update = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(update?.values?.[1]).toBe(expectedStatus);
    const cancellation = calls.find((call) => call.text.includes("status='cancelled'") && call.text.includes("enrollments"));
    expect(cancellation !== undefined).toBe(cancelled);
    if (cancellation) expect(cancellation.values).toContain("pre_send_retry_exhausted");
    expect(calls.some((call) => call.text.includes("status='expired'") && call.text.includes("email_accounts"))).toBe(false);
    expect(calls.some((call) => call.text.includes("mailbox_auth_expired"))).toBe(false);
  });

  it("pauses the mailbox and enrollments (not a plain retry or cancellation) when the IMAP reply lookup fails because the mailbox's own credentials are rejected", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordFailure(client as never, claimedMessage, 1, new ImapError("IMAP reply lookup failed.", { stage: "auth" }), false);

    const update = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(update?.values?.[1]).toBe("retryable");
    expect(calls.some((call) => call.text.includes("status='cancelled'") && call.text.includes("enrollments"))).toBe(false);
    expect(calls.some((call) => call.text.includes("status='expired'") && call.text.includes("email_accounts"))).toBe(true);
    expect(calls.some((call) => call.text.includes("stop_reason='mailbox_auth_expired'"))).toBe(true);
  });

  it.each([
    ["legacy Free at its monthly cap", { legacy_free_until: new Date("2026-09-20T00:00:00.000Z"), workspace_month: String(FREE_PLAN_MONTHLY_SEND_LIMIT) }, "free_monthly_cap", new Date("2026-09-20T00:00:00.000Z")],
    ["an unlicensed workspace", { legacy_free_until: null, workspace_month: "0" }, "payment_required", new Date("2026-09-01T18:00:00.000Z")],
    ["a legacy Free window that has ended", { legacy_free_until: new Date("2026-08-01T00:00:00.000Z"), workspace_month: "0" }, "payment_required", new Date("2026-09-01T18:00:00.000Z")],
  ])("rechecks the plan in the final pre-provider gate for %s", async (_label, plan, reason, retryAt) => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const expiredTrial = {
      ...safePreSendState,
      gate_now: new Date("2026-09-01T12:00:00.000Z"),
      subscription_status: "trialing",
      subscription_trial_end: new Date("2026-09-01T11:59:00.000Z"),
      ...plan,
    };
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [expiredTrial] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await expect(preSendReplyCheck(client as never, claimedMessage, 2, false, { edition: "cloud" })).resolves.toBe(false);

    const gate = calls.find((call) => call.text.includes("AS already_replied"))!.text;
    expect(gate).toContain("sub.status::text AS subscription_status");
    expect(gate).toContain("AS workspace_month");
    expect(gate).toContain("w.legacy_free_until");
    expect(calls.find((call) => call.text.includes("blocked_reason=$3"))?.values?.[2]).toBe(reason);
    expect(calls.find((call) => call.text.includes("blocked_reason=$3"))?.values?.[3]).toEqual(retryAt);

    // Self-host never applies the plan gate.
    calls.length = 0;
    await expect(preSendReplyCheck(client as never, claimedMessage, 2, false, { edition: "selfhost" })).resolves.toBe(true);
    expect(calls.some((call) => call.text.includes("blocked_reason=$3"))).toBe(false);
  });

  it.each(["tracking token", "unsubscribe URL", "rendered body"])("records missing %s as a permanent preparation failure", async (missingField) => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const row = missingField === "tracking token"
      ? { ...decisionRow, tracking_token: undefined }
      : missingField === "unsubscribe URL"
        ? { ...decisionRow, metadata: { bodyText: "Hello" } }
        : { ...decisionRow, metadata: { bodyText: "   ", unsubscribeUrl: "https://api.test/u" } };
    const claimClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("SELECT m.*")) return { rowCount: 1, rows: [row] };
        if (text.includes("SELECT GREATEST(")) return { rowCount: 1, rows: [{ last_send_at: null }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const gateClient = () => ({
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    });
    const failureClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn()
      .mockResolvedValueOnce(claimClient)
      .mockResolvedValueOnce(gateClient())
      .mockResolvedValueOnce(gateClient())
      .mockResolvedValueOnce(failureClient) };
    const composio = { enabled: true, createConnectLink: vi.fn(), getConnectedAccount: vi.fn(), ensureInboundMessageTrigger: vi.fn(), findSentMessage: vi.fn(), sendEmail: vi.fn() };

    await expect(sendMessage(payload, { pool: pool as never, composio: composio as never, apiBaseUrl: "https://api.test", authSecret: "secret", edition: "cloud" })).resolves.toBeUndefined();

    const failure = calls.find((call) => call.text.includes("UPDATE messages SET status=$2"));
    expect(failure?.values?.[1]).toBe("failed");
    expect(failure?.values?.[2]).toBe("preparation_failed");
    expect(calls.some((call) => call.text.includes("status='cancelled'") && call.text.includes("enrollments"))).toBe(true);
    expect(calls.some((call) => call.text.includes("INSERT INTO mailbox_health"))).toBe(false);
    expect(composio.sendEmail).not.toHaveBeenCalled();
  });
