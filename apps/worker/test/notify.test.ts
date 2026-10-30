import { describe, expect, it, vi } from "vitest";

import { mailboxAlertReasonSentence, NON_SENDING_HEALTH_STATES, notifyCampaignCompleted, notifyMailboxAlert, notifyReplyReceived } from "../src/notify.js";

function ownerRow(email = "owner@example.com", name: string | null = "Owner") {
  return { rows: [{ email, display_name: name }] };
}

describe("campaign completion email throttle", () => {
  it.each([null, new Date(Date.now() - 2 * 86_400_000)])("emails the first finish or a finish more than 24 hours later", async (previousCompletedAt) => {
    const pool = { query: vi.fn().mockResolvedValueOnce(ownerRow()).mockResolvedValueOnce({ rows: [{ sent: "4", opened: "2", replied: "1" }] }) };
    const sendCampaignCompleted = vi.fn().mockResolvedValue(undefined);
    await notifyCampaignCompleted({ pool, transactionalEmail: { enabled: true, sendCampaignCompleted } as never }, { workspaceId: "workspace", campaignId: "campaign", campaignName: "Outbound", previousCompletedAt });
    expect(sendCampaignCompleted).toHaveBeenCalledTimes(1);
  });

  it("does not email a campaign that finished in the last 24 hours", async () => {
    const pool = { query: vi.fn() };
    const sendCampaignCompleted = vi.fn();
    await notifyCampaignCompleted({ pool, transactionalEmail: { enabled: true, sendCampaignCompleted } as never }, { workspaceId: "workspace", campaignId: "campaign", campaignName: "Outbound", previousCompletedAt: new Date() });
    expect(pool.query).not.toHaveBeenCalled();
    expect(sendCampaignCompleted).not.toHaveBeenCalled();
  });

  it("waits until strictly more than 24 hours have elapsed", async () => {
    const now = new Date("2026-10-02T10:00:00.000Z").getTime();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const pool = { query: vi.fn() };
    try {
      await notifyCampaignCompleted({ pool, transactionalEmail: { enabled: true } as never }, { workspaceId: "workspace", campaignId: "campaign", campaignName: "Outbound", previousCompletedAt: new Date(now - 86_400_000) });
      expect(pool.query).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe("mailboxAlertReasonSentence", () => {
  it("maps the documented mailbox health states to their reason sentence", () => {
    expect(mailboxAlertReasonSentence("disconnected")).toBe("The connection to this mailbox expired.");
    expect(mailboxAlertReasonSentence("auth_error")).toBe("The connection to this mailbox expired.");
    expect(mailboxAlertReasonSentence("throttled")).toBe("Too many delivery failures, so sending was paused to protect your reputation.");
    expect(mailboxAlertReasonSentence("quota_exceeded")).toBe("The provider's sending quota for this mailbox was reached.");
    expect(mailboxAlertReasonSentence("reputation_warning")).toBe("Delivery problems suggest this mailbox needs attention.");
  });

  it("falls back to a generic sentence for other non-sending states", () => {
    expect(mailboxAlertReasonSentence("critical")).toBe("This mailbox is not currently able to send.");
    expect(mailboxAlertReasonSentence("paused")).toBe("This mailbox is not currently able to send.");
    expect(mailboxAlertReasonSentence("some_future_state")).toBe("This mailbox is not currently able to send.");
  });

  it("keeps NON_SENDING_HEALTH_STATES in sync with the states canSend treats as blocking", () => {
    expect([...NON_SENDING_HEALTH_STATES].sort()).toEqual(
      ["auth_error", "critical", "disconnected", "paused", "quota_exceeded", "reputation_warning", "throttled"].sort(),
    );
    expect(NON_SENDING_HEALTH_STATES.has("healthy")).toBe(false);
    expect(NON_SENDING_HEALTH_STATES.has("degraded")).toBe(false);
  });
});

describe("notifyMailboxAlert", () => {
  it("does nothing when transactional email is disabled", async () => {
    const pool = { query: vi.fn() };
    await notifyMailboxAlert({ pool, transactionalEmail: { enabled: false } as never }, { workspaceId: "w1", mailboxEmail: "a@b.com", state: "auth_error" });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("looks up the workspace owner and sends with the mapped reason sentence", async () => {
    const pool = { query: vi.fn().mockResolvedValue(ownerRow()) };
    const sendMailboxAlert = vi.fn().mockResolvedValue(undefined);
    await notifyMailboxAlert({ pool, transactionalEmail: { enabled: true, sendMailboxAlert } as never }, { workspaceId: "w1", mailboxEmail: "sender@example.com", state: "throttled" });
    expect(sendMailboxAlert).toHaveBeenCalledWith({
      recipient: { email: "owner@example.com", name: "Owner" },
      mailboxEmail: "sender@example.com",
      reasonSentence: "Too many delivery failures, so sending was paused to protect your reputation.",
    });
  });

  it("is best-effort: a send failure never throws", async () => {
    const pool = { query: vi.fn().mockResolvedValue(ownerRow()) };
    const sendMailboxAlert = vi.fn().mockRejectedValue(new Error("provider down"));
    await expect(
      notifyMailboxAlert({ pool, transactionalEmail: { enabled: true, sendMailboxAlert } as never }, { workspaceId: "w1", mailboxEmail: "a@b.com", state: "auth_error" }),
    ).resolves.toBeUndefined();
  });

  it("skips silently when the workspace has no active owner", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const sendMailboxAlert = vi.fn();
    await notifyMailboxAlert({ pool, transactionalEmail: { enabled: true, sendMailboxAlert } as never }, { workspaceId: "w1", mailboxEmail: "a@b.com", state: "auth_error" });
    expect(sendMailboxAlert).not.toHaveBeenCalled();
  });
});

describe("notifyReplyReceived", () => {
  it("skips when the enrollment has no campaign (nothing to link the email to)", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ workspace_id: "w1", campaign_id: null, campaign_name: null, contact_first_name: null, contact_last_name: null, contact_email: "lead@example.com", mailbox_email: "sender@example.com" }] }) };
    const sendReplyReceived = vi.fn();
    await notifyReplyReceived({ pool, transactionalEmail: { enabled: true, sendReplyReceived } as never }, "enrollment-1");
    expect(sendReplyReceived).not.toHaveBeenCalled();
  });

  it("labels the contact by full name when known, else falls back to the email", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ workspace_id: "w1", campaign_id: "c1", campaign_name: "Outbound", contact_first_name: "Ada", contact_last_name: "Lovelace", contact_email: "ada@example.com", mailbox_email: "sender@example.com" }] })
        .mockResolvedValueOnce(ownerRow()),
    };
    const sendReplyReceived = vi.fn().mockResolvedValue(undefined);
    await notifyReplyReceived({ pool, transactionalEmail: { enabled: true, sendReplyReceived } as never }, "enrollment-1");
    expect(sendReplyReceived).toHaveBeenCalledWith(expect.objectContaining({ contactLabel: "Ada Lovelace", campaignId: "c1", campaignName: "Outbound", mailboxEmail: "sender@example.com" }));
  });

  it("falls back to the contact email when no name is on file", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ workspace_id: "w1", campaign_id: "c1", campaign_name: "Outbound", contact_first_name: null, contact_last_name: null, contact_email: "lead@example.com", mailbox_email: "sender@example.com" }] })
        .mockResolvedValueOnce(ownerRow()),
    };
    const sendReplyReceived = vi.fn().mockResolvedValue(undefined);
    await notifyReplyReceived({ pool, transactionalEmail: { enabled: true, sendReplyReceived } as never }, "enrollment-1");
    expect(sendReplyReceived).toHaveBeenCalledWith(expect.objectContaining({ contactLabel: "lead@example.com" }));
  });
});
