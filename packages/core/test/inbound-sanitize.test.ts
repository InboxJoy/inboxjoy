import { describe, expect, it } from "vitest";

import { sanitizeStoredString, sanitizeStoredStrings } from "../src/inbound/sanitize.js";

// Postgres refuses U+0000 in text and jsonb, and an unpaired surrogate in jsonb.
// One such message used to fail on every IMAP poll and block the mailbox.
describe("inbound payload sanitizer", () => {
  it("strips NUL characters", () => {
    expect(sanitizeStoredString("Re:\u0000 Intro\u0000")).toBe("Re: Intro");
    expect(sanitizeStoredString("\u0000")).toBe("");
  });

  it("replaces a lone high surrogate", () => {
    expect(sanitizeStoredString("broken \uD83D emoji")).toBe("broken � emoji");
    expect(sanitizeStoredString("trailing \uD83D")).toBe("trailing �");
  });

  it("replaces a lone low surrogate", () => {
    expect(sanitizeStoredString("broken \uDE00 emoji")).toBe("broken � emoji");
    expect(sanitizeStoredString("\uDE00 leading")).toBe("� leading");
  });

  it("preserves valid surrogate pairs", () => {
    expect(sanitizeStoredString("thanks 😀!")).toBe("thanks 😀!");
    expect(sanitizeStoredString("😀👍🏽")).toBe("😀👍🏽");
  });

  it("repairs only the unpaired half of a mixed run", () => {
    expect(sanitizeStoredString("\uD83D😀")).toBe("�😀");
    expect(sanitizeStoredString("😀\uDE00")).toBe("😀�");
    expect(sanitizeStoredString("\uDE00\uD83D")).toBe("��");
    // A NUL between two halves does not pair them up once it is removed.
    expect(sanitizeStoredString("\uD83D\u0000\uDE00")).toBe("��");
  });

  it("leaves ordinary text untouched", () => {
    const text = "Yes, let's talk next week.\r\n\tÀ bientôt — 你好";
    expect(sanitizeStoredString(text)).toBe(text);
  });

  it("sanitizes nested objects and arrays, including keys", () => {
    const receivedAt = new Date("2026-10-01T00:00:00.000Z");
    const input = {
      data: {
        subject: "Re:\u0000 Intro",
        message_text: "unsubscribe \uD83D",
        to: ["lead\u0000@example.com", "ok@example.com"],
        payload: { headers: [{ name: "subject", value: "\uDE00Re: Intro" }, { name: "x-count", value: 3 }] },
        "bad\u0000key": "value",
      },
      bounce: [{ recipient: "lead@example.com\u0000", action: "failed", status: "5.1.1" }],
      attempts: 2,
      delivered: false,
      missing: null,
      absent: undefined,
      receivedAt,
    };

    expect(sanitizeStoredStrings(input)).toEqual({
      data: {
        subject: "Re: Intro",
        message_text: "unsubscribe �",
        to: ["lead@example.com", "ok@example.com"],
        payload: { headers: [{ name: "subject", value: "�Re: Intro" }, { name: "x-count", value: 3 }] },
        badkey: "value",
      },
      bounce: [{ recipient: "lead@example.com", action: "failed", status: "5.1.1" }],
      attempts: 2,
      delivered: false,
      missing: null,
      absent: undefined,
      receivedAt,
    });
    expect(sanitizeStoredStrings(input).receivedAt).toBe(receivedAt);
  });

  it("returns non-string scalars and undefined unchanged, and does not mutate its input", () => {
    expect(sanitizeStoredStrings(undefined)).toBeUndefined();
    expect(sanitizeStoredStrings(null)).toBeNull();
    expect(sanitizeStoredStrings(42)).toBe(42);
    const input = { subject: "a\u0000b", nested: ["c\u0000d"] };
    sanitizeStoredStrings(input);
    expect(input).toEqual({ subject: "a\u0000b", nested: ["c\u0000d"] });
  });

  it("produces output Postgres jsonb accepts: no NUL and no unpaired escape", () => {
    const serialized = JSON.stringify(sanitizeStoredStrings({ a: "x\u0000y\uD83Dz", b: ["\uDE00"] }));
    expect(serialized).not.toMatch(/\\u0000/);
    expect(serialized).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
  });
});
