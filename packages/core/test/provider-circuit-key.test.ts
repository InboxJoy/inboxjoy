import { describe, expect, it } from "vitest";

import { providerCircuitKey, providerCircuitKeySql } from "../src/index.js";

describe("provider circuit keys", () => {
  it("builds the exact per-mailbox SMTP SQL key", () => {
    expect(providerCircuitKeySql("ea")).toBe("CASE WHEN ea.provider = 'smtp' THEN 'smtp:' || ea.id::text ELSE ea.provider::text END");
  });

  it("preserves managed-provider keys", () => {
    expect(providerCircuitKey("gmail", "mailbox-id")).toBe("gmail");
    expect(providerCircuitKey("outlook", "mailbox-id")).toBe("outlook");
  });

  it("isolates SMTP circuits by mailbox", () => {
    expect(providerCircuitKey("smtp", "mailbox-id")).toBe("smtp:mailbox-id");
    expect(providerCircuitKey("smtp", "another-mailbox")).toBe("smtp:another-mailbox");
  });
});
