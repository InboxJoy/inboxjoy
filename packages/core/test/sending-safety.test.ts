import { describe, expect, it } from "vitest";

import { followUpSendJitterMs, initialSendJitterMs } from "../src/index.js";

describe("sending safety helpers", () => {
  it("deterministically spreads initial sends across a ninety-minute window", () => {
    const first = initialSendJitterMs("enrollment-one");
    const second = initialSendJitterMs("enrollment-two");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(90 * 60_000);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThanOrEqual(90 * 60_000);
    expect(second).not.toBe(first);
    expect(initialSendJitterMs("enrollment-one")).toBe(first);
  });

  it("deterministically spreads follow-ups without matching initial-send offsets", () => {
    const followUp = followUpSendJitterMs("enrollment-one:2");
    expect(followUp).toBeGreaterThanOrEqual(0);
    expect(followUp).toBeLessThanOrEqual(90 * 60_000);
    expect(followUpSendJitterMs("enrollment-one:2")).toBe(followUp);
    expect(followUp).not.toBe(initialSendJitterMs("enrollment-one:2"));
  });
});
