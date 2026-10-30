import { createTransactionalEmailService, POSTAL_ADDRESS_LINE, type TransactionalEmailService } from "@inboxjoy/email";

import type { WorkerEnv } from "./env.js";

// Mirrors apps/api/src/auth.ts's transactionalEmailFromEnv. The worker builds its own
// TransactionalEmailService directly from packages/email rather than importing from
// apps/api, since apps/api is owned by another agent and the worker deploys separately.
// Azure Communication Services wins when configured, then SMTP, else disabled; the
// Dubai postal line belongs to the managed cloud edition only.
export function transactionalEmailFromEnv(
  env: WorkerEnv,
  dependencies: Parameters<typeof createTransactionalEmailService>[1] = {},
): TransactionalEmailService {
  return createTransactionalEmailService({
    appBaseUrl: env.WEB_BASE_URL,
    postalAddressLine: env.INBOXJOY_EDITION === "cloud" ? POSTAL_ADDRESS_LINE : undefined,
    azure: {
      endpoint: env.AZURE_COMMUNICATION_EMAIL_ENDPOINT,
      senderAddress: env.AZURE_COMMUNICATION_EMAIL_SENDER,
      managedIdentityClientId: env.AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID,
      replyToAddress: env.AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS,
    },
    smtp: {
      url: env.MAIL_SMTP_URL,
      from: env.MAIL_FROM,
      replyToAddress: env.MAIL_REPLY_TO,
    },
  }, dependencies);
}
