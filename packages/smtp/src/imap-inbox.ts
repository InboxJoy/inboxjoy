import type { InboundEvent } from "@inboxjoy/core";
import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type MailboxObject, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import { imapConnectionOptions, type MailConnectionConfig } from "./clients.js";

export type InboxImapClient = {
  connect(): Promise<unknown>;
  mailboxOpen(path: string): Promise<Pick<MailboxObject, "uidValidity" | "uidNext">>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>;
  fetchOne(uid: string, query: { source: true; internalDate: true }, options: { uid: true }): Promise<Pick<FetchMessageObject, "uid" | "source" | "internalDate"> | false>;
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type InboxImapFactory = (options: ImapFlowOptions) => InboxImapClient;

export async function createInboxImapClient(config: MailConnectionConfig, factory?: InboxImapFactory): Promise<InboxImapClient> {
  const options = await imapConnectionOptions(config);
  return factory ? factory(options) : new ImapFlow(options);
}

type ImapMessageData = Record<string, unknown> & {
  from?: string;
  to: string[];
  subject?: string;
  message_text?: string;
  message_timestamp: string;
  message_id?: string;
  thread_id?: string;
};

export async function parseImapMessage(source: Buffer, fallbackDate = new Date()): Promise<{ data: ImapMessageData; bounce?: InboundEvent["bounce"] }> {
  const parsed = await simpleParser(source, { keepDeliveryStatus: true });
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references?.split(/\s+/);
  const recipients = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [];
  const data: ImapMessageData = {
    from: parsed.from?.value[0]?.address?.toLowerCase(),
    to: recipients.flatMap((recipient) => recipient.value.flatMap((address) => address.address ? [address.address.toLowerCase()] : [])),
    subject: parsed.subject,
    message_text: parsed.text,
    message_html: parsed.html || undefined,
    message_timestamp: (parsed.date && Number.isFinite(parsed.date.getTime()) ? parsed.date : fallbackDate).toISOString(),
    message_id: parsed.messageId,
    thread_id: references?.[0] ?? parsed.inReplyTo,
    in_reply_to: parsed.inReplyTo,
    payload: {
      headers: parsed.headerLines.map((header) => ({
        name: header.key.toLowerCase(),
        value: header.line.replace(/^[^:]+:\s*/, "").replace(/\r?\n[ \t]+/g, " "),
      })),
    },
  };
  const contentType = parsed.headerLines.find((header) => header.key.toLowerCase() === "content-type")?.line ?? "";
  if (!/multipart\/report\b/i.test(contentType) || !/report-type\s*=\s*"?delivery-status\b/i.test(contentType)) return { data };
  const bounce: NonNullable<InboundEvent["bounce"]> = [];
  for (const attachment of parsed.attachments.filter((item) => item.contentType.toLowerCase() === "message/delivery-status")) {
    const blocks = attachment.content.toString("utf8").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const fields = new Map(block.split(/\r?\n/).flatMap((line) => {
        const separator = line.indexOf(":");
        return separator > 0 ? [[line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()] as const] : [];
      }));
      const originalMessageId = fields.get("original-message-id");
      if (originalMessageId) data.original_message_id = originalMessageId;
      const recipient = (fields.get("final-recipient") ?? fields.get("original-recipient"))?.match(/;\s*<?([^\s<>]+@[^\s<>]+)>?/)?.[1];
      const action = fields.get("action");
      const status = fields.get("status")?.match(/^\d+\.\d+\.\d+/)?.[0];
      if (recipient && action && status) bounce.push({ recipient: recipient.toLowerCase(), action, status });
    }
  }
  return { data, bounce };
}
