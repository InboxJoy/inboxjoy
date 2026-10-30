import { EmailClient, KnownEmailSendStatus, type EmailMessage } from "@azure/communication-email";
import { ManagedIdentityCredential } from "@azure/identity";
import nodemailer from "nodemailer";

export type TransactionalEmailRecipient = {
  email: string;
  name?: string | null;
};

export type WelcomeEmailInput = {
  recipient: TransactionalEmailRecipient;
};

export type PasswordResetEmailInput = {
  recipient: TransactionalEmailRecipient;
  resetUrl: string;
  expiresInMinutes: number;
};

export type SequenceTestEmailInput = {
  recipient: TransactionalEmailRecipient;
  subject: string;
  plainText: string;
  html?: string;
};

export type WorkspaceInviteEmailInput = {
  recipient: TransactionalEmailRecipient;
  inviterName: string;
  workspaceName: string;
  role: "admin" | "member";
  acceptUrl: string;
  expiresAt: Date;
};

export type TrialEndingEmailInput = {
  recipient: TransactionalEmailRecipient;
  daysLeft: number;
  trialEndDate: string;
  amountLabel: string;
};

export type PaymentSucceededEmailInput = {
  recipient: TransactionalEmailRecipient;
  planLabel: string;
  amountLabel: string;
  nextBillingDate?: string;
};

export type PaymentFailedEmailInput = {
  recipient: TransactionalEmailRecipient;
  planLabel: string;
  graceEndsAt: string;
};

export type MailboxAlertEmailInput = {
  recipient: TransactionalEmailRecipient;
  mailboxEmail: string;
  reasonSentence: string;
};

export type CampaignCompletedEmailInput = {
  recipient: TransactionalEmailRecipient;
  campaignName: string;
  campaignId: string;
  sent: number;
  opened: number;
  replied: number;
};

export type ReplyReceivedEmailInput = {
  recipient: TransactionalEmailRecipient;
  contactLabel: string;
  campaignName: string;
  campaignId: string;
  mailboxEmail: string;
};

export type TransactionalEmailProvider = "azure-communication-email" | "smtp";

export interface TransactionalEmailService {
  readonly enabled: boolean;
  readonly senderAddress?: string;
  // Which transport delivers system email; undefined while it is disabled.
  readonly provider?: TransactionalEmailProvider;
  sendWelcome(input: WelcomeEmailInput): Promise<void>;
  sendPasswordReset(input: PasswordResetEmailInput): Promise<void>;
  sendWorkspaceInvite(input: WorkspaceInviteEmailInput): Promise<void>;
  sendSequenceTest(input: SequenceTestEmailInput): Promise<void>;
  sendTrialEnding(input: TrialEndingEmailInput): Promise<void>;
  sendPaymentSucceeded(input: PaymentSucceededEmailInput): Promise<void>;
  sendPaymentFailed(input: PaymentFailedEmailInput): Promise<void>;
  sendMailboxAlert(input: MailboxAlertEmailInput): Promise<void>;
  sendCampaignCompleted(input: CampaignCompletedEmailInput): Promise<void>;
  sendReplyReceived(input: ReplyReceivedEmailInput): Promise<void>;
}

export interface AzureEmailClient {
  beginSend(
    message: EmailMessage,
    options?: Parameters<EmailClient["beginSend"]>[1],
  ): Promise<{ pollUntilDone(): Promise<{ status: string }> }>;
}

export type AzureTransactionalEmailOptions = {
  endpoint: string;
  senderAddress: string;
  appBaseUrl: string;
  managedIdentityClientId?: string;
  replyToAddress?: string;
  // Footer postal line. Only the managed cloud edition sets one (POSTAL_ADDRESS_LINE).
  postalAddressLine?: string;
  sendTimeoutMs?: number;
};

export type AzureTransactionalEmailDependencies = {
  client?: AzureEmailClient;
};

export type SmtpTransactionalMessage = {
  from: string;
  to: string | { name: string; address: string };
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
};

export interface SmtpTransactionalTransport {
  sendMail(message: SmtpTransactionalMessage): Promise<unknown>;
}

export type SmtpTransactionalEmailOptions = {
  // smtps://user:pass@host:465 (implicit TLS) or smtp://user:pass@host:587 (STARTTLS).
  // Carries the password, so it is never logged or echoed in errors.
  smtpUrl: string;
  // "hey@example.com" or "InboxJoy <hey@example.com>".
  from: string;
  appBaseUrl: string;
  replyToAddress?: string;
  postalAddressLine?: string;
  sendTimeoutMs?: number;
};

export type SmtpTransactionalEmailDependencies = {
  transport?: SmtpTransactionalTransport;
};

const defaultSendTimeoutMs = 60_000;
const smtpConnectTimeoutMs = 30_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function recipientDisplayName(recipient: TransactionalEmailRecipient): string | undefined {
  return recipient.name?.replace(/[\r\n]+/g, " ").trim() || undefined;
}

function recipientName(recipient: TransactionalEmailRecipient): string {
  return recipientDisplayName(recipient) ?? "there";
}

// The managed cloud edition's CAN-SPAM postal line. Self-hosted installs show
// no postal line unless their wiring passes one.
export const POSTAL_ADDRESS_LINE = "Shipping solo from — Dubai Founder HQ, Dubai, United Arab Emirates";

type RenderedEmail = { subject: string; plainText: string; html: string };

// What every system email needs to know about the install that sends it. The
// logo is served by the web app itself, so it follows WEB_BASE_URL like the links.
type EmailBranding = {
  appBaseUrl: string;
  logoUrl: string;
  postalAddressLine?: string;
};

function emailBranding(appBaseUrl: string, postalAddressLine?: string): EmailBranding {
  return {
    appBaseUrl,
    logoUrl: new URL("/brand/icon-64x64.png", appBaseUrl).toString(),
    postalAddressLine: postalAddressLine?.trim() || undefined,
  };
}

/**
 * Branded email chrome. Table-and-inline-styles only: Outlook ignores flexbox,
 * grid and background-image. `footerLink` carries the preferences link for
 * notification mail; authentication mail (reset, verification) omits it because
 * those are required transactional messages.
 */
function emailShell(
  branding: EmailBranding,
  preheader: string,
  heading: string,
  content: string,
  action?: { label: string; url: string },
  footerLink?: { label: string; url: string },
  afterActionContent = "",
): string {
  const button = action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(action.url)}" style="background:#7c6cf0;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:999px;display:inline-block;font-weight:700;font-size:15px">${escapeHtml(action.label)}</a></p>`
    : "";
  const preferences = footerLink
    ? `<p style="margin:0 0 6px;color:#9a93b8;font-size:12px;line-height:1.5"><a href="${escapeHtml(footerLink.url)}" style="color:#9a93b8;text-decoration:underline">${escapeHtml(footerLink.label)}</a></p>`
    : "";
  const postalAddress = branding.postalAddressLine
    ? `<p style="margin:0;color:#9a93b8;font-size:12px;line-height:1.5">${escapeHtml(branding.postalAddressLine)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#16141f">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:32px 16px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:32px">
          <tr><td>
            <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px">
              <tr>
                <td style="padding-right:10px" valign="middle"><img src="${escapeHtml(branding.logoUrl)}" width="36" height="36" alt="InboxJoy" style="display:block;border:0;border-radius:9px"></td>
                <td valign="middle"><span style="font-size:20px;font-weight:700;color:#16141f">InboxJoy</span></td>
              </tr>
            </table>
            <h1 style="margin:0 0 16px;font-size:26px;line-height:1.3;color:#16141f">${escapeHtml(heading)}</h1>
            ${content}
            ${button}
            ${afterActionContent}
          </td></tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;padding:20px 8px 0">
          <tr><td align="center">
            ${preferences}
            ${postalAddress}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function p(text: string, opts: { last?: boolean; muted?: boolean } = {}): string {
  const margin = opts.last ? "margin:0" : "margin:0 0 16px";
  const color = opts.muted ? "color:#5f5b73" : "color:#16141f";
  const size = opts.muted ? "font-size:14px" : "font-size:16px";
  return `<p style="${margin};${color};${size};line-height:1.6">${text}</p>`;
}

function preferencesLink(appBaseUrl: string): { label: string; url: string } {
  return { label: "Manage email preferences", url: new URL("/app/settings", appBaseUrl).toString() };
}

function welcomeMessage(input: WelcomeEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const appUrl = new URL("/app", branding.appBaseUrl).toString();
  return {
    subject: "Welcome to InboxJoy",
    plainText: `Your workspace is ready. Three steps to your first campaign:\n\n1. Connect Gmail or Outlook. One click, and you send from your real address.\n2. Import contacts. Upload a CSV or paste a list.\n3. Let AI draft the sequence, then launch.\n\nMost people send their first campaign the same day.\n\nReply to this email if you get stuck. It reaches a person.\n\nOpen InboxJoy: ${appUrl}\n\nInboxJoy`,
    html: emailShell(
      branding,
      "Three steps to your first campaign.",
      `Welcome, ${name}`,
      [
        p("Your workspace is ready. Three steps to your first campaign:"),
        `<ol style="margin:0 0 16px;padding-left:20px;color:#16141f;font-size:16px;line-height:1.6">` +
          `<li style="margin:0 0 8px">Connect Gmail or Outlook. One click, and you send from your real address.</li>` +
          `<li style="margin:0 0 8px">Import contacts. Upload a CSV or paste a list.</li>` +
          `<li style="margin:0">Let AI draft the sequence, then launch.</li>` +
        `</ol>`,
        p("Most people send their first campaign the same day."),
        p("Reply to this email if you get stuck. It reaches a person.", { last: true }),
      ].join(""),
      { label: "Open InboxJoy", url: appUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

function workspaceInviteMessage(input: WorkspaceInviteEmailInput, branding: EmailBranding): RenderedEmail {
  const subjectName = (value: string): string => value.replace(/[\r\n]/g, "").slice(0, 80);
  const role = input.role === "admin" ? "an admin" : "a member";
  const introduction = `${input.inviterName} invited you to join ${input.workspaceName} on InboxJoy as ${role}.`;
  const instructions = `Sign in or create your account with ${input.recipient.email} to join. This link works for 7 days.`;
  return {
    subject: `${subjectName(input.inviterName)} invited you to ${subjectName(input.workspaceName)} on InboxJoy`,
    plainText: `${introduction}\n\nAccept invitation: ${input.acceptUrl}\n\n${instructions}\n\nInboxJoy`,
    html: emailShell(
      branding,
      introduction,
      "You're invited to a workspace",
      p(escapeHtml(introduction)),
      { label: "Accept invitation", url: input.acceptUrl },
      undefined,
      p(escapeHtml(instructions), { last: true }),
    ),
  };
}

function passwordResetMessage(input: PasswordResetEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const expiration = `${input.expiresInMinutes} minutes`;
  return {
    subject: "Reset your InboxJoy password",
    plainText: `Hi ${name},\n\nWe received a request to reset your InboxJoy password. Use the secure link below within ${expiration}:\n\n${input.resetUrl}\n\nIf you did not request this, you can ignore this email. Your password will not change.\n\nInboxJoy`,
    html: emailShell(
      branding,
      "Use this secure link to reset your InboxJoy password.",
      "Reset your password",
      `<p style="margin:0 0 16px;color:#16141f;font-size:16px;line-height:1.6">Hi ${escapeHtml(name)},</p><p style="margin:0;color:#16141f;font-size:16px;line-height:1.6">We received a request to reset your InboxJoy password. This link expires in ${escapeHtml(expiration)}.</p><p style="margin:20px 0 0;color:#5f5b73;font-size:14px;line-height:1.5">If you did not request this, you can ignore this email. Your password will not change.</p>`,
      { label: "Reset password", url: input.resetUrl },
    ),
  };
}

function trialEndingMessage(input: TrialEndingEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const billingUrl = new URL("/app/settings/billing", branding.appBaseUrl).toString();
  return {
    subject: `Your InboxJoy trial ends in ${input.daysLeft} days`,
    plainText: `Hi ${name},\n\nYour 7-day trial ends on ${input.trialEndDate}. After that your card is charged ${input.amountLabel} and your campaigns keep sending. There is nothing to do if you want to continue.\n\nTo cancel, open Settings, then Billing. You keep full access until the trial ends, and nothing is deleted if you stop.\n\nManage billing: ${billingUrl}\n\nInboxJoy`,
    html: emailShell(
      branding,
      `Your card is charged on ${input.trialEndDate} unless you cancel.`,
      `Your trial ends ${input.trialEndDate}`,
      [
        p(`Hi ${escapeHtml(name)},`),
        p(`Your 7-day trial ends on ${escapeHtml(input.trialEndDate)}. After that your card is charged ${escapeHtml(input.amountLabel)} and your campaigns keep sending. There is nothing to do if you want to continue.`),
        p("To cancel, open Settings, then Billing. You keep full access until the trial ends, and nothing is deleted if you stop.", { last: true }),
      ].join(""),
      { label: "Manage billing", url: billingUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

function paymentSucceededMessage(input: PaymentSucceededEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const billingUrl = new URL("/app/settings/billing", branding.appBaseUrl).toString();
  const nextChargeLine = input.nextBillingDate ? `Next charge: ${input.nextBillingDate}.` : undefined;
  return {
    subject: `Payment received — InboxJoy ${input.planLabel}`,
    plainText: [
      `Hi ${name},`,
      `We received ${input.amountLabel} for InboxJoy ${input.planLabel}.`,
      ...(nextChargeLine ? [nextChargeLine] : []),
      `View billing: ${billingUrl}`,
      "InboxJoy",
    ].join("\n\n"),
    html: emailShell(
      branding,
      input.nextBillingDate ? `${input.amountLabel} paid. Next charge ${input.nextBillingDate}.` : `${input.amountLabel} paid.`,
      "Payment received",
      [
        p(`Hi ${escapeHtml(name)},`),
        p(`We received ${escapeHtml(input.amountLabel)} for InboxJoy ${escapeHtml(input.planLabel)}.`, { last: !nextChargeLine }),
        ...(nextChargeLine ? [p(`Next charge: ${escapeHtml(input.nextBillingDate!)}.`, { last: true })] : []),
      ].join(""),
      { label: "View billing", url: billingUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

function paymentFailedMessage(input: PaymentFailedEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const billingUrl = new URL("/app/settings/billing", branding.appBaseUrl).toString();
  return {
    subject: `Payment failed — sending pauses ${input.graceEndsAt}`,
    plainText: `Hi ${name},\n\nThe payment for InboxJoy ${input.planLabel} did not go through.\n\nYour campaigns keep sending until ${input.graceEndsAt}. After that, sending pauses until a payment succeeds. Your campaigns, contacts and settings are kept either way.\n\nUpdate payment method: ${billingUrl}\n\nInboxJoy`,
    html: emailShell(
      branding,
      "Update your card to keep campaigns running.",
      "We could not process your payment",
      [
        p(`Hi ${escapeHtml(name)},`),
        p(`The payment for InboxJoy ${escapeHtml(input.planLabel)} did not go through.`),
        p(`Your campaigns keep sending until ${escapeHtml(input.graceEndsAt)}. After that, sending pauses until a payment succeeds. Your campaigns, contacts and settings are kept either way.`, { last: true }),
      ].join(""),
      { label: "Update payment method", url: billingUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

function mailboxAlertMessage(input: MailboxAlertEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const inboxesUrl = new URL("/app/inboxes", branding.appBaseUrl).toString();
  return {
    subject: `${input.mailboxEmail} stopped sending`,
    plainText: `Hi ${name},\n\nInboxJoy stopped sending from ${input.mailboxEmail}.\n\nReason: ${input.reasonSentence}\n\nCampaigns that use this inbox are paused for it. Your other inboxes keep sending on schedule.\n\nReconnect inbox: ${inboxesUrl}\n\nInboxJoy`,
    html: emailShell(
      branding,
      "Reconnect this inbox to resume its campaigns.",
      "An inbox stopped sending",
      [
        p(`Hi ${escapeHtml(name)},`),
        p(`InboxJoy stopped sending from ${escapeHtml(input.mailboxEmail)}.`),
        p(`Reason: ${escapeHtml(input.reasonSentence)}`),
        p("Campaigns that use this inbox are paused for it. Your other inboxes keep sending on schedule.", { last: true }),
      ].join(""),
      { label: "Reconnect inbox", url: inboxesUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

function campaignCompletedMessage(input: CampaignCompletedEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const reportUrl = new URL(`/app/sequences/${encodeURIComponent(input.campaignId)}`, branding.appBaseUrl).toString();
  return {
    subject: `Campaign finished: ${input.campaignName}`,
    plainText: `Hi ${name},\n\nEvery contact in this campaign has finished the sequence or replied.\n\nSent ${input.sent} · Opened ${input.opened} · Replied ${input.replied}\n\nView report: ${reportUrl}\n\nInboxJoy`,
    html: emailShell(
      branding,
      `${input.sent} sent, ${input.replied} replies.`,
      `${input.campaignName} finished`,
      [
        p(`Hi ${escapeHtml(name)},`),
        p("Every contact in this campaign has finished the sequence or replied."),
        p(`Sent ${escapeHtml(String(input.sent))} · Opened ${escapeHtml(String(input.opened))} · Replied ${escapeHtml(String(input.replied))}`, { last: true }),
      ].join(""),
      { label: "View report", url: reportUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

function replyReceivedMessage(input: ReplyReceivedEmailInput, branding: EmailBranding): RenderedEmail {
  const name = recipientName(input.recipient);
  const campaignUrl = new URL(`/app/sequences/${encodeURIComponent(input.campaignId)}`, branding.appBaseUrl).toString();
  return {
    subject: `${input.contactLabel} replied to ${input.campaignName}`,
    plainText: `Hi ${name},\n\n${input.contactLabel} replied to ${input.campaignName}.\n\nThe reply is in your ${input.mailboxEmail} inbox. Their remaining follow-ups stopped automatically, so nobody gets a follow-up after replying.\n\nView campaign: ${campaignUrl}\n\nInboxJoy`,
    html: emailShell(
      branding,
      "Follow-ups for this contact have stopped.",
      "You got a reply",
      [
        p(`Hi ${escapeHtml(name)},`),
        p(`${escapeHtml(input.contactLabel)} replied to ${escapeHtml(input.campaignName)}.`),
        p(`The reply is in your ${escapeHtml(input.mailboxEmail)} inbox. Their remaining follow-ups stopped automatically, so nobody gets a follow-up after replying.`, { last: true }),
      ].join(""),
      { label: "View campaign", url: campaignUrl },
      preferencesLink(branding.appBaseUrl),
    ),
  };
}

export const disabledTransactionalEmailService: TransactionalEmailService = {
  enabled: false,
  async sendWelcome() {},
  async sendPasswordReset() {},
  async sendWorkspaceInvite() {},
  async sendSequenceTest() {},
  async sendTrialEnding() {},
  async sendPaymentSucceeded() {},
  async sendPaymentFailed() {},
  async sendMailboxAlert() {},
  async sendCampaignCompleted() {},
  async sendReplyReceived() {},
};

type DeliverEmail = (recipient: TransactionalEmailRecipient, content: RenderedEmail) => Promise<void>;

// Renders every template once and hands the result to a transport, so ACS and
// SMTP send byte-identical subjects and bodies.
function renderedEmailService(
  identity: { senderAddress: string; provider: TransactionalEmailProvider },
  branding: EmailBranding,
  deliver: DeliverEmail,
): TransactionalEmailService {
  async function send(recipient: TransactionalEmailRecipient, content: RenderedEmail): Promise<void> {
    // CAN-SPAM requires the postal address in the text part too; the HTML part
    // carries it via emailShell's footer.
    const postalLine = branding.postalAddressLine;
    const withPostalAddress = !postalLine || content.plainText.includes(postalLine)
      ? content
      : { ...content, plainText: `${content.plainText}\n\n${postalLine}` };
    await deliver(recipient, withPostalAddress);
  }

  return {
    enabled: true,
    senderAddress: identity.senderAddress,
    provider: identity.provider,
    async sendWelcome(input) {
      await send(input.recipient, welcomeMessage(input, branding));
    },
    async sendPasswordReset(input) {
      await send(input.recipient, passwordResetMessage(input, branding));
    },
    async sendWorkspaceInvite(input) {
      await send(input.recipient, workspaceInviteMessage(input, branding));
    },
    async sendSequenceTest(input) {
      await send(input.recipient, {
        subject: input.subject,
        plainText: input.plainText,
        html: input.html ?? "<pre style=\"white-space:pre-wrap;font-family:Arial,sans-serif\">" + escapeHtml(input.plainText) + "</pre>",
      });
    },
    async sendTrialEnding(input) {
      await send(input.recipient, trialEndingMessage(input, branding));
    },
    async sendPaymentSucceeded(input) {
      await send(input.recipient, paymentSucceededMessage(input, branding));
    },
    async sendPaymentFailed(input) {
      await send(input.recipient, paymentFailedMessage(input, branding));
    },
    async sendMailboxAlert(input) {
      await send(input.recipient, mailboxAlertMessage(input, branding));
    },
    async sendCampaignCompleted(input) {
      await send(input.recipient, campaignCompletedMessage(input, branding));
    },
    async sendReplyReceived(input) {
      await send(input.recipient, replyReceivedMessage(input, branding));
    },
  };
}

export function createAzureTransactionalEmailService(
  options: AzureTransactionalEmailOptions,
  dependencies: AzureTransactionalEmailDependencies = {},
): TransactionalEmailService {
  const credential = options.managedIdentityClientId
    ? new ManagedIdentityCredential(options.managedIdentityClientId)
    : new ManagedIdentityCredential();
  const client = dependencies.client ?? new EmailClient(options.endpoint, credential);
  const replyTo = options.replyToAddress ? [{ address: options.replyToAddress }] : undefined;
  const sendTimeoutMs = options.sendTimeoutMs ?? defaultSendTimeoutMs;

  return renderedEmailService(
    { senderAddress: options.senderAddress, provider: "azure-communication-email" },
    emailBranding(options.appBaseUrl, options.postalAddressLine),
    async (recipient, content) => {
      const displayName = recipientDisplayName(recipient);
      const message: EmailMessage = {
        senderAddress: options.senderAddress,
        recipients: {
          to: [{
            address: recipient.email,
            ...(displayName ? { displayName } : {}),
          }],
        },
        content,
        ...(replyTo ? { replyTo } : {}),
        disableUserEngagementTracking: true,
      };
      const poller = await client.beginSend(message, {
        abortSignal: AbortSignal.timeout(sendTimeoutMs),
        updateIntervalInMs: 1_000,
      });
      const result = await poller.pollUntilDone();
      if (result.status !== KnownEmailSendStatus.Succeeded) {
        throw new Error(`Azure Communication Services Email send ended with status ${result.status}.`);
      }
    },
  );
}

// "InboxJoy <hey@example.com>" -> "hey@example.com"; a bare address is returned as is.
export function mailFromAddress(from: string): string {
  const match = /<([^<>]+)>\s*$/.exec(from);
  return (match?.[1] ?? from).trim();
}

// Strips the SMTP URL and its decoded password from a transport error message,
// so a misbehaving server or library can never put the credential in a log line.
function redactSmtpSecrets(message: string, smtpUrl: string): string {
  const secrets = new Set<string>([smtpUrl]);
  try {
    const url = new URL(smtpUrl);
    if (url.password) {
      secrets.add(url.password);
      secrets.add(decodeURIComponent(url.password));
    }
  } catch {
    // An unparseable URL never reaches here in practice: config validates it.
  }
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

export function createSmtpTransactionalEmailService(
  options: SmtpTransactionalEmailOptions,
  dependencies: SmtpTransactionalEmailDependencies = {},
): TransactionalEmailService {
  const sendTimeoutMs = options.sendTimeoutMs ?? defaultSendTimeoutMs;
  const transport: SmtpTransactionalTransport = dependencies.transport ?? nodemailer.createTransport({
    url: options.smtpUrl,
    connectionTimeout: Math.min(smtpConnectTimeoutMs, sendTimeoutMs),
    greetingTimeout: Math.min(smtpConnectTimeoutMs, sendTimeoutMs),
    socketTimeout: sendTimeoutMs,
  });

  return renderedEmailService(
    { senderAddress: mailFromAddress(options.from), provider: "smtp" },
    emailBranding(options.appBaseUrl, options.postalAddressLine),
    async (recipient, content) => {
      const displayName = recipientDisplayName(recipient);
      try {
        await transport.sendMail({
          from: options.from,
          to: displayName ? { name: displayName, address: recipient.email } : recipient.email,
          ...(options.replyToAddress ? { replyTo: options.replyToAddress } : {}),
          subject: content.subject,
          text: content.plainText,
          html: content.html,
        });
      } catch (error) {
        const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? ` (${(error as { code: string }).code})`
          : "";
        const detail = error instanceof Error ? error.message : String(error);
        // A fresh error with no `cause`: the original can carry transport options.
        throw new Error(`SMTP system email send failed${code}: ${redactSmtpSecrets(detail, options.smtpUrl)}`);
      }
    },
  );
}

export type TransactionalEmailSettings = {
  // WEB_BASE_URL: links and the logo in every email point here.
  appBaseUrl: string;
  postalAddressLine?: string;
  azure?: {
    endpoint?: string;
    senderAddress?: string;
    managedIdentityClientId?: string;
    replyToAddress?: string;
  };
  smtp?: {
    url?: string;
    from?: string;
    replyToAddress?: string;
  };
};

/**
 * Azure Communication Services when its endpoint and sender are both set (our
 * managed cloud), otherwise SMTP when MAIL_SMTP_URL and MAIL_FROM are set,
 * otherwise none (system email disabled; local development only).
 */
export function resolveTransactionalEmailProvider(settings: TransactionalEmailSettings): TransactionalEmailProvider | undefined {
  if (settings.azure?.endpoint && settings.azure.senderAddress) return "azure-communication-email";
  if (settings.smtp?.url && settings.smtp.from) return "smtp";
  return undefined;
}

export function createTransactionalEmailService(
  settings: TransactionalEmailSettings,
  dependencies: AzureTransactionalEmailDependencies & SmtpTransactionalEmailDependencies = {},
): TransactionalEmailService {
  const { azure, smtp } = settings;
  if (azure?.endpoint && azure.senderAddress) {
    return createAzureTransactionalEmailService({
      endpoint: azure.endpoint,
      senderAddress: azure.senderAddress,
      appBaseUrl: settings.appBaseUrl,
      managedIdentityClientId: azure.managedIdentityClientId,
      replyToAddress: azure.replyToAddress,
      postalAddressLine: settings.postalAddressLine,
    }, { client: dependencies.client });
  }
  if (smtp?.url && smtp.from) {
    return createSmtpTransactionalEmailService({
      smtpUrl: smtp.url,
      from: smtp.from,
      appBaseUrl: settings.appBaseUrl,
      replyToAddress: smtp.replyToAddress,
      postalAddressLine: settings.postalAddressLine,
    }, { transport: dependencies.transport });
  }
  return disabledTransactionalEmailService;
}
