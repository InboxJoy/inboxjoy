import { stripQuotedReply } from "@inboxjoy/email";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// An address may only start where a run of local-part characters starts. Without
// the lookbehind, a long run with no "@" is rescanned from every position (quadratic):
// one crafted bounce body of a few hundred KB froze the reply worker for minutes.
const EMAIL_PATTERN = String.raw`(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`;
const EMAIL_RE = new RegExp(EMAIL_PATTERN, "i");
const EMAILS_RE = new RegExp(EMAIL_PATTERN, "gi");

function emailFrom(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string") {
    const match = value.match(EMAIL_RE);
    return match?.[0]?.toLowerCase();
  }
  if (Array.isArray(value)) return value.map((item) => emailFrom(item, depth + 1)).find(Boolean);
  const item = record(value);
  return emailFrom(item.emailAddress, depth + 1) ?? emailFrom(item.email_address, depth + 1) ?? emailFrom(item.address, depth + 1) ?? emailFrom(item.email, depth + 1) ?? emailFrom(item.value, depth + 1);
}

function normalizedEmailFrom(value: unknown): string | undefined {
  return emailFrom(value)?.trim().toLowerCase();
}

function emailsFrom(value: unknown, emails = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8) return emails;
  if (typeof value === "string") {
    for (const match of value.matchAll(EMAILS_RE)) emails.add(match[0].toLowerCase());
    return emails;
  }
  if (Array.isArray(value)) {
    for (const item of value) emailsFrom(item, emails, depth + 1);
    return emails;
  }
  for (const item of Object.values(record(value))) emailsFrom(item, emails, depth + 1);
  return emails;
}

function payloadText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => payloadText(item, depth + 1)).join(" ");
  return Object.values(record(value)).map((item) => payloadText(item, depth + 1)).join(" ");
}

function deliverySignalText(value: unknown, depth = 0): string {
  if (depth > 8 || !value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map((item) => deliverySignalText(item, depth + 1)).join(" ");

  const parts: string[] = [];
  for (const [key, item] of Object.entries(record(value))) {
    if (/status|smtp|dsn|diagnostic|response|reason|error|subject|event|type|action|category|body|text|message|content|description|summary/i.test(key)) {
      parts.push(payloadText(item, depth + 1));
    } else if (item && typeof item === "object") {
      parts.push(deliverySignalText(item, depth + 1));
    }
  }
  return parts.join(" ");
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasEvidenceField(value: unknown, keyPattern: RegExp, valuePattern: RegExp, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasEvidenceField(item, keyPattern, valuePattern, depth + 1));

  for (const [key, item] of Object.entries(record(value))) {
    const child = record(item);
    if (keyPattern.test(normalizedKey(key)) && valuePattern.test(payloadText(item).toLowerCase())) return true;
    if (Object.keys(child).length && hasEvidenceField(child, keyPattern, valuePattern, depth + 1)) return true;
    if (Array.isArray(item) && hasEvidenceField(item, keyPattern, valuePattern, depth + 1)) return true;
  }
  return false;
}

function hasCredibleBounceEvidence(payload: Record<string, unknown>, eventType: string, triggerSlug: string): boolean {
  const routeText = `${eventType} ${triggerSlug}`.toLowerCase();
  const signalText = deliverySignalText(payload).toLowerCase();
  const bounceSignal = /\bbounc(?:e|ed)\b|\bndr\b|non[-_.\s]?delivery|delivery[-_.\s]?(?:status|failure|failed)|undeliverable/.test(routeText);
  const sender = normalizedEmailFrom(record(payload.data).from) ?? normalizedEmailFrom(payload.from) ?? normalizedEmailFrom(payload.sender);
  if (bounceSignal || /^(?:mailer-daemon|postmaster)@/.test(sender ?? "")) return true;
  return hasEvidenceField(payload, /^(?:dsn|diagnostic|diagnosticcode|smtp|smtpresponse|enhancedstatus|status|action|finalrecipient|originalrecipient|bounce|bouncedrecipients|failedrecipients)$/, /\b(?:[245]\.\d\.\d|421|450|451|452|550|551|553|554|failed|failure|bounced|undeliverable|notfound|unknown|rejected)\b/);
}

function hasCredibleComplaintEvidence(payload: Record<string, unknown>, eventType: string, triggerSlug: string): boolean {
  const routeText = `${eventType} ${triggerSlug}`.toLowerCase();
  if (/\bcomplaint\b|feedback[-_\s]?loop|abuse[-_\s]?report|spam[-_\s]?report/.test(routeText)) return true;
  return hasEvidenceField(payload, /^(?:complaint|complaints|complainttype|feedbacktype|feedbackloop|abusereport|spamreport|complainedrecipients|complaintrecipients|notificationtype|event|eventtype|category|action|reason)$/, /\bcomplaint\b|feedback[-\s]?loop|reported (?:this message )?as spam|abuse report|spam report/);
}

function addEmailsFromValue(value: unknown, emails: Set<string>): void {
  for (const email of emailsFrom(value)) {
    emails.add(email);
  }
}

function collectStructuredRecipientEmails(value: unknown, kind: "bounce" | "complaint", emails = new Set<string>(), depth = 0, recipientContext = false): Set<string> {
  if (depth > 8 || !value || typeof value !== "object") return emails;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredRecipientEmails(item, kind, emails, depth + 1, recipientContext);
    return emails;
  }

  for (const [key, item] of Object.entries(record(value))) {
    const keyName = normalizedKey(key);
    const container = kind === "bounce"
      ? /^(?:bouncedrecipients|failedrecipients|deliveryrecipients|undeliveredrecipients)$/.test(keyName)
      : /^(?:complainedrecipients|complaintrecipients|feedbackrecipients)$/.test(keyName);
    const direct = /^(?:finalrecipient|originalrecipient|recipient|recipientemail|recipientaddress|failedrecipient|bouncedrecipient|complainedrecipient)$/.test(keyName);
    const contextual = recipientContext && /^(?:email|emailaddress|address|value)$/.test(keyName);

    if (container || direct || contextual) {
      addEmailsFromValue(item, emails);
    }
    collectStructuredRecipientEmails(item, kind, emails, depth + 1, recipientContext || container || direct);
  }
  return emails;
}

// The text is the whole inbound body, so every pattern must stay linear: no two
// adjacent quantifiers that can match the same characters (e.g. "\s*;?\s*").
const DSN_RECIPIENT_PATTERNS = [
  String.raw`(?:final-recipient|original-recipient)\s*:\s*rfc822\s*(?:;\s*)?<?(${EMAIL_PATTERN})>?`,
  String.raw`(?:address|recipient|mailbox|user|email account|email address)\s+<?(${EMAIL_PATTERN})>?.{0,180}\b(?:was\s+)?(?:not found|unknown|unavailable|does not exist|doesn't exist|no longer exists|invalid|rejected)\b`,
  String.raw`<?(${EMAIL_PATTERN})>?.{0,180}\b(?:user unknown|no such user|recipient address rejected|mailbox unavailable|invalid recipient|does not exist|doesn't exist|not found)\b`,
].map((source) => new RegExp(source, "gi"));

function extractContextualDsnRecipientEmails(payload: Record<string, unknown>): string[] {
  const text = deliverySignalText(payload);
  const emails = new Set<string>();
  for (const pattern of DSN_RECIPIENT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) emails.add(match[1].toLowerCase());
    }
  }
  return [...emails];
}

export function suppressibleRecipientEmails(emails: Iterable<string>, mailboxEmail?: string | null): string[] {
  const ownEmail = mailboxEmail?.trim().toLowerCase();
  return [...new Set([...emails].map((email) => email.trim().toLowerCase()).filter(Boolean))]
    .filter((email) => email !== ownEmail && !/^(?:mailer-daemon|postmaster)@/.test(email));
}

export function extractSuppressibleRecipientEmails(payload: Record<string, unknown>, kind: "bounce" | "complaint", mailboxEmail?: string | null): string[] {
  const structured = collectStructuredRecipientEmails(payload, kind);
  const candidates = structured.size ? [...structured] : kind === "bounce" ? extractContextualDsnRecipientEmails(payload) : [];
  return suppressibleRecipientEmails(candidates, mailboxEmail);
}

export function extractMailboxCandidateEmails(data: Record<string, unknown>): string[] {
  const emails = new Set<string>();
  for (const key of ["from", "sender", "to", "toRecipients", "recipients", "deliveredTo", "replyTo"]) {
    addEmailsFromValue(data[key], emails);
  }
  return [...emails];
}

export const bounceClassifications = [
  "hard_bounce",
  "soft_bounce",
  "auto_reply",
  "mailbox_full",
  "domain_not_found",
  "spam_block",
  "rate_limit",
  "policy_rejection",
  "auth_failure",
  "temporary_provider_error",
] as const;

export type BounceClassification = (typeof bounceClassifications)[number];

export type DeliveryStatusBounce = {
  recipient: string;
  action: string;
  status: string;
};

export function classifyDeliveryStatusBounce(bounce: DeliveryStatusBounce): BounceClassification | undefined {
  if (bounce.action.toLowerCase() === "failed" && /^5\.\d+\.\d+$/.test(bounce.status)) return "hard_bounce";
  if (/^(?:failed|delayed)$/i.test(bounce.action) && /^4\.\d+\.\d+$/.test(bounce.status)) return "temporary_provider_error";
  return undefined;
}

const permanentBounceClassifications = new Set<BounceClassification>([
  "hard_bounce",
  "domain_not_found",
  "spam_block",
  "policy_rejection",
]);

export function classifyBounceWebhook(payload: Record<string, unknown>, eventType: string, triggerSlug: string): BounceClassification | undefined {
  if (!hasCredibleBounceEvidence(payload, eventType, triggerSlug)) return undefined;
  const text = `${eventType} ${triggerSlug} ${deliverySignalText(payload)}`.toLowerCase();
  const bounceSignal = /\bbounc(?:e|ed)\b|\bndr\b|non[-\s]?delivery|delivery[-\s]?(?:status|failure|failed)|undeliverable|mailer[-\s]?daemon/.test(text);

  if (/\bout[-\s]?of[-\s]?(?:office|the office)\b|automatic reply|auto[-\s]?reply|vacation responder/.test(text)) return "auto_reply";
  if (/\b(?:4\.2\.2|5\.2\.2|452)\b|mailbox (?:is )?full|quota exceeded|over quota|insufficient storage/.test(text)) return "mailbox_full";
  if (/\b(?:5\.7\.8|535|534)\b|authentication (?:failed|required)|invalid credentials|not authenticated/.test(text)) return "auth_failure";
  if (/\b(?:429|421|4\.7\.\d+)\b|rate limit|too many (?:messages|requests)|throttl|temporarily deferred/.test(text)) return "rate_limit";
  if (/spam(?:haus|cop| block| rejection)|blocklist|blacklist|message rejected as spam/.test(text)) return "spam_block";
  if (/\b5\.7\.\d+\b|policy (?:rejection|violation)|administratively prohibited|not authorized to send/.test(text)) return "policy_rejection";
  if (/\b4\.\d\.\d+\b|\b(?:450|451)\b|temporary failure|try again later|service unavailable|delivery delayed|soft bounce/.test(text)) return "temporary_provider_error";
  if (/\b(?:5\.1\.2|5\.4\.4)\b|domain (?:does not exist|not found|unknown)|host not found|no such domain|unrouteable domain/.test(text)) return "domain_not_found";
  if (/\b(?:5\.1\.0|5\.1\.1|550|551|553)\b|user unknown|unknown recipient|no such user|recipient address rejected|mailbox unavailable|(?:email )?address.{0,160}(?:was )?not found|email account.{0,160}(?:does not|doesn't|no longer) exist|no such (?:email )?address|recipient.{0,120}(?:does not|doesn't|no longer) exist|invalid recipient/.test(text)) return "hard_bounce";
  if (/\b5\.\d\.\d+\b/.test(text)) return "hard_bounce";
  return bounceSignal ? "temporary_provider_error" : undefined;
}

export function isBounceWebhook(payload: Record<string, unknown>, eventType: string, triggerSlug: string): boolean {
  const classification = classifyBounceWebhook(payload, eventType, triggerSlug);
  return classification !== undefined && classification !== "auto_reply";
}

export function isPermanentBounce(classification: BounceClassification): boolean {
  return permanentBounceClassifications.has(classification);
}

export function isComplaintWebhook(payload: Record<string, unknown>, eventType: string, triggerSlug: string): boolean {
  if (!hasCredibleComplaintEvidence(payload, eventType, triggerSlug)) return false;
  const text = `${eventType} ${triggerSlug} ${deliverySignalText(payload)}`.toLowerCase();
  return /\bcomplaint\b|feedback[-\s]?loop|reported (?:this message )?as spam/.test(text);
}

export function extractSenderEmail(data: Record<string, unknown>): string | undefined {
  const senderKeys = ["from", "sender", "from_email", "fromEmail", "sender_email", "senderEmail", "author"];
  for (const key of senderKeys) {
    const email = emailFrom(data[key]);
    if (email) return email;
  }
  for (const [key, value] of Object.entries(data)) {
    if (/^(message|payload|event|body|content)$/i.test(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const email = extractSenderEmail(record(value));
      if (email) return email;
    }
  }
  return undefined;
}

export type ExtractedReplyContent = {
  providerMessageId?: string;
  providerThreadId?: string;
  subject?: string;
  bodyText?: string;
  snippet?: string;
  receivedAt: Date;
};

function identifierValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function decodeHtmlCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
}

function htmlToText(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => decodeHtmlCodePoint(code, 10))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => decodeHtmlCodePoint(code, 16))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function replyBody(value: string, isHtml = false): string | undefined {
  const body = (isHtml || /<\/?[a-z][^>]*>/i.test(value) ? htmlToText(value) : value).trim();
  return body || undefined;
}

function replyDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const raw = stringValue(value);
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return replyDate(Number(raw));
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// An out-of-office or "Thank you for contacting us" autoresponder is not a reply.
// Treating it as one stops the sequence and drops a live prospect, so detection
// leans on RFC headers first and only falls back to the subject line.
//
// The asymmetry matters: calling a HUMAN reply automatic means we keep emailing
// someone who answered -- the exact harm the reply check exists to prevent --
// while calling an autoresponder human merely stops a sequence early, which is
// the behaviour we already had. When a signal is ambiguous, say false.
const AUTO_REPLY_HEADERS = new Set([
  "x-autorespond",
  "x-autoreply",
  "x-auto-reply",
  "x-autoresponder",
  "x-loop",
  "x-auto-response-suppress",
]);

// Deliberately excludes "bulk" and "list": legitimate senders set those, and a
// human replying through such a system would be wrongly silenced.
const AUTO_REPLY_PRECEDENCE = new Set(["auto_reply", "auto-reply", "autoreply", "junk"]);

const AUTO_REPLY_SUBJECT_PREFIXES = [
  "automatic reply",
  "auto-reply",
  "autoreply",
  "auto reply",
  "out of office",
  "out-of-office",
  "away from",
  "autoresponder",
  "thank you for contacting",
  "thanks for contacting",
];

export type ReplyIntent = "opt_out" | "auto_reply" | "soft_decline" | "human";

// Every reply quotes the email it answers, and our own footer carries an
// unsubscribe link -- so searching the WHOLE body for "unsubscribe" matches every
// reply ever received and would suppress the entire list. Intent is therefore only
// ever read from the text the person actually typed, above the quoted original.
// stripQuotedReply/splitQuotedReply live in @inboxjoy/email so the replies API can
// split thread bodies the exact same way this classifier does.
export { stripQuotedReply };

// A request to stop emailing is a legal obligation, so the error costs here are the
// reverse of isAutoReply's: missing a real opt-out means continuing to mail someone
// who asked us not to, which earns spam complaints and wrecks domain reputation,
// while a false positive costs one lead that a human can restore from the Inbox.
// Leaning toward honouring the request is only safe because the match runs on
// unquoted text.
const OPT_OUT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bremove (?:me )?from (?:your|the|this) (?:list|mailing)/i,
  /\btake me off\b/i,
  /\bstop (?:emailing|contacting|sending)/i,
  /\b(?:do not|don'?t) (?:email|contact)\b/i,
  /\bopt[- ]?out\b/i,
  /\bno longer wish\b/i,
];

// A soft decline is a "no for now", not a legal opt-out: it stops the sequence like
// any human reply but must NOT suppress the contact, who stays valid for later.
const SOFT_DECLINE_PATTERNS = [
  /\bnot interested\b/i,
  /\bno interest\b/i,
  /\bnot a (?:good )?fit\b/i,
  /\bnot at this time\b/i,
  /\bwe'?re all set\b/i,
  /\bno,? thank/i,
];

export function classifyReplyIntent(data: Record<string, unknown>): ReplyIntent {
  const content = extractReplyContent(data);
  const unquoted = stripQuotedReply(content.bodyText ?? "");
  const subject = stringValue(data.subject) ?? "";
  // The subject is safe to include: it is never the quoted original.
  const candidate = `${subject}\n${unquoted}`;

  if (OPT_OUT_PATTERNS.some((pattern) => pattern.test(candidate))) return "opt_out";
  if (isAutoReply(data)) return "auto_reply";
  if (SOFT_DECLINE_PATTERNS.some((pattern) => pattern.test(candidate))) return "soft_decline";
  return "human";
}

export function isAutoReply(data: Record<string, unknown>): boolean {
  const rawHeaders = record(data.payload).headers;
  if (Array.isArray(rawHeaders)) {
    for (const entry of rawHeaders) {
      const header = record(entry);
      const name = stringValue(header.name)?.toLowerCase().trim();
      if (!name) continue;
      if (AUTO_REPLY_HEADERS.has(name)) return true;
      const value = stringValue(header.value)?.toLowerCase().trim() ?? "";
      if (name === "auto-submitted" && value && value !== "no") return true;
      if ((name === "precedence" || name === "x-precedence") && AUTO_REPLY_PRECEDENCE.has(value)) return true;
    }
  }

  // The subject is only consulted at the START of the line, so a human writing
  // "I was out of office last week" is not misread as a machine.
  const subject = stringValue(data.subject)?.toLowerCase().trimStart() ?? "";
  return AUTO_REPLY_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix));
}

export function extractReplyContent(data: Record<string, unknown>, payloadTimestamp?: unknown, fallbackDate = new Date()): ExtractedReplyContent {
  const body = record(data.body);
  const bodyContent = stringValue(body.content);
  const contentType = stringValue(body.contentType) ?? stringValue(body.content_type);
  const plainBody = stringValue(data.message_text)
    ?? stringValue(data.body)
    ?? stringValue(data.text)
    ?? stringValue(data.bodyPreview)
    ?? stringValue(data.snippet);
  const bodyText = plainBody
    ? replyBody(plainBody)
    : bodyContent
      ? replyBody(bodyContent, /html/i.test(contentType ?? ""))
      : stringValue(data.message_html)
        ? replyBody(stringValue(data.message_html)!, true)
        : undefined;

  return {
    providerMessageId: identifierValue(data.message_id) ?? identifierValue(data.id) ?? identifierValue(data.messageId),
    providerThreadId: identifierValue(data.thread_id) ?? identifierValue(data.threadId) ?? identifierValue(data.conversation_id) ?? identifierValue(data.conversationId),
    subject: stringValue(data.subject),
    bodyText,
    snippet: bodyText ? bodyText.replace(/\s+/g, " ").trim().slice(0, 300) || undefined : undefined,
    receivedAt: replyDate(payloadTimestamp) ?? replyDate(data.message_timestamp) ?? replyDate(data.received_at) ?? replyDate(data.internal_date) ?? fallbackDate,
  };
}

export function extractMessageIdentifiers(value: unknown, identifiers = new Set<string>(), depth = 0): string[] {
  if (depth > 8 || !value || typeof value !== "object") return [...identifiers];
  if (Array.isArray(value)) {
    for (const item of value) extractMessageIdentifiers(item, identifiers, depth + 1);
    return [...identifiers];
  }

  for (const [key, item] of Object.entries(record(value))) {
    const keyName = normalizedKey(key);
    if (/^(?:providermessageid|messageid|internetmessageid|originalmessageid|inreplyto)$/.test(keyName) && typeof item === "string") {
      const identifier = item.trim();
      if (identifier) {
        identifiers.add(identifier);
        identifiers.add(identifier.replace(/^<|>$/g, ""));
      }
    }
    if (item && typeof item === "object") extractMessageIdentifiers(item, identifiers, depth + 1);
  }
  return [...identifiers].filter(Boolean);
}
