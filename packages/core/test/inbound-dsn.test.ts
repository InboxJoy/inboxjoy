import { describe, expect, it } from "vitest";
import { classifyDeliveryStatusBounce, isPermanentBounce } from "../src/inbound/classify.js";

describe("normalized DSN classification", () => {
  it.each(["5.1.1", "5.2.2", "5.7.8"])("treats failed %s as permanent regardless of generic classifier exceptions", (status) => {
    const classification = classifyDeliveryStatusBounce({ recipient: "lead@example.com", action: "failed", status });
    expect(classification).toBe("hard_bounce");
    expect(isPermanentBounce(classification!)).toBe(true);
  });

  it.each(["failed", "delayed"])("treats %s 4.2.2 as temporary, never suppressible", (action) => {
    const classification = classifyDeliveryStatusBounce({ recipient: "lead@example.com", action, status: "4.2.2" });
    expect(classification).toBe("temporary_provider_error");
    expect(isPermanentBounce(classification!)).toBe(false);
  });

  it.each([["delivered", "2.0.0"], ["delayed", "5.1.1"], ["failed", "invalid"]])("ignores action %s with status %s", (action, status) => {
    expect(classifyDeliveryStatusBounce({ recipient: "lead@example.com", action, status })).toBeUndefined();
  });
});
