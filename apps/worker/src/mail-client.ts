export { createMailClientResolver, type MailClientResolver, type MailClientResolverDependencies } from "@inboxjoy/smtp";

import type { MailClient, MailboxProvider } from "@inboxjoy/core";

export type MailClientFor = (mailbox: { provider: MailboxProvider; emailAccountId: string }) => MailClient | Promise<MailClient>;
