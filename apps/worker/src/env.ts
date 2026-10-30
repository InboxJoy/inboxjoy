import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().email().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

// Mirrors packages/config's MAIL_SMTP_URL / MAIL_FROM checks. Messages never
// echo the value, because the URL carries the SMTP password.
function isSmtpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "smtp:" || url.protocol === "smtps:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isMailFrom(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const named = /^[^<>]*<([^<>\s]+)>$/.exec(value);
  return z.string().email().safeParse(named ? named[1] : value).success;
}

const smtpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().refine(isSmtpUrl, "MAIL_SMTP_URL must look like smtps://user:pass@host:465 or smtp://user:pass@host:587.").optional(),
);

const mailFrom = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().refine(isMailFrom, "MAIL_FROM must be an email address, optionally with a name: InboxJoy <hey@example.com>.").optional(),
);

const mailboxFlag = z.preprocess(
  (value) => value === "true" ? true : value === "false" ? false : value,
  z.boolean().default(false),
);

const mailboxKey = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().refine((value) => Buffer.from(value, "base64").length === 32 && Buffer.from(value, "base64").toString("base64") === value, "Mailbox credentials keys must be base64-encoded 32-byte keys.").optional(),
);

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(4),
  QUEUE_POOL_MAX: z.coerce.number().int().positive().default(5),
  API_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url().default("http://localhost:3000"),
  AUTH_SECRET: z.string().min(32),
  COMPOSIO_API_KEY: optionalString,
  COMPOSIO_TOOLKIT_VERSION: z.string().min(1).default("20260826_00"),
  SMTP_MAILBOXES_ENABLED: mailboxFlag,
  SMTP_ALLOW_PRIVATE_HOSTS: mailboxFlag,
  MAILBOX_CREDENTIALS_KEY: mailboxKey,
  MAILBOX_CREDENTIALS_KEY_PREVIOUS: mailboxKey,
  WORKER_ID: z.string().min(1).default(`worker-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(50).default(5),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().max(65535).default(8090),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Mirrors packages/config: "cloud" (managed) or "selfhost" (open source).
  // Required in production; dev and test default to "selfhost".
  INBOXJOY_EDITION: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.enum(["cloud", "selfhost"]).optional(),
  ),
  // Transactional email (mailbox alerts, campaign completed, reply received).
  // Mirrors packages/config's AppEnv; left optional so the worker degrades to
  // disabledTransactionalEmailService instead of failing to boot when unset.
  AZURE_COMMUNICATION_EMAIL_ENDPOINT: optionalUrl,
  AZURE_COMMUNICATION_EMAIL_SENDER: optionalEmail,
  AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS: optionalEmail,
  // System email over SMTP, used when Azure Communication Services is not set.
  MAIL_SMTP_URL: smtpUrl,
  MAIL_FROM: mailFrom,
  MAIL_REPLY_TO: optionalEmail,
  // Dead-letter alerts to the operator. Unset (the default) disables them.
  FOUNDER_ALERT_EMAIL: optionalEmail,
  AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().uuid().optional(),
  ),
  // PostHog server-side exception capture. Unset token = fully disabled, zero
  // overhead. Unset host = PostHog's public cloud. Mirrors packages/config.
  POSTHOG_PROJECT_TOKEN: optionalString,
  POSTHOG_HOST: optionalUrl,
}).superRefine((env, context) => {
  if (env.NODE_ENV === "production" && !env.INBOXJOY_EDITION) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INBOXJOY_EDITION must be set to cloud or selfhost in production.", path: ["INBOXJOY_EDITION"] });
  }
  if (env.SMTP_MAILBOXES_ENABLED && !env.MAILBOX_CREDENTIALS_KEY) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "MAILBOX_CREDENTIALS_KEY is required when SMTP mailboxes are enabled.", path: ["MAILBOX_CREDENTIALS_KEY"] });
  }
  if (Boolean(env.MAIL_SMTP_URL) !== Boolean(env.MAIL_FROM)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "MAIL_SMTP_URL and MAIL_FROM must be configured together", path: env.MAIL_SMTP_URL ? ["MAIL_FROM"] : ["MAIL_SMTP_URL"] });
  }
});

export type WorkerEnv = z.infer<typeof envSchema>;

// Same default as resolveEdition() in packages/config: production refuses to
// boot without INBOXJOY_EDITION, so only dev and test fall back to self-host.
export function resolveWorkerEdition(env: Pick<WorkerEnv, "INBOXJOY_EDITION">): "cloud" | "selfhost" {
  return env.INBOXJOY_EDITION ?? "selfhost";
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return envSchema.parse(source);
}
