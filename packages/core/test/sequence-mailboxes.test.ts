import { describe, expect, it } from "vitest";

import { isSendableSequenceMailbox } from "../src/sequence-mailboxes.js";

describe("sequence mailbox assignment eligibility", () => {
  it.each([null, "healthy"])("allows an active addressed mailbox with %s health", (healthState) => {
    expect(isSendableSequenceMailbox({ status: "active", email: "sender@example.com", healthState })).toBe(true);
  });

  it.each(["connecting", "paused", "expired", "error", "disconnected"])("does not assign a %s mailbox", (status) => {
    expect(isSendableSequenceMailbox({ status, email: "sender@example.com", healthState: "healthy" })).toBe(false);
  });

  it("does not assign a mailbox without a resolved address", () => {
    expect(isSendableSequenceMailbox({ status: "active", email: null, healthState: "healthy" })).toBe(false);
  });

  it.each(["degraded", "critical", "throttled", "auth_error", "quota_exceeded", "reputation_warning", "paused", "disconnected"])("does not assign a mailbox with %s health", (healthState) => {
    expect(isSendableSequenceMailbox({ status: "active", email: "sender@example.com", healthState })).toBe(false);
  });
});
