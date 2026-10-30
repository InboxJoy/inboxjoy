import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Delivery advisor pilot allowlist (docs/delivery-advisor-plan.md): empty by
// default means the feature is disabled for every workspace. Entries are
// validated as workspace UUIDs rather than silently dropped, so a typo in the
// env var fails loud at boot instead of quietly disabling the pilot.
const workspaceIdCsv = csv.refine(
  (ids) => ids.every((id) => UUID_RE.test(id)),
  { message: "DELIVERY_ADVISOR_WORKSPACE_IDS must be a comma-separated list of workspace UUIDs." },
);

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);

const optionalValue = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().email().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

const optionalHttpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().refine(isHttpUrl, "Must be an http or https URL.").optional(),
);

// System email over SMTP: smtps://user:pass@host:465 (implicit TLS) or
// smtp://user:pass@host:587 (STARTTLS). The message never echoes the value,
// because it carries the password.
export function isSmtpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "smtp:" || url.protocol === "smtps:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const smtpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().refine(isSmtpUrl, "MAIL_SMTP_URL must look like smtps://user:pass@host:465 or smtp://user:pass@host:587.").optional(),
);

// "hey@example.com" or "InboxJoy <hey@example.com>".
export function isMailFrom(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const named = /^[^<>]*<([^<>\s]+)>$/.exec(value);
  return z.string().email().safeParse(named ? named[1] : value).success;
}

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

// Which product this deployment is:
// "cloud" is the managed service we sell, "selfhost" is the open-source
// edition. Production must say which explicitly, so a missing variable fails
// the boot instead of silently turning the managed service into the free edition.
export const EDITIONS = ["cloud", "selfhost"] as const;
export type Edition = (typeof EDITIONS)[number];

// Who may create an account.
// "open": anyone. "invite": the instance's first account (its owner) and people
// holding a pending invitation; nobody else.
export const SIGNUP_MODES = ["open", "invite"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export const appEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  INBOXJOY_EDITION: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.enum(EDITIONS).optional(),
  ),
  // Unset means the edition's default; see resolveSignupMode().
  SIGNUP_MODE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.enum(SIGNUP_MODES).optional(),
  ),
  // Self-host first-run setup: while no account exists, creating the owner
  // account needs this value (the installer prints it in the setup link), so
  // whoever finds a fresh install first cannot claim it. Unset: no token needed.
  SETUP_TOKEN: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(24, "SETUP_TOKEN must be at least 24 characters.").optional(),
  ),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  WEB_BASE_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: csv,
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // API 10 + worker app (2 x 6) + pg-boss (2 x 5) + web 5 = 37 steady-state; migrations add 2 transient for 39 peak.
  // Production Postgres (B1ms) allows 50 connections and Azure reserves a few, so keep this under ~45.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  QUEUE_POOL_MAX: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  COMPOSIO_WEBHOOK_SECRET: optionalSecret,
  // Composio keys (ak_...) are ~23 chars — the 32-char optionalSecret floor is for our own signing secrets.
  COMPOSIO_API_KEY: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().min(8).optional()),
  COMPOSIO_GMAIL_AUTH_CONFIG_ID: z.string().trim().optional(),
  COMPOSIO_OUTLOOK_AUTH_CONFIG_ID: z.string().trim().optional(),
  COMPOSIO_TOOLKIT_VERSION: z.string().trim().min(1).default("20260826_00"),
  SMTP_MAILBOXES_ENABLED: mailboxFlag,
  DELIVERY_ADVISOR_WORKSPACE_IDS: workspaceIdCsv,
  SMTP_ALLOW_PRIVATE_HOSTS: mailboxFlag,
  MAILBOX_CREDENTIALS_KEY: mailboxKey,
  MAILBOX_CREDENTIALS_KEY_PREVIOUS: mailboxKey,
  DODO_PAYMENTS_API_KEY: optionalValue,
  DODO_PAYMENTS_WEBHOOK_KEY: optionalValue,
  DODO_PAYMENTS_ENVIRONMENT: z.enum(["test_mode", "live_mode"]).default("test_mode"),
  DODO_PRODUCT_LIFETIME: optionalValue,
  AUTH_SECRET: optionalSecret,
  BETTER_AUTH_SECRET: optionalSecret,
  BETTER_AUTH_URL: z.string().url().optional(),
  TURNSTILE_SECRET: optionalSecret,
  TURNSTILE_HOSTNAMES: csv,
  AZURE_COMMUNICATION_EMAIL_ENDPOINT: optionalUrl,
  AZURE_COMMUNICATION_EMAIL_SENDER: optionalEmail,
  AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS: optionalEmail,
  // System email over SMTP, used when Azure Communication Services is not set.
  MAIL_SMTP_URL: smtpUrl,
  MAIL_FROM: mailFrom,
  MAIL_REPLY_TO: optionalEmail,
  // Founder notification target for new-signup alerts. Unset (the default) disables them.
  FOUNDER_ALERT_EMAIL: optionalEmail,
  AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().uuid().optional(),
  ),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  AZURE_OPENAI_DEPLOYMENT: optionalValue,
  // Any OpenAI-compatible chat completions endpoint (OpenAI, OpenRouter, Ollama).
  // Takes precedence over Azure OpenAI when AI_API_KEY and AI_MODEL are both set.
  AI_API_KEY: optionalValue,
  AI_MODEL: optionalValue,
  AI_BASE_URL: optionalHttpUrl,
  // PostHog server-side exception capture. Unset token = fully disabled, zero
  // overhead. Unset host = PostHog's public cloud. Mirrors apps/worker's WorkerEnv.
  POSTHOG_PROJECT_TOKEN: optionalValue,
  POSTHOG_HOST: optionalUrl,
}).superRefine((env, context) => {
  if (env.NODE_ENV === "production" && !env.INBOXJOY_EDITION) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INBOXJOY_EDITION must be set to cloud or selfhost in production.", path: ["INBOXJOY_EDITION"] });
  }
  if (env.SMTP_MAILBOXES_ENABLED && !env.MAILBOX_CREDENTIALS_KEY) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "MAILBOX_CREDENTIALS_KEY is required when SMTP mailboxes are enabled.", path: ["MAILBOX_CREDENTIALS_KEY"] });
  }
  const hasEndpoint = Boolean(env.AZURE_COMMUNICATION_EMAIL_ENDPOINT);
  const hasSender = Boolean(env.AZURE_COMMUNICATION_EMAIL_SENDER);
  if (hasEndpoint !== hasSender) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "AZURE_COMMUNICATION_EMAIL_ENDPOINT and AZURE_COMMUNICATION_EMAIL_SENDER must be configured together",
      path: hasEndpoint ? ["AZURE_COMMUNICATION_EMAIL_SENDER"] : ["AZURE_COMMUNICATION_EMAIL_ENDPOINT"],
    });
  }
  const hasSmtpUrl = Boolean(env.MAIL_SMTP_URL);
  const hasMailFrom = Boolean(env.MAIL_FROM);
  if (hasSmtpUrl !== hasMailFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "MAIL_SMTP_URL and MAIL_FROM must be configured together",
      path: hasSmtpUrl ? ["MAIL_FROM"] : ["MAIL_SMTP_URL"],
    });
  }
  // Our managed service must send system email. A self-hosted install may boot
  // without it (the first owner is created verified and invites are copyable
  // links); it only loses password resets and alerts until SMTP is configured.
  if (env.NODE_ENV === "production" && env.INBOXJOY_EDITION === "cloud" && !(hasEndpoint && hasSender) && !(hasSmtpUrl && hasMailFrom)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "System email is required for the cloud edition in production: set AZURE_COMMUNICATION_EMAIL_ENDPOINT and AZURE_COMMUNICATION_EMAIL_SENDER, or MAIL_SMTP_URL and MAIL_FROM",
      path: ["MAIL_SMTP_URL"],
    });
  }
  const hasAiKey = Boolean(env.AI_API_KEY);
  const hasAiModel = Boolean(env.AI_MODEL);
  if (hasAiKey !== hasAiModel || (env.AI_BASE_URL && !hasAiKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "AI_API_KEY and AI_MODEL must be configured together (AI_BASE_URL needs both)",
      path: hasAiKey ? ["AI_MODEL"] : ["AI_API_KEY"],
    });
  }
});

export type AppEnv = z.infer<typeof appEnvSchema>;

export function loadAppEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return appEnvSchema.parse(source);
}

export function resolveEdition(env: Pick<AppEnv, "INBOXJOY_EDITION">): Edition {
  return env.INBOXJOY_EDITION ?? "selfhost";
}

// Cloud defaults to open sign-up, self-host to invite-only. NODE_ENV=test keeps
// self-host open: test suites share one database and create many accounts, so
// the "first account only" rule would make them order-dependent. Tests of the
// invite rule set SIGNUP_MODE=invite explicitly.
export function resolveSignupMode(env: Pick<AppEnv, "SIGNUP_MODE" | "INBOXJOY_EDITION" | "NODE_ENV">): SignupMode {
  if (env.SIGNUP_MODE) return env.SIGNUP_MODE;
  if (resolveEdition(env) === "cloud") return "open";
  return env.NODE_ENV === "test" ? "open" : "invite";
}

// The setup token guards only a self-hosted install's first-run setup; the
// managed service never asks for one.
export function resolveSetupToken(env: Pick<AppEnv, "SETUP_TOKEN" | "INBOXJOY_EDITION">): string | undefined {
  return resolveEdition(env) === "selfhost" ? env.SETUP_TOKEN : undefined;
}

export function corsOrigins(env: Pick<AppEnv, "CORS_ORIGINS" | "WEB_BASE_URL">): string[] {
  return Array.from(new Set([env.WEB_BASE_URL, ...env.CORS_ORIGINS]));
}

export function deliveryAdvisorWorkspaceIds(env: Pick<AppEnv, "DELIVERY_ADVISOR_WORKSPACE_IDS">): Set<string> {
  return new Set(env.DELIVERY_ADVISOR_WORKSPACE_IDS.map((id) => id.toLowerCase()));
}

// The endpoint must enforce this itself (not just hide the UI card): call
// this before any advisor read, for every request, never once at boot.
export function isDeliveryAdvisorEnabled(env: Pick<AppEnv, "DELIVERY_ADVISOR_WORKSPACE_IDS">, workspaceId: string): boolean {
  return deliveryAdvisorWorkspaceIds(env).has(workspaceId.toLowerCase());
}
