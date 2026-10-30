import { describe, expect, it, vi } from "vitest";
import { ComposioRequestError } from "@inboxjoy/composio";

import { preSendReplyCheck, recordFailure } from "../src/jobs/send-message.js";

function ownerRow(email = "owner@example.com", name: string | null = "Owner") {
  return { rows: [{ email, display_name: name }] };
}

const claimedMessage = {
  id: "message", workspace_id: "workspace-1", enrollment_id: "enrollment-1", sequence_id: "sequence", sequence_step_id: "step",
  email_account_id: "inbox", contact_id: "contact", recipient_email: "lead@example.com", normalized_recipient_email: "lead@example.com",
  subject: "Hello", tracking_token: "0123456789abcdef0123456789abcdef", metadata: null, provider: "gmail" as const,
  composio_connected_account_id: "connected", daily_limit: 50, hourly_limit: 10, ramp_started_on: null, ramp_paused_days: 0, workspace_daily_cap: 100,
  mailbox_user_id: "mailbox-user", campaign_id: "campaign-1", postal_address: "123 Main St", mailbox_email: "sender@example.com",
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
  workspace_today: "0",
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

describe("mailbox alert: transition-only dedupe (recordFailure -> updateMailboxHealthForFailure)", () => {
  function mockClient(currentHealthState: string) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        query: vi.fn(async (text: string) => {
          calls.push(text);
          if (text.includes("UPDATE messages SET status=$2")) return { rowCount: 1, rows: [{ id: "message" }] };
          if (text.includes("SELECT state,effective_daily_limit,consecutive_failures,temp_failures_24h")) {
            return { rowCount: 1, rows: [{ state: currentHealthState, effective_daily_limit: 50, consecutive_failures: 0, temp_failures_24h: 0, perm_failures_24h: 0, throttled_until: null }] };
          }
          if (text.includes("FROM memberships m JOIN users u")) return ownerRow();
          return { rowCount: 1, rows: [] };
        }),
      },
    };
  }

  it("sends the alert the moment a healthy mailbox fails auth (a genuine transition)", async () => {
    const { client } = mockClient("healthy");
    const sendMailboxAlert = vi.fn().mockResolvedValue(undefined);

    await recordFailure(client as never, claimedMessage, 5, new ComposioRequestError(401, { error: "expired" }), true, {
      transactionalEmail: { enabled: true, sendMailboxAlert } as never,
    });

    expect(sendMailboxAlert).toHaveBeenCalledTimes(1);
    expect(sendMailboxAlert).toHaveBeenCalledWith(expect.objectContaining({ mailboxEmail: "sender@example.com" }));
  });

  it("does not re-send while the mailbox stays in the same non-sending state", async () => {
    const { client } = mockClient("auth_error");
    const sendMailboxAlert = vi.fn();

    await recordFailure(client as never, claimedMessage, 5, new ComposioRequestError(401, { error: "expired" }), true, {
      transactionalEmail: { enabled: true, sendMailboxAlert } as never,
    });

    expect(sendMailboxAlert).not.toHaveBeenCalled();
  });

  it("skips the alert entirely when transactional email is not configured", async () => {
    const { client } = mockClient("healthy");

    await expect(recordFailure(client as never, claimedMessage, 5, new ComposioRequestError(401, { error: "expired" }))).resolves.toBeUndefined();
  });
});

describe("reply received: at-most-once per enrollment (preSendReplyCheck)", () => {
  it("sends when the enrollment transitions to replied for the first time", async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        if (text.includes("SET status='replied'") && text.includes("RETURNING id")) return { rowCount: 1, rows: [{ id: claimedMessage.enrollment_id }] };
        if (text.includes("FROM enrollments e") && text.includes("JOIN contacts c")) {
          return { rows: [{ workspace_id: "workspace-1", campaign_id: "campaign-1", campaign_name: "Outbound", contact_first_name: null, contact_last_name: null, contact_email: "lead@example.com", mailbox_email: "sender@example.com" }] };
        }
        if (text.includes("FROM memberships m JOIN users u")) return ownerRow();
        return { rowCount: 1, rows: [] };
      }),
    };
    const sendReplyReceived = vi.fn().mockResolvedValue(undefined);

    const allowed = await preSendReplyCheck(client as never, claimedMessage, 2, true, { edition: "cloud", transactionalEmail: { enabled: true, sendReplyReceived } as never });

    expect(allowed).toBe(false);
    expect(sendReplyReceived).toHaveBeenCalledTimes(1);
  });

  it("does not send again once the enrollment is already replied", async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        // Excluding 'replied' from the target status list means a repeat run (the
        // enrollment already replied) matches zero rows here -- the dedupe signal.
        if (text.includes("SET status='replied'") && text.includes("RETURNING id")) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
    };
    const sendReplyReceived = vi.fn();

    const allowed = await preSendReplyCheck(client as never, claimedMessage, 2, true, { edition: "cloud", transactionalEmail: { enabled: true, sendReplyReceived } as never });

    expect(allowed).toBe(false);
    expect(sendReplyReceived).not.toHaveBeenCalled();
  });

  it("skips sending entirely when transactional email is not configured", async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("AS already_replied")) return { rowCount: 1, rows: [safePreSendState] };
        if (text.includes("SET status='replied'") && text.includes("RETURNING id")) return { rowCount: 1, rows: [{ id: claimedMessage.enrollment_id }] };
        return { rowCount: 1, rows: [] };
      }),
    };

    await expect(preSendReplyCheck(client as never, claimedMessage, 2, true, { edition: "cloud" })).resolves.toBe(false);
  });
});
