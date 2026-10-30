import { KnownEmailSendStatus, type EmailMessage } from "@azure/communication-email";
import { describe, expect, it } from "vitest";

import { createAzureTransactionalEmailService, POSTAL_ADDRESS_LINE, type AzureEmailClient, type TransactionalEmailService } from "../src/index.js";

function recordingClient() {
  const messages: EmailMessage[] = [];
  const client: AzureEmailClient = {
    async beginSend(message) {
      messages.push(message);
      return {
        async pollUntilDone() {
          return { status: KnownEmailSendStatus.Succeeded };
        },
      };
    },
  };
  return { client, messages };
}

function makeService(options: { appBaseUrl?: string; postalAddressLine?: string } = {}): { email: TransactionalEmailService; messages: EmailMessage[] } {
  const { client, messages } = recordingClient();
  const email = createAzureTransactionalEmailService(
    {
      endpoint: "https://email.example.test",
      senderAddress: "hello@example.test",
      appBaseUrl: options.appBaseUrl ?? "https://app.example.test",
      postalAddressLine: options.postalAddressLine,
    },
    { client },
  );
  return { email, messages };
}

async function sendEveryBrandedTemplate(email: TransactionalEmailService): Promise<void> {
  await email.sendWelcome({ recipient: { email: "a@example.test", name: "Sam" } });
  await email.sendPasswordReset({ recipient: { email: "a@example.test", name: "Sam" }, resetUrl: "https://app.example.test/reset/token", expiresInMinutes: 30 });
  await email.sendTrialEnding({ recipient: { email: "a@example.test", name: "Sam" }, daysLeft: 2, trialEndDate: "17 September 2026", amountLabel: "$25.00" });
  await email.sendPaymentSucceeded({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", amountLabel: "$25.00" });
  await email.sendPaymentFailed({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", graceEndsAt: "20 September 2026" });
  await email.sendMailboxAlert({ recipient: { email: "a@example.test", name: "Sam" }, mailboxEmail: "sales@example.test", reasonSentence: "The connection to this mailbox expired." });
  await email.sendCampaignCompleted({ recipient: { email: "a@example.test", name: "Sam" }, campaignName: "Q3 Launch", campaignId: "camp-1", sent: 120, opened: 80, replied: 12 });
  await email.sendReplyReceived({ recipient: { email: "a@example.test", name: "Sam" }, contactLabel: "Jamie Doe", campaignName: "Q3 Launch", campaignId: "camp-1", mailboxEmail: "sales@example.test" });
}

// A recipient name/value crafted to exercise HTML escaping of every interpolated field.
const dangerousName = `O'Brien & <script>alert(1)</script> "Boss"`;
const escapedName = `O&#39;Brien &amp; &lt;script&gt;alert(1)&lt;/script&gt; &quot;Boss&quot;`;

describe("email template rendering", () => {
  it("renders the rewritten welcome email with the getting-started copy", async () => {
    const { email, messages } = makeService();
    await email.sendWelcome({ recipient: { email: "new@example.test", name: dangerousName } });

    const content = messages[0]!.content;
    expect(content.subject).toBe("Welcome to InboxJoy");
    expect(content.plainText).toContain("Three steps to your first campaign");
    expect(content.plainText).toContain("1. Connect Gmail or Outlook. One click, and you send from your real address.");
    expect(content.plainText).toContain("2. Import contacts. Upload a CSV or paste a list.");
    expect(content.plainText).toContain("3. Let AI draft the sequence, then launch.");
    expect(content.plainText).toContain("Most people send their first campaign the same day.");
    expect(content.plainText).toContain("Reply to this email if you get stuck. It reaches a person.");
    expect(content.plainText).toContain("https://app.example.test/app");
    expect(content.html).toContain(`Welcome, ${escapedName}`);
    expect(content.html).not.toContain(dangerousName);
    expect(content.html).toContain("Open InboxJoy");
  });

  it("renders trialEnding with subject, body and escaped values", async () => {
    const { email, messages } = makeService();
    await email.sendTrialEnding({
      recipient: { email: "member@example.test", name: dangerousName },
      daysLeft: 2,
      trialEndDate: "17 September 2026",
      amountLabel: "$25.00",
    });

    const content = messages[0]!.content;
    expect(content.subject).toBe("Your InboxJoy trial ends in 2 days");
    expect(content.plainText).toContain("Your 7-day trial ends on 17 September 2026");
    expect(content.plainText).toContain("$25.00");
    expect(content.plainText).toContain("https://app.example.test/app/settings/billing");
    expect(content.html).toContain(escapedName);
    expect(content.html).not.toContain(dangerousName);
    expect(content.html).toContain("Manage billing");
  });

  it("renders paymentSucceeded with a next-charge line when provided", async () => {
    const { email, messages } = makeService();
    await email.sendPaymentSucceeded({
      recipient: { email: "member@example.test", name: dangerousName },
      planLabel: "Monthly",
      amountLabel: "$25.00",
      nextBillingDate: "17 October 2026",
    });

    const content = messages[0]!.content;
    expect(content.subject).toBe("Payment received — InboxJoy Monthly");
    expect(content.plainText).toContain("We received $25.00 for InboxJoy Monthly.");
    expect(content.plainText).toContain("Next charge: 17 October 2026.");
    expect(content.html).toContain("Next charge: 17 October 2026.");
    expect(content.html).toContain(escapedName);
    expect(content.html).not.toContain(dangerousName);
  });

  it("omits the next-charge line in paymentSucceeded when no next date", async () => {
    const { email, messages } = makeService();
    await email.sendPaymentSucceeded({
      recipient: { email: "member@example.test", name: "Sam" },
      planLabel: "Monthly",
      amountLabel: "$25.00",
    });

    const content = messages[0]!.content;
    expect(content.plainText).not.toContain("Next charge");
    expect(content.html).not.toContain("Next charge");
  });

  it("renders paymentFailed with subject, body and escaped values", async () => {
    const { email, messages } = makeService();
    await email.sendPaymentFailed({
      recipient: { email: "member@example.test", name: dangerousName },
      planLabel: "Monthly",
      graceEndsAt: "20 September 2026",
    });

    const content = messages[0]!.content;
    expect(content.subject).toBe("Payment failed — sending pauses 20 September 2026");
    expect(content.plainText).toContain("The payment for InboxJoy Monthly did not go through.");
    expect(content.plainText).toContain("Your campaigns keep sending until 20 September 2026.");
    expect(content.html).toContain(escapedName);
    expect(content.html).not.toContain(dangerousName);
    expect(content.html).toContain("Update payment method");
  });

  it("renders mailboxAlert with subject, body and escaped values", async () => {
    const { email, messages } = makeService();
    await email.sendMailboxAlert({
      recipient: { email: "member@example.test", name: dangerousName },
      mailboxEmail: "sales@example.test",
      reasonSentence: "The connection to this mailbox expired.",
    });

    const content = messages[0]!.content;
    expect(content.subject).toBe("sales@example.test stopped sending");
    expect(content.plainText).toContain("InboxJoy stopped sending from sales@example.test.");
    expect(content.plainText).toContain("Reason: The connection to this mailbox expired.");
    expect(content.html).toContain(escapedName);
    expect(content.html).not.toContain(dangerousName);
    expect(content.html).toContain("Reconnect inbox");
  });

  it("renders campaignCompleted with subject, stats and escaped values", async () => {
    const { email, messages } = makeService();
    await email.sendCampaignCompleted({
      recipient: { email: "member@example.test", name: dangerousName },
      campaignName: `Q3 <Launch> & "Push"`,
      campaignId: "camp/123 abc",
      sent: 120,
      opened: 80,
      replied: 12,
    });

    const content = messages[0]!.content;
    expect(content.subject).toBe(`Campaign finished: Q3 <Launch> & "Push"`);
    expect(content.plainText).toContain("Sent 120");
    expect(content.plainText).toContain("Opened 80");
    expect(content.plainText).toContain("Replied 12");
    expect(content.html).toContain(escapedName);
    expect(content.html).not.toContain(dangerousName);
    expect(content.html).toContain("Q3 &lt;Launch&gt; &amp; &quot;Push&quot;");
    expect(content.html).not.toContain(`Q3 <Launch> & "Push"`);
    expect(content.html).toContain(encodeURIComponent("camp/123 abc"));
    expect(content.html).toContain("View report");
  });

  it("renders replyReceived with subject, body and escaped values", async () => {
    const { email, messages } = makeService();
    await email.sendReplyReceived({
      recipient: { email: "member@example.test", name: dangerousName },
      contactLabel: dangerousName,
      campaignName: `Q3 <Launch>`,
      campaignId: "camp-1",
      mailboxEmail: "sales@example.test",
    });

    const content = messages[0]!.content;
    expect(content.subject).toBe(`${dangerousName} replied to Q3 <Launch>`);
    expect(content.plainText).toContain(`${dangerousName} replied to Q3 <Launch>.`);
    expect(content.plainText).toContain("sales@example.test inbox");
    expect(content.html).toContain(escapedName);
    expect(content.html).not.toContain(dangerousName);
    expect(content.html).toContain("Q3 &lt;Launch&gt;");
    expect(content.html).toContain("View campaign");
  });

  it("includes the brand logo and the cloud CAN-SPAM address line in html, and the address line in plain text, for every template", async () => {
    const { email, messages } = makeService({ appBaseUrl: "https://inboxjoy.online", postalAddressLine: POSTAL_ADDRESS_LINE });

    await sendEveryBrandedTemplate(email);

    expect(messages.length).toBe(8);
    const addressLine = "Shipping solo from — Dubai Founder HQ, Dubai, United Arab Emirates";
    for (const message of messages) {
      expect(message.content.html).toMatch(
        /<img[^>]*src="https:\/\/inboxjoy\.online\/brand\/icon-64x64\.png"[^>]*width="36"[^>]*height="36"[^>]*alt="InboxJoy"[^>]*>/,
      );
      expect(message.content.html).toContain(addressLine);
      expect(message.content.plainText).toContain(addressLine);
    }
  });

  it("serves the logo from the install's own web URL and leaves out the cloud postal line by default", async () => {
    const { email, messages } = makeService({ appBaseUrl: "https://mail.selfhost.example/base" });

    await sendEveryBrandedTemplate(email);

    expect(messages.length).toBe(8);
    for (const message of messages) {
      expect(message.content.html).toContain(`src="https://mail.selfhost.example/brand/icon-64x64.png"`);
      expect(message.content.html).not.toContain("inboxjoy.online");
      expect(message.content.html).not.toContain("Dubai");
      expect(message.content.plainText).not.toContain("Dubai");
    }
  });

  it("shows the manage-preferences footer link on notification emails but never on authentication emails", async () => {
    const { email, messages } = makeService();
    const preferencesUrl = "https://app.example.test/app/settings";

    await email.sendWelcome({ recipient: { email: "a@example.test", name: "Sam" } });
    await email.sendTrialEnding({ recipient: { email: "a@example.test", name: "Sam" }, daysLeft: 2, trialEndDate: "17 September 2026", amountLabel: "$25.00" });
    await email.sendPaymentSucceeded({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", amountLabel: "$25.00" });
    await email.sendPaymentFailed({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", graceEndsAt: "20 September 2026" });
    await email.sendMailboxAlert({ recipient: { email: "a@example.test", name: "Sam" }, mailboxEmail: "sales@example.test", reasonSentence: "The connection to this mailbox expired." });
    await email.sendCampaignCompleted({ recipient: { email: "a@example.test", name: "Sam" }, campaignName: "Q3 Launch", campaignId: "camp-1", sent: 120, opened: 80, replied: 12 });
    await email.sendReplyReceived({ recipient: { email: "a@example.test", name: "Sam" }, contactLabel: "Jamie Doe", campaignName: "Q3 Launch", campaignId: "camp-1", mailboxEmail: "sales@example.test" });

    expect(messages.length).toBe(7);
    for (const message of messages) {
      expect(message.content.html).toContain("Manage email preferences");
      expect(message.content.html).toContain(`href="${preferencesUrl}"`);
    }

    const { email: authEmail, messages: authMessages } = makeService();
    await authEmail.sendPasswordReset({ recipient: { email: "a@example.test", name: "Sam" }, resetUrl: "https://app.example.test/reset/token", expiresInMinutes: 30 });
    await authEmail.sendSequenceTest({
      recipient: { email: "a@example.test", name: "Sam" },
      subject: "Verify your InboxJoy email",
      plainText: "Verify your email address.\n\nhttps://app.example.test/verify/token",
    });

    expect(authMessages.length).toBe(2);
    for (const message of authMessages) {
      expect(message.content.html).not.toContain("Manage email preferences");
    }
  });

  it("never uses an exclamation mark in any rendered template", async () => {
    const { email, messages } = makeService();

    await email.sendWelcome({ recipient: { email: "a@example.test", name: "Sam" } });
    await email.sendPasswordReset({ recipient: { email: "a@example.test", name: "Sam" }, resetUrl: "https://app.example.test/reset/token", expiresInMinutes: 30 });
    await email.sendTrialEnding({ recipient: { email: "a@example.test", name: "Sam" }, daysLeft: 2, trialEndDate: "17 September 2026", amountLabel: "$25.00" });
    await email.sendPaymentSucceeded({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", amountLabel: "$25.00", nextBillingDate: "17 October 2026" });
    await email.sendPaymentSucceeded({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", amountLabel: "$25.00" });
    await email.sendPaymentFailed({ recipient: { email: "a@example.test", name: "Sam" }, planLabel: "Monthly", graceEndsAt: "20 September 2026" });
    await email.sendMailboxAlert({ recipient: { email: "a@example.test", name: "Sam" }, mailboxEmail: "sales@example.test", reasonSentence: "The connection to this mailbox expired." });
    await email.sendCampaignCompleted({ recipient: { email: "a@example.test", name: "Sam" }, campaignName: "Q3 Launch", campaignId: "camp-1", sent: 120, opened: 80, replied: 12 });
    await email.sendReplyReceived({ recipient: { email: "a@example.test", name: "Sam" }, contactLabel: "Jamie Doe", campaignName: "Q3 Launch", campaignId: "camp-1", mailboxEmail: "sales@example.test" });

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      // Strip the static "<!doctype html>" boilerplate, which is markup, not copy.
      const htmlCopy = message.content.html?.replace(/<!doctype html>/i, "");
      expect(message.content.subject).not.toContain("!");
      expect(message.content.plainText).not.toContain("!");
      expect(htmlCopy).not.toContain("!");
    }
  });
});
