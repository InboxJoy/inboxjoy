import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import {
  classifyBounceWebhook,
  extractMailboxCandidateEmails,
  extractReplyContent,
  extractSenderEmail,
  extractSuppressibleRecipientEmails,
  isAutoReply,
  classifyReplyIntent,
  stripQuotedReply,
  isBounceWebhook,
  isComplaintWebhook,
  isPermanentBounce,
  writeInboundReply,
  writeWebhookSuppressions,
} from "./index.js";

test("extracts sender from nested Composio message payloads", () => {
  expect(extractSenderEmail({ message: { payload: { from: { emailAddress: "Lead <lead@example.com>" } } } })).toBe("lead@example.com");
});

test("does not mistake recipient fields for a sender", () => {
  expect(extractSenderEmail({ to: { email: "recipient@example.com" }, subject: "hello" })).toBeUndefined();
});

describe("isAutoReply", () => {
  // Shaped like a real stored production webhook: payload.data.payload.headers
  // is an array of { name, value } RFC header pairs.
  const baseHeaders = [
    { name: "Delivered-To", value: "sender@example.com" },
    { name: "Received", value: "by mx.example.com with SMTP" },
    { name: "Return-Path", value: "<lead@example.com>" },
    { name: "Received-SPF", value: "pass" },
    { name: "Authentication-Results", value: "spf=pass" },
    { name: "Date", value: "Mon, 21 Sep 2026 10:00:00 +0000" },
    { name: "From", value: "lead@example.com" },
    { name: "Message-Id", value: "<abc-123@example.com>" },
    { name: "To", value: "sender@example.com" },
    { name: "Mime-Version", value: "1.0" },
  ];

  test("flags a header-based autoresponder (X-Autorespond, X-Loop) regardless of subject", () => {
    const data = {
      id: "msg-1",
      to: "sender@example.com",
      sender: "lead@example.com",
      subject: "Re: Intro call",
      message_text: "I am currently unavailable and will respond when I return.",
      payload: {
        headers: [
          ...baseHeaders,
          { name: "Subject", value: "Re: Intro call" },
          { name: "X-Autorespond", value: "yes" },
          { name: "X-Loop", value: "autoreply@example.com" },
          { name: "Precedence", value: "bulk" },
        ],
      },
    };
    expect(isAutoReply(data)).toBe(true);
  });

  test("flags a subject-based autoresponder (\"Automatic reply: ...\") with no telltale headers", () => {
    const data = {
      id: "msg-2",
      to: "sender@example.com",
      sender: "lead@example.com",
      subject: "Automatic reply: Re: Intro call",
      message_text: "I am currently out of the office and will reply when I return.",
      payload: { headers: [...baseHeaders, { name: "Subject", value: "Automatic reply: Re: Intro call" }] },
    };
    expect(isAutoReply(data)).toBe(true);
  });

  test("does not flag a genuine human reply", () => {
    const data = {
      id: "msg-3",
      to: "sender@example.com",
      sender: "lead@example.com",
      subject: "RE: We need to question your website",
      message_text: "Thanks for reaching out -- can you send more detail on pricing?",
      payload: { headers: [...baseHeaders, { name: "Subject", value: "RE: We need to question your website" }] },
    };
    expect(isAutoReply(data)).toBe(false);
  });

  test("does not flag a human reply whose body merely mentions being out of office", () => {
    const data = {
      id: "msg-4",
      to: "sender@example.com",
      sender: "lead@example.com",
      subject: "RE: We need to question your website",
      message_text: "Sorry for the slow reply, I was out of office last week but I'm back now.",
      payload: { headers: [...baseHeaders, { name: "Subject", value: "RE: We need to question your website" }] },
    };
    expect(isAutoReply(data)).toBe(false);
  });

  test("does not treat bare Precedence: bulk or list as an autoresponder", () => {
    const bulk = { id: "msg-5", subject: "Weekly digest", payload: { headers: [{ name: "Precedence", value: "bulk" }] } };
    const list = { id: "msg-6", subject: "Weekly digest", payload: { headers: [{ name: "Precedence", value: "list" }] } };
    expect(isAutoReply(bulk)).toBe(false);
    expect(isAutoReply(list)).toBe(false);
  });

  test("only matches subject patterns at the start of the subject", () => {
    expect(isAutoReply({ subject: "Re: automatic reply needed", payload: { headers: [] } })).toBe(false);
    expect(isAutoReply({ subject: "Automatic Reply: I am away", payload: { headers: [] } })).toBe(true);
  });
});

test("captures one populated reply when a provider message is redelivered", async () => {
  const storedReplies: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000010" }]),
        })),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((reply: Record<string, unknown>) => ({
      onConflictDoNothing: vi.fn(async () => {
        const duplicate = storedReplies.some((stored) => stored.workspaceId === reply.workspaceId && stored.providerMessageId === reply.providerMessageId);
        if (!duplicate) storedReplies.push(reply);
      }),
    })),
  }));
  const content = extractReplyContent({
    message_id: "provider-message-1",
    thread_id: "provider-thread-1",
    subject: "Re: Intro",
    body: { contentType: "html", content: "<p>Hello <strong>there</strong>.</p><p>Interested.</p>" },
  }, "2026-09-20T12:30:00.000Z");
  const input = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    contactId: "00000000-0000-4000-8000-000000000002",
    enrollmentId: "00000000-0000-4000-8000-000000000003",
    sequenceId: "00000000-0000-4000-8000-000000000004",
    emailAccountId: "00000000-0000-4000-8000-000000000005",
    fromEmail: "lead@example.com",
    content,
  };

  await writeInboundReply({ select, insert } as never, input);
  await writeInboundReply({ select, insert } as never, input);

  expect(storedReplies).toHaveLength(1);
  expect(storedReplies[0]).toEqual(expect.objectContaining({
    providerMessageId: "provider-message-1",
    providerThreadId: "provider-thread-1",
    subject: "Re: Intro",
    bodyText: "Hello there.\nInterested.",
    snippet: "Hello there. Interested.",
    inReplyToMessageId: "00000000-0000-4000-8000-000000000010",
    source: "webhook",
  }));
});

test("extracts mailbox candidates from display-name From headers", () => {
  expect(extractMailboxCandidateEmails({ from: "Sender Name <sender@example.com>" })).toEqual(["sender@example.com"]);
});

test("recognizes bounce and non-delivery notifications defensively", () => {
  expect(isBounceWebhook({ data: { from: "MAILER-DAEMON@example.com", subject: "Delivery Status Notification (Failure)" } }, "trigger.event", "GMAIL_NEW_GMAIL_MESSAGE")).toBe(true);
  expect(isBounceWebhook({ data: { subject: "A normal reply" } }, "trigger.event", "GMAIL_NEW_GMAIL_MESSAGE")).toBe(false);
});

describe("bounce classification", () => {
  test.each([
    ["hard_bounce", { diagnosticCode: "smtp; 550 5.1.1 User unknown" }],
    ["auto_reply", { subject: "Automatic reply: out of office" }],
    ["mailbox_full", { status: "5.2.2", diagnostic: "Mailbox is full" }],
    ["domain_not_found", { status: "5.1.2", diagnostic: "No such domain" }],
    ["spam_block", { status: "5.7.1", diagnostic: "Message rejected as spam by blocklist" }],
    ["rate_limit", { status: "421 4.7.0", diagnostic: "Rate limit exceeded" }],
    ["policy_rejection", { status: "550 5.7.1", diagnostic: "Rejected due to policy violation" }],
    ["auth_failure", { status: "535 5.7.8", diagnostic: "Authentication failed" }],
    ["temporary_provider_error", { status: "451 4.3.0", diagnostic: "Temporary provider failure" }],
  ])("classifies %s", (expected, payload) => {
    expect(classifyBounceWebhook(payload, "delivery.failed", "GMAIL_NEW_GMAIL_MESSAGE")).toBe(expected);
  });

  test("classifies free-text DSN bodies without SMTP codes as permanent", () => {
    const payload = {
      type: "trigger.event",
      data: {
        from: "MAILER-DAEMON@example.com",
        subject: "Delivery Status Notification (Failure)",
        body: "The address bounced-email@example.com was not found.",
      },
      metadata: {
        connected_account_id: "account-1",
        trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
      },
    };

    const classification = classifyBounceWebhook(payload, "trigger.event", "GMAIL_NEW_GMAIL_MESSAGE");
    expect(classification).toBe("hard_bounce");
    expect(isPermanentBounce(classification!)).toBe(true);
  });

  test("only permanent recipient failures are suppressible", () => {
    expect(isPermanentBounce("hard_bounce")).toBe(true);
    expect(isPermanentBounce("domain_not_found")).toBe(true);
    expect(isPermanentBounce("auto_reply")).toBe(false);
    expect(isPermanentBounce("soft_bounce")).toBe(false);
    expect(isPermanentBounce("mailbox_full")).toBe(false);
    expect(isPermanentBounce("rate_limit")).toBe(false);
    expect(isPermanentBounce("temporary_provider_error")).toBe(false);
  });

  test("does not treat automatic replies as bounces", () => {
    const payload = { subject: "Automatic reply: out of office" };
    expect(classifyBounceWebhook(payload, "delivery.failed", "GMAIL_NEW_GMAIL_MESSAGE")).toBe("auto_reply");
    expect(isBounceWebhook(payload, "delivery.failed", "GMAIL_NEW_GMAIL_MESSAGE")).toBe(false);
  });

  test("recognizes complaints independently from delivery failures", () => {
    expect(isComplaintWebhook({ complaint: "Recipient reported this message as spam" }, "message.complaint", "")).toBe(true);
    expect(isComplaintWebhook({}, "message.complaint", "")).toBe(true);
  });

  test("does not classify ordinary replies mentioning versions or complaints", () => {
    const payload = {
      data: {
        from: "lead@example.com",
        subject: "Re: quick note",
        body: "I have a complaint about the docs for version 5.1.1, but this is a normal reply.",
      },
      metadata: { trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE" },
    };

    expect(classifyBounceWebhook(payload, "trigger.event", "GMAIL_NEW_GMAIL_MESSAGE")).toBeUndefined();
    expect(isComplaintWebhook(payload, "trigger.event", "GMAIL_NEW_GMAIL_MESSAGE")).toBe(false);
  });

  test("extracts only the failed DSN recipient and ignores quoted addresses", () => {
    const payload = {
      data: {
        from: "MAILER-DAEMON@example.com",
        subject: "Delivery Status Notification (Failure)",
        body: "The address failed@example.com was not found.\n\nOn Tuesday, quoted@example.com wrote: hello.",
      },
    };

    expect(extractSuppressibleRecipientEmails(payload, "bounce", "sender@example.com")).toEqual(["failed@example.com"]);
  });
});

test("writes workspace-wide suppressions for bounced recipients", async () => {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  await writeWebhookSuppressions({ insert } as never, {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    emails: ["lead@example.com"],
    reason: "bounced",
    eventId: "event-1",
    classification: "hard_bounce",
  });

  expect(insert).toHaveBeenCalledTimes(1);
  expect(values).toHaveBeenCalledWith([expect.objectContaining({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    normalizedEmail: "lead@example.com",
    emailHash: createHash("sha256").update("lead@example.com").digest("hex"),
    reason: "bounced",
    source: "provider_webhook",
  })]);
  expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
});

// Todd Riff's real production reply: the word "Unsubscribe", his signature, then
// the quoted original. The quoted part contains our own footer, so anything that
// matches against the whole body would classify every reply as an opt-out.
const REAL_OPT_OUT = [
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

describe("reply intent", () => {
  test("strips the quoted original", () => {
    expect(stripQuotedReply(REAL_OPT_OUT)).toContain("Unsubscribe");
    expect(stripQuotedReply(REAL_OPT_OUT)).not.toContain("hello@replyless.ai");
    expect(stripQuotedReply("Sounds good.\n\nOn Tue, Sep 16, 2026 at 5:06 PM Foo <f@x.com> wrote:\n> unsubscribe here")).toBe("Sounds good.");
    expect(stripQuotedReply("Yes please.\n\n-----Original Message-----\nunsubscribe")).toBe("Yes please.");
  });

  test("classifies the real production opt-out", () => {
    expect(classifyReplyIntent({ subject: "RE: We need to question your website", message_text: REAL_OPT_OUT })).toBe("opt_out");
  });

  // The failure that would suppress an entire list: our footer lives in the quoted
  // original of every single reply.
  test("does not treat our own quoted unsubscribe footer as an opt-out", () => {
    const keen = [
      "This looks great, can we talk Thursday?",
      "",
      "*From:* hello@replyless.ai",
      "*Subject:* We need to question your website",
      "If you would rather not hear from us, unsubscribe here.",
    ].join("\n");
    expect(classifyReplyIntent({ subject: "RE: your note", message_text: keen })).toBe("human");
  });

  test("recognises other opt-out phrasings", () => {
    expect(classifyReplyIntent({ message_text: "Please remove me from your list." })).toBe("opt_out");
    expect(classifyReplyIntent({ message_text: "Take me off, thanks." })).toBe("opt_out");
    expect(classifyReplyIntent({ message_text: "Stop emailing me." })).toBe("opt_out");
  });

  test("separates a soft decline from a legal opt-out", () => {
    expect(classifyReplyIntent({ message_text: "Not interested, thanks." })).toBe("soft_decline");
    expect(classifyReplyIntent({ message_text: "We're all set for now." })).toBe("soft_decline");
  });

  test("an opt-out outranks an autoresponder", () => {
    expect(classifyReplyIntent({
      subject: "Automatic reply: We need to question your website",
      message_text: "I have left the company. Please remove me from your list.",
    })).toBe("opt_out");
  });

  test("a plain human reply stays human", () => {
    expect(classifyReplyIntent({ subject: "RE: pricing", message_text: "What does this cost?" })).toBe("human");
  });
});
