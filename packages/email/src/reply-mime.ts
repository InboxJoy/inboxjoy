import { createHash } from "node:crypto";
import type { CampaignMimeInput } from "./campaign-mime.js";

export type ReplyMimeInput = Omit<CampaignMimeInput, "unsubscribeUrl"> & { references?: string };

export function replyMime(input: ReplyMimeInput): string {
  const address = (value: string | undefined) => {
    if (!value || !/^[^\s<>@]+@[^\s<>@]+$/.test(value) || /[\r\n]/.test(value)) throw new Error("Invalid reply address");
    return value;
  };
  if (!input.messageId || !/^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(input.messageId)) throw new Error("Missing reply Message-ID");
  const replyId = /^<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/;
  if (input.inReplyTo && !replyId.test(input.inReplyTo)) throw new Error("Invalid reply Message-ID");
  if (input.references !== undefined && (!input.references.trim() || /[\r\n]/.test(input.references) || !input.references.trim().split(/\s+/).every((reference) => replyId.test(reference)))) throw new Error("Invalid reply References");
  const references = input.references?.trim() ?? input.inReplyTo;
  const boundary = `inboxjoy_${createHash("sha256").update(input.messageId).digest("hex").slice(0,32)}`;
  const encode = (value: string) => Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return [
    `From: ${address(input.from)}`, `To: ${address(input.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", encode(input.body),
    ...(input.html ? [`--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", encode(input.html)] : []),
    `--${boundary}--`, "",
  ].join("\r\n");
}
