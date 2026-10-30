import { describe, expect, it } from "vitest";
import {
  buildMessageIdempotencyKey,
  canTransitionEnrollment,
  canTransitionMailbox,
  canTransitionMessage,
  canTransitionSequence,
  nextEnrollmentStopState,
  normalizeEmail,
} from "../src/index.js";

describe("domain state rules", () => {
  it("allows launch/pause/archive sequence transitions", () => {
    expect(canTransitionSequence("draft", "active")).toBe(true);
    expect(canTransitionSequence("paused", "active")).toBe(true);
    expect(canTransitionSequence("archived", "active")).toBe(false);
  });

  it("makes reply, bounce, and unsubscribe terminal for enrollments", () => {
    expect(canTransitionEnrollment("active", "replied")).toBe(true);
    expect(canTransitionEnrollment("replied", "active")).toBe(false);
    expect(nextEnrollmentStopState("unsubscribe")).toBe("unsubscribed");
  });

  it("keeps accepted messages terminal", () => {
    expect(canTransitionMessage("scheduled", "claimed")).toBe(true);
    expect(canTransitionMessage("accepted", "retryable")).toBe(false);
  });

  it("allows expired mailboxes to reconnect but not silently send", () => {
    expect(canTransitionMailbox("expired", "active")).toBe(true);
    expect(canTransitionMailbox("expired", "paused")).toBe(false);
  });

  it("normalizes email and creates stable send keys", () => {
    expect(normalizeEmail("  Founder@Example.COM ")).toBe("founder@example.com");
    expect(buildMessageIdempotencyKey({ enrollmentId: "e1", sequenceStepId: "s1" })).toBe("e1:s1:sequence");
  });
});
