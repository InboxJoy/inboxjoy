import { describe, expect, it } from "vitest";
import { normalizeRefCode } from "../lib/affiliate-ref";

describe("normalizeRefCode", () => {
  it("trims and lowercases a valid code", () => {
    expect(normalizeRefCode("  AbC123  ")).toBe("abc123");
  });

  it("accepts the minimum length of 4", () => {
    expect(normalizeRefCode("ab12")).toBe("ab12");
  });

  it("accepts the maximum length of 32", () => {
    const code = "a".repeat(32);
    expect(normalizeRefCode(code)).toBe(code);
  });

  it("rejects codes shorter than 4 characters", () => {
    expect(normalizeRefCode("ab1")).toBeNull();
  });

  it("rejects codes longer than 32 characters", () => {
    expect(normalizeRefCode("a".repeat(33))).toBeNull();
  });

  it("rejects codes with symbols or spaces", () => {
    expect(normalizeRefCode("abc-123")).toBeNull();
    expect(normalizeRefCode("abc 123")).toBeNull();
    expect(normalizeRefCode("abc_123")).toBeNull();
  });

  it("rejects empty, null, or undefined input", () => {
    expect(normalizeRefCode("")).toBeNull();
    expect(normalizeRefCode(null)).toBeNull();
    expect(normalizeRefCode(undefined)).toBeNull();
  });
});
