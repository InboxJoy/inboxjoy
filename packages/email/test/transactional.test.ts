import { KnownEmailSendStatus, type EmailMessage } from "@azure/communication-email";
import { describe, expect, it } from "vitest";

import {
  createAzureTransactionalEmailService,
  createSmtpTransactionalEmailService,
  createTransactionalEmailService,
  mailFromAddress,
  POSTAL_ADDRESS_LINE,
  resolveTransactionalEmailProvider,
  type AzureEmailClient,
  type SmtpTransactionalMessage,
  type SmtpTransactionalTransport,
} from "../src/index.js";

function recordingTransport(failWith?: Error) {
  const messages: SmtpTransactionalMessage[] = [];
  const transport: SmtpTransactionalTransport = {
    async sendMail(message) {
      if (failWith) throw failWith;
      messages.push(message);
      return { messageId: "<test@example.test>" };
    },
  };
  return { transport, messages };
}

const smtpUrl = "smtps://mailer%40example.test:s3cr%3At-pass@smtp.example.test:465";

function recordingClient(status = KnownEmailSendStatus.Succeeded) {
  const messages: EmailMessage[] = [];
  const client: AzureEmailClient = {
    async beginSend(message) {
      messages.push(message);
      return {
        async pollUntilDone() {
          return { status };
        },
      };
    },
  };
  return { client, messages };
}

describe("Azure transactional email", () => {
  it("escapes workspace invitation names and recipient email while keeping the subject on one line", async () => {
    const { client, messages } = recordingClient();
    const email = createAzureTransactionalEmailService({
      endpoint: "https://email.example.test",
      senderAddress: "hello@example.test",
      appBaseUrl: "https://app.example.test",
      postalAddressLine: POSTAL_ADDRESS_LINE,
    }, { client });
    const workspaceName = "<script>alert('workspace')</script>\nWorkspace & friends";
    const inviterName = "<img src=x>\r\nInviter";
    const acceptUrl = "https://app.example.test/app/invite/private-token";

    await email.sendWorkspaceInvite({ recipient: { email: "invitee+&@example.test" }, inviterName, workspaceName, role: "admin", acceptUrl, expiresAt: new Date("2026-10-13T12:00:00.000Z") });

    expect(messages).toHaveLength(1);
    const content = messages[0]!.content;
    expect(content.subject).toBe("<img src=x>Inviter invited you to <script>alert('workspace')</script>Workspace & friends on InboxJoy");
    expect(content.subject).not.toMatch(/[\r\n]/);
    expect(content.html).not.toContain("<script>");
    expect(content.html).not.toContain("<img src=x>");
    expect(content.html).toContain("&lt;script&gt;alert(&#39;workspace&#39;)&lt;/script&gt;\nWorkspace &amp; friends");
    expect(content.html).toContain("&lt;img src=x&gt;\r\nInviter");
    expect(content.html).toContain("invitee+&amp;@example.test");
    expect(content.html).toContain(`href="${acceptUrl}"`);
    expect(content.html!.indexOf("Accept invitation")).toBeLessThan(content.html!.indexOf("Sign in or create your account"));
    expect(content.plainText).toContain(`${inviterName} invited you to join ${workspaceName} on InboxJoy as an admin.`);
    expect(content.plainText).toContain(`Accept invitation: ${acceptUrl}`);
    expect(content.plainText).toContain("Sign in or create your account with invitee+&@example.test to join. This link works for 7 days.");
    expect(content.plainText).toContain("Dubai Founder HQ");
    expect(content.html).toContain("Dubai Founder HQ");
  });

  it("truncates each invitation subject name to 80 characters and uses member copy", async () => {
    const { client, messages } = recordingClient();
    const email = createAzureTransactionalEmailService({ endpoint: "https://email.example.test", senderAddress: "hello@example.test", appBaseUrl: "https://app.example.test" }, { client });
    await email.sendWorkspaceInvite({ recipient: { email: "invitee@example.test" }, inviterName: "Inviter".repeat(20), workspaceName: "Workspace".repeat(20), role: "member", acceptUrl: "https://app.example.test/app/invite/private-token", expiresAt: new Date("2026-10-13T12:00:00.000Z") });
    expect(messages[0]!.content.subject).toBe(`${"Inviter".repeat(20).slice(0, 80)} invited you to ${"Workspace".repeat(20).slice(0, 80)} on InboxJoy`);
    expect(messages[0]!.content.plainText).toContain("on InboxJoy as a member.");
  });

  it("renders and sends a welcome email through the configured sender", async () => {
    const { client, messages } = recordingClient();
    const email = createAzureTransactionalEmailService({
      endpoint: "https://email.example.test",
      senderAddress: "hello@example.test",
      replyToAddress: "support@example.test",
      appBaseUrl: "https://app.example.test/base",
      sendTimeoutMs: 5_000,
    }, { client });

    await email.sendWelcome({ recipient: { email: "new@example.test", name: "Alex\r\n<Admin>" } });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      senderAddress: "hello@example.test",
      recipients: { to: [{ address: "new@example.test", displayName: "Alex <Admin>" }] },
      replyTo: [{ address: "support@example.test" }],
      disableUserEngagementTracking: true,
      content: {
        subject: "Welcome to InboxJoy",
      },
    });
    expect(messages[0]?.content.plainText).toContain("https://app.example.test/app");
    expect(messages[0]?.content.html).toContain("Welcome, Alex &lt;Admin&gt;");
    expect(messages[0]?.content.html).not.toContain("Welcome, Alex <Admin>");
  });

  it("includes the Better Auth reset URL without exposing it elsewhere", async () => {
    const { client, messages } = recordingClient();
    const email = createAzureTransactionalEmailService({
      endpoint: "https://email.example.test",
      senderAddress: "hello@example.test",
      appBaseUrl: "https://app.example.test",
    }, { client });
    const resetUrl = "https://api.example.test/v1/auth/reset-password/private-token?callbackURL=https%3A%2F%2Fapp.example.test%2Fapp%2Freset-password";

    await email.sendPasswordReset({
      recipient: { email: "member@example.test", name: "Member" },
      resetUrl,
      expiresInMinutes: 60,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content.subject).toBe("Reset your InboxJoy password");
    expect(messages[0]?.content.plainText).toContain(resetUrl);
    expect(messages[0]?.content.plainText).toContain("60 minutes");
    expect(messages[0]?.content.html).toContain(resetUrl.replaceAll("&", "&amp;"));
  });

  it("rejects non-success terminal statuses", async () => {
    const { client } = recordingClient(KnownEmailSendStatus.Failed);
    const email = createAzureTransactionalEmailService({
      endpoint: "https://email.example.test",
      senderAddress: "hello@example.test",
      appBaseUrl: "https://app.example.test",
    }, { client });

    await expect(email.sendWelcome({ recipient: { email: "new@example.test" } }))
      .rejects.toThrow("ended with status Failed");
  });

  it("reports itself as the Azure provider", () => {
    const { client } = recordingClient();
    const email = createAzureTransactionalEmailService({ endpoint: "https://email.example.test", senderAddress: "hello@example.test", appBaseUrl: "https://app.example.test" }, { client });
    expect(email).toMatchObject({ enabled: true, provider: "azure-communication-email", senderAddress: "hello@example.test" });
  });
});

describe("SMTP transactional email", () => {
  it("sends the same rendered welcome email over SMTP with from, reply-to and a sanitized display name", async () => {
    const { transport, messages } = recordingTransport();
    const { client, messages: azureMessages } = recordingClient();
    const smtp = createSmtpTransactionalEmailService({
      smtpUrl,
      from: "InboxJoy <hey@selfhost.example>",
      replyToAddress: "support@selfhost.example",
      appBaseUrl: "https://mail.selfhost.example",
    }, { transport });
    const azure = createAzureTransactionalEmailService({ endpoint: "https://email.example.test", senderAddress: "hey@selfhost.example", appBaseUrl: "https://mail.selfhost.example" }, { client });

    await smtp.sendWelcome({ recipient: { email: "new@example.test", name: "Alex\r\n<Admin>" } });
    await azure.sendWelcome({ recipient: { email: "new@example.test", name: "Alex\r\n<Admin>" } });

    expect(smtp).toMatchObject({ enabled: true, provider: "smtp", senderAddress: "hey@selfhost.example" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      from: "InboxJoy <hey@selfhost.example>",
      to: { name: "Alex <Admin>", address: "new@example.test" },
      replyTo: "support@selfhost.example",
      subject: "Welcome to InboxJoy",
      text: azureMessages[0]!.content.plainText,
      html: azureMessages[0]!.content.html,
    });
    expect(messages[0]!.html).toContain(`src="https://mail.selfhost.example/brand/icon-64x64.png"`);
    expect(messages[0]!.text).not.toContain("Dubai");
  });

  it("addresses a nameless recipient by bare address, omits reply-to, and adds the postal line when given", async () => {
    const { transport, messages } = recordingTransport();
    const email = createSmtpTransactionalEmailService({
      smtpUrl,
      from: "hey@selfhost.example",
      appBaseUrl: "https://mail.selfhost.example",
      postalAddressLine: "1 Example Street, Springfield",
    }, { transport });

    await email.sendSequenceTest({ recipient: { email: "owner@example.test" }, subject: "[TEST] Hello", plainText: "Body" });

    expect(messages[0]).toEqual({
      from: "hey@selfhost.example",
      to: "owner@example.test",
      subject: "[TEST] Hello",
      text: "Body\n\n1 Example Street, Springfield",
      html: "<pre style=\"white-space:pre-wrap;font-family:Arial,sans-serif\">Body</pre>",
    });
  });

  it("fails loudly without leaking the SMTP URL or password", async () => {
    const failure = Object.assign(new Error(`Invalid login for ${smtpUrl} using s3cr:t-pass`), { code: "EAUTH" });
    const { transport } = recordingTransport(failure);
    const email = createSmtpTransactionalEmailService({ smtpUrl, from: "hey@selfhost.example", appBaseUrl: "https://mail.selfhost.example" }, { transport });

    const error = await email.sendPasswordReset({ recipient: { email: "a@example.test" }, resetUrl: "https://mail.selfhost.example/reset/token", expiresInMinutes: 60 })
      .then(() => undefined, (caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("SMTP system email send failed (EAUTH)");
    expect(error!.message).not.toContain("s3cr");
    expect(error!.message).not.toContain(smtpUrl);
    expect(error!.cause).toBeUndefined();
  });

  it("extracts the bare address from a MAIL_FROM with a display name", () => {
    expect(mailFromAddress("InboxJoy <hey@selfhost.example>")).toBe("hey@selfhost.example");
    expect(mailFromAddress("hey@selfhost.example")).toBe("hey@selfhost.example");
  });
});

describe("transactional email transport selection", () => {
  const azure = { endpoint: "https://email.example.test", senderAddress: "hello@example.test" };
  const smtp = { url: smtpUrl, from: "hey@selfhost.example" };

  it("prefers Azure Communication Services whenever its endpoint and sender are set", async () => {
    expect(resolveTransactionalEmailProvider({ appBaseUrl: "https://app.example.test", azure, smtp })).toBe("azure-communication-email");
    const { client, messages } = recordingClient();
    const { transport, messages: smtpMessages } = recordingTransport();
    const email = createTransactionalEmailService({ appBaseUrl: "https://app.example.test", azure, smtp, postalAddressLine: POSTAL_ADDRESS_LINE }, { client, transport });

    await email.sendWelcome({ recipient: { email: "new@example.test" } });

    expect(email.provider).toBe("azure-communication-email");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content.plainText).toContain(POSTAL_ADDRESS_LINE);
    expect(smtpMessages).toHaveLength(0);
  });

  it("falls back to SMTP when Azure is not fully configured", async () => {
    expect(resolveTransactionalEmailProvider({ appBaseUrl: "https://app.example.test", azure: { endpoint: azure.endpoint }, smtp })).toBe("smtp");
    const { client, messages } = recordingClient();
    const { transport, messages: smtpMessages } = recordingTransport();
    const email = createTransactionalEmailService({ appBaseUrl: "https://app.example.test", smtp: { ...smtp, replyToAddress: "support@selfhost.example" } }, { client, transport });

    await email.sendWelcome({ recipient: { email: "new@example.test" } });

    expect(email.provider).toBe("smtp");
    expect(smtpMessages).toHaveLength(1);
    expect(smtpMessages[0]).toMatchObject({ from: "hey@selfhost.example", replyTo: "support@selfhost.example" });
    expect(messages).toHaveLength(0);
  });

  it("is disabled when neither transport is configured", async () => {
    expect(resolveTransactionalEmailProvider({ appBaseUrl: "https://app.example.test" })).toBeUndefined();
    expect(resolveTransactionalEmailProvider({ appBaseUrl: "https://app.example.test", smtp: { url: smtpUrl } })).toBeUndefined();
    const email = createTransactionalEmailService({ appBaseUrl: "https://app.example.test", smtp: { from: "hey@selfhost.example" } });
    expect(email.enabled).toBe(false);
    expect(email.provider).toBeUndefined();
  });
});
