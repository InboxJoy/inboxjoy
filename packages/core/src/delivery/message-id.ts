import { isCloudEdition, type Edition } from "../edition.js";

// Right-hand side of the RFC 5322 Message-IDs we generate for campaign sends
// and manual replies. The managed service keeps its own subdomain; a
// self-hosted install uses the sending mailbox's domain so its mail never names
// inboxjoy.online. Nothing parses this domain back: replies and bounces match on
// the whole Message-ID string stored with each message (metadata
// providerRfcMessageId, internet_message_id) or on the sender and contact.
export const CLOUD_MESSAGE_ID_DOMAIN = "messages.inboxjoy.online";

// Used when a self-hosted mailbox has no usable email domain. RFC 6761 reserves
// .invalid, so the id can never collide with a real host.
export const FALLBACK_MESSAGE_ID_DOMAIN = "inboxjoy.invalid";

// ASCII hostnames with at least one dot, the shape the MIME builders accept.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function messageIdDomain(edition: Edition, mailboxEmail: string | null | undefined): string {
  if (isCloudEdition(edition)) return CLOUD_MESSAGE_ID_DOMAIN;
  const at = mailboxEmail?.lastIndexOf("@") ?? -1;
  const domain = at >= 0 ? mailboxEmail!.slice(at + 1).trim().toLowerCase() : "";
  return HOSTNAME.test(domain) ? domain : FALLBACK_MESSAGE_ID_DOMAIN;
}

export function rfcMessageId(localPart: string, edition: Edition, mailboxEmail: string | null | undefined): string {
  return `<${localPart}@${messageIdDomain(edition, mailboxEmail)}>`;
}
