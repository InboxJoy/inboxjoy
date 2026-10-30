import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export { campaignMime, type CampaignMimeInput } from "./campaign-mime.js";
export { replyMime, type ReplyMimeInput } from "./reply-mime.js";

export {
  createAzureTransactionalEmailService,
  createSmtpTransactionalEmailService,
  createTransactionalEmailService,
  disabledTransactionalEmailService,
  mailFromAddress,
  POSTAL_ADDRESS_LINE,
  resolveTransactionalEmailProvider,
  type AzureEmailClient,
  type AzureTransactionalEmailDependencies,
  type AzureTransactionalEmailOptions,
  type CampaignCompletedEmailInput,
  type MailboxAlertEmailInput,
  type PasswordResetEmailInput,
  type PaymentFailedEmailInput,
  type PaymentSucceededEmailInput,
  type ReplyReceivedEmailInput,
  type SequenceTestEmailInput,
  type SmtpTransactionalEmailDependencies,
  type SmtpTransactionalEmailOptions,
  type SmtpTransactionalMessage,
  type SmtpTransactionalTransport,
  type TransactionalEmailProvider,
  type TransactionalEmailRecipient,
  type TransactionalEmailService,
  type TransactionalEmailSettings,
  type TrialEndingEmailInput,
  type WelcomeEmailInput,
  type WorkspaceInviteEmailInput,
} from "./transactional.js";

export type UnsubscribeClaims = {
  workspaceId: string;
  contactId: string;
  normalizedEmail: string;
  expiresAt: number;
};

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createUnsubscribeToken(input: Omit<UnsubscribeClaims, "expiresAt"> & { expiresAt?: number }, secret: string): string {
  const claims: UnsubscribeClaims = { ...input, expiresAt: input.expiresAt ?? Date.now() + 365 * 86_400_000 };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string, now = Date.now()): UnsubscribeClaims | null {
  const [payload, provided, extra] = token.split(".");
  if (!payload || !provided || extra) return null;
  const expected = signature(payload, secret);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<UnsubscribeClaims>;
    if (typeof claims.workspaceId !== "string" || typeof claims.contactId !== "string" || typeof claims.normalizedEmail !== "string" || typeof claims.expiresAt !== "number" || claims.expiresAt < now) return null;
    return claims as UnsubscribeClaims;
  } catch {
    return null;
  }
}

export function unsubscribeTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function escapeEmailHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// Legacy Free footer credit. Only campaign sends
// from hosted workspaces still inside their legacy Free window carry it
// (sendingPlan "legacy_free"); licensed, comped and self-hosted sends never do.
export const SENT_VIA_INBOXJOY_URL = "https://inboxjoy.online/?utm_source=sent-via&utm_medium=email";
const SENT_VIA_INBOXJOY_LINE = `Sent via InboxJoy: ${SENT_VIA_INBOXJOY_URL}`;

export type OutreachFooterOptions = { sentVia?: boolean };

/** HTML part for an outreach email: the plain-text unsubscribe footer becomes small grey text with a linked "Unsubscribe". */
export function renderEmailHtml(body: string, unsubscribeUrl: string | undefined, trackingUrl?: string, postalAddress?: string | null, options: OutreachFooterOptions = {}): string {
  const footerMarker = "\n\n---\n";
  const footerIndex = unsubscribeUrl && body.lastIndexOf(footerMarker) >= 0 && body.slice(body.lastIndexOf(footerMarker)).includes(`Unsubscribe: ${unsubscribeUrl}`)
    ? body.lastIndexOf(footerMarker)
    : -1;
  const withoutFooter = footerIndex >= 0 ? body.slice(0, footerIndex) : body;
  const paragraphs = withoutFooter.trim().split(/\n\s*\n/).filter(Boolean).map((paragraph) => `<p style="margin:0 0 16px">${escapeEmailHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
  const address = postalAddress?.trim();
  const footer = unsubscribeUrl ? `<p style="margin:24px 0 0;color:#666;font-size:12px">${address ? `${escapeEmailHtml(address).replaceAll("\n", "<br>")}<br>` : ""}Prefer not to receive these emails? <a href="${escapeEmailHtml(unsubscribeUrl)}" style="color:#666">Unsubscribe</a>.</p>` : "";
  const sentVia = options.sentVia ? `<p style="margin:8px 0 0;color:#999;font-size:11px">Sent via <a href="${escapeEmailHtml(SENT_VIA_INBOXJOY_URL)}" style="color:#999">InboxJoy</a></p>` : "";
  const pixel = trackingUrl ? `<img src="${escapeEmailHtml(trackingUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />` : "";
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111">${paragraphs}${footer}${sentVia}${pixel}</body></html>`;
}

export function appendUnsubscribeFooter(body: string, unsubscribeUrl: string, postalAddress?: string | null, options: OutreachFooterOptions = {}): string {
  const footerMarker = "\n\n---\n";
  const previousFooterIndex = body.lastIndexOf(footerMarker);
  const withoutPreviousFooter = previousFooterIndex >= 0 && body.slice(previousFooterIndex).includes(`Unsubscribe: ${unsubscribeUrl}`)
    ? body.slice(0, previousFooterIndex)
    : body;
  const clean = withoutPreviousFooter.trimEnd();
  const address = postalAddress?.trim();
  return `${clean}${footerMarker}${address ? `${address}\n` : ""}Prefer not to receive these emails? Unsubscribe: ${unsubscribeUrl}${options.sentVia ? `\n${SENT_VIA_INBOXJOY_LINE}` : ""}`;
}

// Every inbound reply quotes the email it answers, so intent classification and thread
// display both need the line where the person's own text ends and the quoted history
// begins. Shared here so the webhook classifier and the replies API split on the exact
// same markers.
//
// Each marker is anchored with `^[ \t]*` rather than `^\s*`: under the `m` flag `\s*` can
// cross newlines, which made matching quadratic on whitespace-heavy bodies (100k blank
// lines blocked the event loop for ~50 s). Horizontal whitespace only keeps every match
// within its own line.
export const QUOTE_MARKERS = [
  /^[ \t]*[-_]{2,}[ \t]*$/m,
  /^[ \t]*>{1,}/m,
  /^[ \t]*\*?From:\*?\s/mi,
  /^[ \t]*On .{0,120}\bwrote:/mi,
  /^[ \t]*-+[ \t]*Original Message[ \t]*-+/mi,
  /^[ \t]*Sent from my /mi,
];

/**
 * Only this many characters of a reply are scanned for quote markers. Real replies put the
 * person's new text at the top, so anything past this point is quoted history by construction;
 * bounding the scan keeps hostile multi-megabyte bodies from stalling the worker.
 */
export const QUOTE_SCAN_LIMIT = 32 * 1024;

/** Splits a reply body into the person's new text and the quoted email history below it. */
export function splitQuotedReply(body: string): { text: string; quoted: string | null } {
  const head = body.length > QUOTE_SCAN_LIMIT ? body.slice(0, QUOTE_SCAN_LIMIT) : body;
  let cut = head.length;
  for (const marker of QUOTE_MARKERS) {
    const found = head.match(marker);
    if (found?.index !== undefined && found.index < cut) cut = found.index;
  }
  const text = head.slice(0, cut).trim();
  const quoted = body.slice(cut).trim();
  return { text, quoted: quoted ? quoted : null };
}

export function stripQuotedReply(body: string): string {
  return splitQuotedReply(body).text;
}
