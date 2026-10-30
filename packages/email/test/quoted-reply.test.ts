import { describe, expect, it } from "vitest";

import { QUOTE_SCAN_LIMIT, splitQuotedReply, stripQuotedReply } from "../src/index.js";

// Matches the fixture used in apps/api/src/modules/webhooks/index.test.ts so both
// packages agree on how this real production reply gets split.
const REAL_OUTLOOK_BOLD_FROM = [
  "Unsubscribe",
  "*Todd G. Riff*",
  "903 Welch St. | Houston, Texas 77006",
  "TRiff@RiffLawfirm.com",
  "",
  "*From:* hello@replyless.ai",
  "*Sent:* Wednesday, September 16, 2026 5:06 PM",
  "*Subject:* We need to question your website",
  "",
  "If you would rather not hear from us, unsubscribe here.",
].join("\n");

describe("splitQuotedReply", () => {
  it("splits a Gmail 'On <date>, X wrote:' quote", () => {
    const body = "Sounds good.\n\nOn Tue, Sep 16, 2026 at 5:06 PM Foo <f@x.com> wrote:\n> Original text here";
    const result = splitQuotedReply(body);
    expect(result.text).toBe("Sounds good.");
    expect(result.quoted).toContain("On Tue, Sep 16, 2026");
    expect(result.quoted).toContain("Original text here");
  });

  it("splits an Outlook 'From: ... Sent: ...' block", () => {
    const body = "Thanks, not right now.\n\nFrom: hello@replyless.ai\nSent: Wednesday, September 16, 2026 5:06 PM\nSubject: We need to question your website\n\nOriginal message body";
    const result = splitQuotedReply(body);
    expect(result.text).toBe("Thanks, not right now.");
    expect(result.quoted).toContain("From: hello@replyless.ai");
    expect(result.quoted).toContain("Original message body");
  });

  it("splits the bold '*From:*' variant seen in real Outlook data", () => {
    const result = splitQuotedReply(REAL_OUTLOOK_BOLD_FROM);
    expect(result.text).toBe("Unsubscribe\n*Todd G. Riff*\n903 Welch St. | Houston, Texas 77006\nTRiff@RiffLawfirm.com");
    expect(result.quoted).toContain("*From:* hello@replyless.ai");
    expect(result.quoted).toContain("If you would rather not hear from us, unsubscribe here.");
  });

  it("splits a '-----Original Message-----' block", () => {
    const body = "Yes please.\n\n-----Original Message-----\nFrom: sender@example.com\nunsubscribe";
    const result = splitQuotedReply(body);
    expect(result.text).toBe("Yes please.");
    expect(result.quoted).toContain("-----Original Message-----");
    expect(result.quoted).toContain("unsubscribe");
  });

  it("splits '>' prefixed quoted lines", () => {
    const body = "No thanks.\n> This is the quoted original\n> second quoted line";
    const result = splitQuotedReply(body);
    expect(result.text).toBe("No thanks.");
    expect(result.quoted).toBe("> This is the quoted original\n> second quoted line");
  });

  it("returns quoted: null when the body has no quote marker", () => {
    const result = splitQuotedReply("Just a plain reply with no quoted history.");
    expect(result.text).toBe("Just a plain reply with no quoted history.");
    expect(result.quoted).toBeNull();
  });

  it("returns quoted: null for an empty body", () => {
    const result = splitQuotedReply("");
    expect(result.text).toBe("");
    expect(result.quoted).toBeNull();
  });

  it("handles a quote-only body (marker at the very start)", () => {
    const body = "On Tue, Sep 16, 2026 at 5:06 PM Foo <f@x.com> wrote:\n> only the quoted original, no new text";
    const result = splitQuotedReply(body);
    expect(result.text).toBe("");
    expect(result.quoted).not.toBeNull();
    expect(result.quoted).toContain("only the quoted original");
  });

  it("still detects every marker family after the line-anchored rewrite", () => {
    expect(splitQuotedReply("Thanks!\n-- \nJane Doe\nCEO").text).toBe("Thanks!");
    expect(splitQuotedReply("Thanks!\n  > quoted line").text).toBe("Thanks!");
    expect(splitQuotedReply("Thanks!\n\nOn Mon, Oct 19, 2026 at 9:00 AM Foo <f@x.com> wrote:\n> hi").text).toBe("Thanks!");
    expect(splitQuotedReply("Thanks!\n\nFrom: foo@x.com\nSent: Monday").text).toBe("Thanks!");
    expect(splitQuotedReply("Thanks!\n\nSent from my iPhone").text).toBe("Thanks!");
    expect(splitQuotedReply("Thanks!\r\n-----Original Message-----\r\nFrom: a@b.c").text).toBe("Thanks!");
    expect(splitQuotedReply("Thanks!\r\n--\r\nSig").text).toBe("Thanks!");
  });

  it("does not treat a marker preceded by blank lines as part of the new text", () => {
    const result = splitQuotedReply("Yes\n\n\n\n> quoted");
    expect(result.text).toBe("Yes");
    expect(result.quoted).toBe("> quoted");
  });

  // Regression for the quadratic `^\s*` markers from the 2026-10-20 security audit:
  // 200k blank lines used to block the event loop for well over a minute.
  it("finishes a 200k-newline body in under 200 ms", () => {
    const body = "\n".repeat(200_000);
    const started = performance.now();
    const result = splitQuotedReply(body);
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.text).toBe("");
  });

  it("finishes a whitespace-heavy body with a late marker in under 200 ms", () => {
    const body = `${" \n".repeat(100_000)}> quoted`;
    const started = performance.now();
    const result = splitQuotedReply(body);
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.text).toBe("");
    expect(result.quoted).toBe("> quoted");
  });

  it("only scans the first 32 KB for markers and keeps the remainder as quoted", () => {
    const filler = "x".repeat(QUOTE_SCAN_LIMIT);
    const result = splitQuotedReply(`${filler}\n> late marker`);
    expect(result.text).toBe(filler);
    expect(result.quoted).toBe("> late marker");

    const early = splitQuotedReply(`Hi\n> quoted\n${filler}`);
    expect(early.text).toBe("Hi");
    expect(early.quoted).toBe(`> quoted\n${filler}`);
  });
});

describe("stripQuotedReply", () => {
  it("stays identical to splitQuotedReply(body).text", () => {
    expect(stripQuotedReply(REAL_OUTLOOK_BOLD_FROM)).toContain("Unsubscribe");
    expect(stripQuotedReply(REAL_OUTLOOK_BOLD_FROM)).not.toContain("hello@replyless.ai");
    expect(stripQuotedReply("Sounds good.\n\nOn Tue, Sep 16, 2026 at 5:06 PM Foo <f@x.com> wrote:\n> unsubscribe here")).toBe("Sounds good.");
    expect(stripQuotedReply("Yes please.\n\n-----Original Message-----\nunsubscribe")).toBe("Yes please.");
  });
});
