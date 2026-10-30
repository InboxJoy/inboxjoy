import type { ComposioClient, FetchedReply } from "@inboxjoy/composio";
import type { MailboxProvider } from "../mailbox-provider.js";

export type { FetchedReply } from "@inboxjoy/composio";

type MailClientInput<Input> = Omit<Input, "provider"> & { provider: MailboxProvider };

export type MailClient = {
  enabled: boolean;
  sendEmail(input: MailClientInput<Parameters<ComposioClient["sendEmail"]>[0]> & { references?: string }): ReturnType<ComposioClient["sendEmail"]>;
  fetchReplies?(input: MailClientInput<Parameters<NonNullable<ComposioClient["fetchReplies"]>>[0]>): Promise<FetchedReply[]>;
  findReply?(input: MailClientInput<Parameters<NonNullable<ComposioClient["findReply"]>>[0]>): Promise<boolean>;
  findSentMessage(input: MailClientInput<Parameters<ComposioClient["findSentMessage"]>[0]>): ReturnType<ComposioClient["findSentMessage"]>;
};
