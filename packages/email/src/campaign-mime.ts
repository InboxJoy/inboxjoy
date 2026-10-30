import { createHash } from "node:crypto";

export type CampaignMimeInput = {
  from?: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  unsubscribeUrl?: string;
  messageId?: string;
  inReplyTo?: string;
};

export function campaignMime(input: CampaignMimeInput): string {
  const address = (value: string | undefined) => {
    if (!value || !/^[^\s<>@]+@[^\s<>@]+$/.test(value) || /[\r\n]/.test(value)) throw new Error("Invalid campaign address");
    return value;
  };
  const url = new URL(input.unsubscribeUrl!);
  if (url.protocol !== "https:" || /[\r\n<>]/.test(input.unsubscribeUrl!)) throw new Error("Invalid unsubscribe URL");
  if (!input.messageId || !/^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(input.messageId)) throw new Error("Missing campaign Message-ID");
  if (input.inReplyTo && !/^<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(input.inReplyTo)) throw new Error("Invalid reply Message-ID");
  const boundary = `inboxjoy_${createHash("sha256").update(input.messageId).digest("hex").slice(0,32)}`;
  const encode = (value: string) => Buffer.from(value).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const headers = [
    `From: ${address(input.from)}`, `To: ${address(input.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    `List-Unsubscribe: <${url.href}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", encode(input.body),
    ...(input.html ? [`--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", encode(input.html)] : []),
    `--${boundary}--`, "",
  ];
  return headers.join("\r\n");
}
