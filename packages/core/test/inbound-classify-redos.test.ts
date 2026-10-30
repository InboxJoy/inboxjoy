import { describe, expect, it } from "vitest";
import { classifyBounceWebhook, extractMailboxCandidateEmails, extractSenderEmail, extractSuppressibleRecipientEmails } from "../src/inbound/classify.js";

// Anyone can send a "From: mailer-daemon@..." email, and the whole body is scanned
// for bounced recipients. These bodies used to take seconds to minutes each.
const SIZE = 500_000;
const hostileBodies: Array<[string, string]> = [
  ["a long run with no @", "550 user unknown " + "a".repeat(SIZE)],
  ["whitespace after an rfc822 header", "Final-Recipient: rfc822" + " ".repeat(SIZE) + "!"],
  ["repeated @ signs", "550 user unknown " + "a@".repeat(SIZE / 2)],
  ["a long dotted domain", "550 user unknown x@" + "a.".repeat(SIZE / 2) + "1"],
];

function bounce(body: string): Record<string, unknown> {
  return { from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", body };
}

describe("bounce parsing on hostile bodies", () => {
  it.each(hostileBodies)("handles %s in linear time", (_name, body) => {
    const payload = bounce(body);
    const started = performance.now();
    classifyBounceWebhook(payload, "message.received", "GMAIL_NEW_GMAIL_MESSAGE");
    extractSuppressibleRecipientEmails(payload, "bounce");
    extractMailboxCandidateEmails({ from: body, to: body });
    extractSenderEmail({ from: body });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("bounce recipient extraction", () => {
  it.each([
    ["Final-Recipient: rfc822; jane@example.com\nAction: failed\nStatus: 5.1.1", "jane@example.com"],
    ["Final-Recipient: rfc822;jane@example.com", "jane@example.com"],
    ["Original-Recipient: rfc822 <jane@example.com>", "jane@example.com"],
    ["The email account that you tried to reach does not exist. address <Jane@Example.com> was not found", "jane@example.com"],
    ["<jane@example.com>: user unknown", "jane@example.com"],
  ])("finds the recipient in %j", (body, expected) => {
    expect(extractSuppressibleRecipientEmails(bounce(body), "bounce")).toEqual([expected]);
  });

  it("never suppresses the bounce sender or the mailbox itself", () => {
    const payload = bounce("mailer-daemon@googlemail.com user unknown; sender@example.com not found");
    expect(extractSuppressibleRecipientEmails(payload, "bounce", "sender@example.com")).toEqual([]);
  });
});
