import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

const metadata = (name = "metadata") => jsonb(name).$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

export const workspaceStatusEnum = pgEnum("workspace_status", ["active", "paused", "disabled"]);
export const roleEnum = pgEnum("workspace_role", ["owner", "admin", "member"]);
export const membershipStatusEnum = pgEnum("membership_status", ["invited", "active", "disabled"]);
export const providerEnum = pgEnum("mailbox_provider", ["gmail", "outlook", "smtp"]);
export const mailboxStatusEnum = pgEnum("mailbox_status", ["connecting", "active", "paused", "expired", "error", "disconnected", "removed"]);
export const importStatusEnum = pgEnum("import_status", ["draft", "validating", "ready", "committed", "failed", "cancelled"]);
export const sequenceStatusEnum = pgEnum("sequence_status", ["draft", "active", "paused", "completed", "archived"]);
export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "scheduled",
  "active",
  "paused",
  "replied",
  "bounced",
  "unsubscribed",
  "completed",
  "cancelled",
]);
export const messageStatusEnum = pgEnum("message_status", ["scheduled", "claimed", "sending", "accepted", "retryable", "failed", "cancelled"]);
export const webhookStatusEnum = pgEnum("webhook_status", ["received", "processed", "ignored", "failed"]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  lastJobAt: timestamp("last_job_at", { withTimezone: true }),
}, (table) => ({
  lastSeenIdx: index("worker_heartbeats_last_seen_idx").on(table.lastSeenAt),
}));

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  normalizedEmail: varchar("normalized_email", { length: 320 }).notNull(),
  displayName: varchar("display_name", { length: 160 }),
  avatarUrl: text("avatar_url"),
  activeWorkspaceId: uuid("active_workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "set null" }),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  termsVersion: text("terms_version"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  normalizedEmailIdx: uniqueIndex("users_normalized_email_idx").on(table.normalizedEmail),
}));

export const authUsers = pgTable("auth_users", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  acceptedTerms: boolean("accepted_terms").notNull().default(false),
  ...timestamps,
}, (table) => ({
  emailIdx: uniqueIndex("auth_users_email_idx").on(table.email),
}));

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: text("user_agent"),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  ...timestamps,
}, (table) => ({
  tokenIdx: uniqueIndex("auth_sessions_token_idx").on(table.token),
  userExpiresIdx: index("auth_sessions_user_expires_idx").on(table.userId, table.expiresAt),
}));

export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").primaryKey(),
  // Written only by Better Auth 1.7.0-1.7.2; optional since 0044.
  issuer: varchar("issuer", { length: 320 }),
  accountId: text("account_id").notNull(),
  providerId: varchar("provider_id", { length: 120 }).notNull(),
  userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  ...timestamps,
}, (table) => ({
  providerAccountIdx: index("auth_accounts_provider_account_idx").on(table.providerId, table.accountId),
  userIdx: index("auth_accounts_user_idx").on(table.userId),
}));

export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => ({
  identifierIdx: index("auth_verifications_identifier_idx").on(table.identifier),
}));

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashIdx: uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
  userExpiresIdx: index("sessions_user_expires_idx").on(table.userId, table.expiresAt),
}));

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull(),
  status: workspaceStatusEnum("status").notNull().default("active"),
  defaultTimezone: varchar("default_timezone", { length: 80 }).notNull().default("UTC"),
  dailySendCap: integer("daily_send_cap").notNull().default(200),
  killSwitchEnabled: boolean("kill_switch_enabled").notNull().default(false),
  openTrackingEnabled: boolean("open_tracking_enabled").notNull().default(false),
  postalAddress: text("postal_address"),
  // Hosted workspaces on the old Free plan when the lifetime-only release
  // shipped keep its rules until this time (migration 0042); null for everyone
  // else. Self-host ignores it.
  legacyFreeUntil: timestamp("legacy_free_until", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  slugIdx: uniqueIndex("workspaces_slug_idx").on(table.slug),
}));

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull().default("member"),
  status: membershipStatusEnum("status").notNull().default("active"),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  workspaceUserIdx: uniqueIndex("memberships_workspace_user_idx").on(table.workspaceId, table.userId),
  userIdx: index("memberships_user_idx").on(table.userId),
}));

export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  clientSecretHash: text("client_secret_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  redirectUrisNonempty: check("oauth_clients_redirect_uris_nonempty", sql`cardinality(${table.redirectUris}) > 0`),
  authMethodCheck: check("oauth_clients_auth_method_check", sql`${table.tokenEndpointAuthMethod} = 'none'`),
}));

export const mcpGrants = pgTable("mcp_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => ({
  userIdIdx: index("mcp_grants_user_id_idx").on(table.userId),
  clientIdIdx: index("mcp_grants_client_id_idx").on(table.clientId),
  workspaceIdIdx: index("mcp_grants_workspace_id_idx").on(table.workspaceId),
  activeSubjectIdx: uniqueIndex("mcp_grants_active_subject_idx").on(table.userId, table.clientId, table.workspaceId).where(sql`revoked_at is null`),
}));

export const mcpOauthCodes = pgTable("mcp_oauth_codes", {
  resource: text("resource"),
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  scopes: text("scopes").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now() + interval '60 seconds'`),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeHashIdx: uniqueIndex("mcp_oauth_codes_code_hash_idx").on(table.codeHash),
  clientIdIdx: index("mcp_oauth_codes_client_id_idx").on(table.clientId),
  expiresAtIdx: index("mcp_oauth_codes_expires_at_idx").on(table.expiresAt),
  challengeMethodCheck: check("mcp_oauth_codes_challenge_method_check", sql`${table.codeChallengeMethod} = 'S256'`),
}));

export const mcpOauthTokens = pgTable("mcp_oauth_tokens", {
  resource: text("resource"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull(),
  refreshTokenHash: text("refresh_token_hash"),
  userId: text("user_id").notNull(),
  clientId: text("client_id").notNull().references(() => oauthClients.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashIdx: uniqueIndex("mcp_oauth_tokens_token_hash_idx").on(table.tokenHash),
  refreshTokenHashIdx: uniqueIndex("mcp_oauth_tokens_refresh_token_hash_idx").on(table.refreshTokenHash).where(sql`refresh_token_hash is not null`),
  subjectIdx: index("mcp_oauth_tokens_subject_idx").on(table.userId, table.clientId, table.workspaceId),
  activeIdx: index("mcp_oauth_tokens_active_idx").on(table.clientId, table.expiresAt).where(sql`revoked_at is null`),
}));

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  keyHash: text("key_hash").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => ({
  keyHashIdx: uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
  workspaceCreatedIdx: index("api_keys_workspace_created_idx").on(table.workspaceId, table.createdAt),
}));

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  normalizedEmail: varchar("normalized_email", { length: 320 }).notNull(),
  role: roleEnum("role").notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  tokenHashIdx: uniqueIndex("invitations_token_hash_idx").on(table.tokenHash),
  openInviteIdx: uniqueIndex("invitations_workspace_email_open_idx").on(table.workspaceId, table.normalizedEmail).where(sql`accepted_at is null`),
}));

export const emailAccounts = pgTable("email_accounts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: providerEnum("provider").notNull(),
  composioConnectedAccountId: text("composio_connected_account_id").notNull(),
  email: varchar("email", { length: 320 }),
  normalizedEmail: varchar("normalized_email", { length: 320 }),
  displayName: varchar("display_name", { length: 160 }),
  alias: varchar("alias", { length: 80 }).notNull(),
  status: mailboxStatusEnum("status").notNull().default("connecting"),
  timezone: varchar("timezone", { length: 80 }).notNull().default("UTC"),
  dailyLimit: integer("daily_limit").notNull().default(20),
  hourlyLimit: integer("hourly_limit").notNull().default(5),
  rampStartedOn: date("ramp_started_on"),
  rampPausedDays: integer("ramp_paused_days").notNull().default(0),
  rampPauseLastDate: date("ramp_pause_last_date"),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  providerMetadata: metadata("provider_metadata"),
  ...timestamps,
}, (table) => ({
  composioAccountIdx: uniqueIndex("email_accounts_composio_account_idx").on(table.composioConnectedAccountId),
  workspaceAliasIdx: uniqueIndex("email_accounts_workspace_alias_idx").on(table.workspaceId, table.alias),
  workspaceEmailIdx: index("email_accounts_workspace_email_idx").on(table.workspaceId, table.normalizedEmail),
  activeMailboxIdx: index("email_accounts_active_idx").on(table.workspaceId, table.status),
}));

export const mailboxCredentials = pgTable("mailbox_credentials", {
  emailAccountId: uuid("email_account_id").primaryKey().references(() => emailAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpSecure: boolean("smtp_secure").notNull().default(true),
  smtpUsername: text("smtp_username").notNull(),
  smtpPasswordEncrypted: text("smtp_password_encrypted").notNull(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull(),
  imapSecure: boolean("imap_secure").notNull().default(true),
  imapUsername: text("imap_username").notNull(),
  imapPasswordEncrypted: text("imap_password_encrypted").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastVerifyError: text("last_verify_error"),
  lastImapUid: bigint("last_imap_uid", { mode: "bigint" }),
  lastImapUidvalidity: bigint("last_imap_uidvalidity", { mode: "bigint" }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  imapPollFailures: integer("imap_poll_failures").notNull().default(0),
  imapPollRetryAt: timestamp("imap_poll_retry_at", { withTimezone: true }),
  imapStuckUid: bigint("imap_stuck_uid", { mode: "bigint" }),
  imapStuckAttempts: integer("imap_stuck_attempts").notNull().default(0),
  ...timestamps,
}, (table) => ({
  pollIdx: index("mailbox_credentials_poll_idx").on(table.lastPolledAt.asc().nullsFirst()),
}));

export const connectStates = pgTable("connect_states", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: providerEnum("provider").notNull(),
  state: text("state").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ stateIdx: uniqueIndex("connect_states_state_idx").on(table.state), expiresIdx: index("connect_states_expires_idx").on(table.expiresAt) }));

export const mailboxSchedules = pgTable("mailbox_schedules", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  emailAccountId: uuid("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  timezone: varchar("timezone", { length: 80 }).notNull().default("UTC"),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, (table) => ({
  mailboxDayIdx: uniqueIndex("mailbox_schedules_mailbox_day_idx").on(table.emailAccountId, table.dayOfWeek),
}));

export const mailboxDailyUsage = pgTable("mailbox_daily_usage", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  emailAccountId: uuid("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: "cascade" }),
  usageDate: date("usage_date").notNull(),
  acceptedCount: integer("accepted_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  retryCount: integer("retry_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.emailAccountId, table.usageDate] }),
  workspaceDateIdx: index("mailbox_daily_usage_workspace_date_idx").on(table.workspaceId, table.usageDate),
}));

export const mailboxHealth = pgTable("mailbox_health", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  emailAccountId: uuid("email_account_id").notNull().unique().references(() => emailAccounts.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("healthy"),
  effectiveDailyLimit: integer("effective_daily_limit"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  tempFailures24h: integer("temp_failures_24h").notNull().default(0),
  permFailures24h: integer("perm_failures_24h").notNull().default(0),
  bounceRate: numeric("bounce_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  replyRate: numeric("reply_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  lastSuccessfulSendAt: timestamp("last_successful_send_at", { withTimezone: true }),
  throttledUntil: timestamp("throttled_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MailboxHealth = typeof mailboxHealth.$inferSelect;
export type NewMailboxHealth = typeof mailboxHealth.$inferInsert;

export const providerCircuit = pgTable("provider_circuit", {
  provider: text("provider").primaryKey(),
  state: text("state").notNull().default("closed"),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  failureCount: integer("failure_count").notNull().default(0),
  nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProviderCircuit = typeof providerCircuit.$inferSelect;
export type NewProviderCircuit = typeof providerCircuit.$inferInsert;

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  normalizedEmail: varchar("normalized_email", { length: 320 }).notNull(),
  firstName: varchar("first_name", { length: 120 }),
  lastName: varchar("last_name", { length: 120 }),
  company: varchar("company", { length: 180 }),
  title: varchar("title", { length: 180 }),
  website: text("website"),
  phone: varchar("phone", { length: 80 }),
  location: varchar("location", { length: 180 }),
  linkedinUrl: text("linkedin_url"),
  source: varchar("source", { length: 120 }),
  lawfulBasisNote: text("lawful_basis_note"),
  customFields: metadata("custom_fields"),
  status: varchar("status", { length: 40 }).notNull().default("active"),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  replyBackfillCheckedAt: timestamp("reply_backfill_checked_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  workspaceEmailIdx: uniqueIndex("contacts_workspace_normalized_email_idx").on(table.workspaceId, table.normalizedEmail),
  workspaceStatusIdx: index("contacts_workspace_status_idx").on(table.workspaceId, table.status),
  workspaceUpdatedIdx: index("contacts_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
}));

export const contactLists = pgTable("contact_lists", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  workspaceNameIdx: uniqueIndex("contact_lists_workspace_name_idx").on(table.workspaceId, table.name),
}));

export const contactListMembers = pgTable("contact_list_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactListId: uuid("contact_list_id").notNull().references(() => contactLists.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.contactListId, table.contactId] }),
  contactIdx: index("contact_list_members_contact_idx").on(table.contactId),
}));

export const contactCustomFields = pgTable("contact_custom_fields", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  key: varchar("key", { length: 80 }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  fieldType: varchar("field_type", { length: 40 }).notNull().default("text"),
  ...timestamps,
}, (table) => ({
  workspaceKeyIdx: uniqueIndex("contact_custom_fields_workspace_key_idx").on(table.workspaceId, table.key),
}));

export const imports = pgTable("imports", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactListId: uuid("contact_list_id").references(() => contactLists.id, { onDelete: "set null" }),
  status: importStatusEnum("status").notNull().default("draft"),
  mode: varchar("mode", { length: 40 }).notNull().default("add_only"),
  fileName: varchar("file_name", { length: 240 }),
  listName: varchar("list_name", { length: 160 }),
  idempotencyKey: text("idempotency_key"),
  fieldMapping: metadata("field_mapping"),
  options: metadata("options"),
  totalRows: integer("total_rows").notNull().default(0),
  readyRows: integer("ready_rows").notNull().default(0),
  createRows: integer("create_rows").notNull().default(0),
  updateRows: integer("update_rows").notNull().default(0),
  createdRows: integer("created_rows").notNull().default(0),
  updatedRows: integer("updated_rows").notNull().default(0),
  unchangedRows: integer("unchanged_rows").notNull().default(0),
  skippedRows: integer("skipped_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  suppressedRows: integer("suppressed_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  errorCsvPath: text("error_csv_path"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  workspaceStatusIdx: index("imports_workspace_status_idx").on(table.workspaceId, table.status),
  idempotencyIdx: uniqueIndex("imports_workspace_idempotency_idx").on(table.workspaceId, table.idempotencyKey).where(sql`idempotency_key is not null`),
}));

export const importRows = pgTable("import_rows", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
  rowNumber: integer("row_number").notNull(),
  normalizedEmail: varchar("normalized_email", { length: 320 }),
  status: varchar("status", { length: 40 }).notNull(),
  action: varchar("action", { length: 40 }).notNull().default("rejected"),
  errorCode: varchar("error_code", { length: 80 }),
  rawData: metadata("raw_data"),
  normalizedData: metadata("normalized_data"),
  changedFields: metadata("changed_fields"),
  previewSnapshot: metadata("preview_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  importRowIdx: uniqueIndex("import_rows_import_row_idx").on(table.importId, table.rowNumber),
  importStatusIdx: index("import_rows_import_status_idx").on(table.importId, table.status),
}));

export const leadSearches = pgTable("lead_searches", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  query: metadata("query"),
  estimatedCredits: integer("estimated_credits").notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  workspaceCreatedIdx: index("lead_searches_workspace_created_idx").on(table.workspaceId, table.createdAt),
  idempotencyIdx: uniqueIndex("lead_searches_workspace_idempotency_idx").on(table.workspaceId, table.idempotencyKey).where(sql`idempotency_key is not null`),
}));

export const sourcedLeads = pgTable("sourced_leads", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  leadSearchId: uuid("lead_search_id").references(() => leadSearches.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  providerRecordId: text("provider_record_id").notNull(),
  attribution: text("attribution"),
  sourcedAt: timestamp("sourced_at", { withTimezone: true }).notNull().defaultNow(),
  retentionEndsAt: timestamp("retention_ends_at", { withTimezone: true }),
  payload: metadata("payload"),
}, (table) => ({
  providerRecordIdx: uniqueIndex("sourced_leads_workspace_provider_record_idx").on(table.workspaceId, table.provider, table.providerRecordId),
  contactIdx: index("sourced_leads_contact_idx").on(table.contactId),
}));

export const usageCredits = pgTable("usage_credits", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  amount: integer("amount").notNull(),
  reason: varchar("reason", { length: 120 }).notNull(),
  referenceId: text("reference_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreatedIdx: index("usage_credits_workspace_created_idx").on(table.workspaceId, table.createdAt),
}));

export const sequences = pgTable("sequences", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 180 }).notNull(),
  status: sequenceStatusEnum("status").notNull().default("draft"),
  currentVersionId: uuid("current_version_id"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  workspaceStatusIdx: index("sequences_workspace_status_idx").on(table.workspaceId, table.status),
}));

export const sequenceEmailAccounts = pgTable("sequence_email_accounts", {
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  emailAccountId: uuid("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sequenceId, table.emailAccountId] }),
  emailAccountIdx: index("sequence_email_accounts_email_account_idx").on(table.emailAccountId),
}));

export const sequenceVersions = pgTable("sequence_versions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: sequenceStatusEnum("status").notNull().default("draft"),
  snapshot: metadata("snapshot"),
  launchedAt: timestamp("launched_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Versions published before custom lead variables shipped keep their old rendering
  // ({{unknown}} stays literal, nothing is gated). Every new version enforces them.
  customVariablesEnforced: boolean("custom_variables_enforced").notNull().default(true),
  ...timestamps,
}, (table) => ({
  sequenceVersionIdx: uniqueIndex("sequence_versions_sequence_version_idx").on(table.sequenceId, table.version),
  workspaceStatusIdx: index("sequence_versions_workspace_status_idx").on(table.workspaceId, table.status),
}));

export const sequenceSteps = pgTable("sequence_steps", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sequenceVersionId: uuid("sequence_version_id").notNull().references(() => sequenceVersions.id, { onDelete: "cascade" }),
  stepOrder: integer("step_order").notNull(),
  delayDays: integer("delay_days").notNull().default(0),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  bodyHtml: text("body_html"),
  variables: metadata("variables"),
  ...timestamps,
}, (table) => ({
  versionOrderIdx: uniqueIndex("sequence_steps_version_order_idx").on(table.sequenceVersionId, table.stepOrder),
}));

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  contactListId: uuid("contact_list_id").references(() => contactLists.id, { onDelete: "set null" }),
  emailAccountId: uuid("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 180 }).notNull(),
  status: sequenceStatusEnum("status").notNull().default("draft"),
  launchedAt: timestamp("launched_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  workspaceStatusIdx: index("campaigns_workspace_status_idx").on(table.workspaceId, table.status),
  sequenceIdx: index("campaigns_sequence_idx").on(table.sequenceId),
}));

export const campaignContactLists = pgTable("campaign_contact_lists", {
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  contactListId: uuid("contact_list_id").notNull().references(() => contactLists.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.campaignId, table.contactListId] }),
  contactListIdx: index("campaign_contact_lists_contact_list_idx").on(table.contactListId),
}));

export const enrollments = pgTable("enrollments", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  sequenceVersionId: uuid("sequence_version_id").notNull().references(() => sequenceVersions.id, { onDelete: "restrict" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  emailAccountId: uuid("email_account_id").references(() => emailAccounts.id, { onDelete: "set null" }),
  status: enrollmentStatusEnum("status").notNull().default("scheduled"),
  nextStepOrder: integer("next_step_order").notNull().default(1),
  nextDueAt: timestamp("next_due_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  stopReason: varchar("stop_reason", { length: 80 }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  statusBeforePause: enrollmentStatusEnum("status_before_pause"),
  metadata: metadata(),
  ...timestamps,
}, (table) => ({
  uniqueContactVersionIdx: uniqueIndex("enrollments_contact_version_idx").on(table.workspaceId, table.contactId, table.sequenceVersionId),
  activeMailboxDueIdx: index("enrollments_active_mailbox_due_idx").on(table.emailAccountId, table.nextDueAt).where(sql`status in ('scheduled', 'active')`),
  workspaceStatusIdx: index("enrollments_workspace_status_idx").on(table.workspaceId, table.status),
  campaignStatusIdx: index("enrollments_campaign_status_idx").on(table.campaignId, table.status),
}));

export const stagedEnrollments = pgTable("staged_enrollments", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  leadId: uuid("lead_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  inboxIds: uuid("inbox_ids").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sequenceLeadIdx: uniqueIndex("staged_enrollments_sequence_lead_idx").on(table.sequenceId, table.leadId),
  workspaceSequenceIdx: index("staged_enrollments_workspace_idx").on(table.workspaceId, table.sequenceId),
}));

// Per-lead custom text variables for a sequence ({{icebreaker}} etc.). Keyed on
// the sequence: the web "campaign" is a sequence row and campaigns can be
// null or many per sequence.
export const campaignLeadVariables = pgTable("campaign_lead_variables", {
  sequenceId: uuid("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  values: jsonb("values").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  ...timestamps,
}, (table) => ({
  pk: primaryKey({ columns: [table.sequenceId, table.contactId] }),
  workspaceContactIdx: index("campaign_lead_variables_workspace_contact_idx").on(table.workspaceId, table.contactId),
  valuesObjectCheck: check("campaign_lead_variables_values_object_check", sql`jsonb_typeof(${table.values}) = 'object'`),
}));

export const conversationThreads = pgTable("conversation_threads", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  emailAccountId: uuid("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: "cascade" }),
  providerThreadId: text("provider_thread_id"),
  lastInternetMessageId: text("last_internet_message_id"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  providerThreadIdx: index("conversation_threads_provider_thread_idx").on(table.workspaceId, table.providerThreadId),
  internetMessageIdx: index("conversation_threads_internet_message_idx").on(table.workspaceId, table.lastInternetMessageId),
}));

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  enrollmentId: uuid("enrollment_id").notNull().references(() => enrollments.id, { onDelete: "cascade" }),
  sequenceStepId: uuid("sequence_step_id").notNull().references(() => sequenceSteps.id, { onDelete: "restrict" }),
  emailAccountId: uuid("email_account_id").notNull().references(() => emailAccounts.id, { onDelete: "restrict" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  conversationThreadId: uuid("conversation_thread_id").references(() => conversationThreads.id, { onDelete: "set null" }),
  status: messageStatusEnum("status").notNull().default("scheduled"),
  attemptKind: varchar("attempt_kind", { length: 40 }).notNull().default("sequence"),
  idempotencyKey: text("idempotency_key").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  providerMessageId: text("provider_message_id"),
  providerThreadId: text("provider_thread_id"),
  internetMessageId: text("internet_message_id"),
  recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
  normalizedRecipientEmail: varchar("normalized_recipient_email", { length: 320 }).notNull(),
  subject: text("subject").notNull(),
  bodyHash: text("body_hash").notNull(),
  trackingToken: varchar("tracking_token", { length: 32 }).notNull().default(sql`md5(random()::text || clock_timestamp()::text)`),
  errorClass: varchar("error_class", { length: 120 }),
  errorMessage: text("error_message"),
  blockedReason: text("blocked_reason"),
  metadata: metadata(),
  ...timestamps,
}, (table) => ({
  idempotencyIdx: uniqueIndex("messages_idempotency_key_idx").on(table.idempotencyKey),
  dueIdx: index("messages_due_idx").on(table.scheduledAt).where(sql`status in ('scheduled', 'retryable')`),
  providerThreadIdx: index("messages_provider_thread_idx").on(table.workspaceId, table.providerThreadId),
  internetMessageIdx: index("messages_internet_message_idx").on(table.workspaceId, table.internetMessageId),
  enrollmentIdx: index("messages_enrollment_idx").on(table.enrollmentId),
  trackingTokenIdx: uniqueIndex("messages_tracking_token_idx").on(table.trackingToken),
  mailboxStatusAcceptedIdx: index("messages_email_account_status_accepted_idx").on(table.emailAccountId, table.status, table.acceptedAt),
  workspaceStatusAcceptedIdx: index("messages_workspace_status_accepted_idx").on(table.workspaceId, table.status, table.acceptedAt),
}));

export const replies = pgTable("replies", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  enrollmentId: uuid("enrollment_id").references(() => enrollments.id, { onDelete: "set null" }),
  sequenceId: uuid("sequence_id").references(() => sequences.id, { onDelete: "set null" }),
  emailAccountId: uuid("email_account_id").references(() => emailAccounts.id, { onDelete: "set null" }),
  inReplyToMessageId: uuid("in_reply_to_message_id").references(() => messages.id, { onDelete: "set null" }),
  providerMessageId: text("provider_message_id"),
  providerThreadId: text("provider_thread_id"),
  subject: text("subject"),
  bodyText: text("body_text"),
  snippet: varchar("snippet", { length: 320 }),
  fromEmail: varchar("from_email", { length: 320 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  source: varchar("source", { length: 16 }).notNull().default("webhook"),
  isAutoReply: boolean("is_auto_reply").notNull().default(false),
  intent: varchar("intent", { length: 16 }).notNull().default("human"),
  metadata: metadata(),
  ...timestamps,
}, (table) => ({
  providerMessageIdx: uniqueIndex("replies_workspace_provider_message_idx").on(table.workspaceId, table.providerMessageId).where(sql`provider_message_id is not null`),
  workspaceReceivedIdx: index("replies_workspace_received_idx").on(table.workspaceId, table.receivedAt.desc()),
  workspaceUnreadIdx: index("replies_workspace_unread_idx").on(table.workspaceId, table.readAt).where(sql`read_at is null`),
}));

export type Reply = typeof replies.$inferSelect;
export type NewReply = typeof replies.$inferInsert;

export const sendAttempts = pgTable("send_attempts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  status: messageStatusEnum("status").notNull(),
  providerStatusCode: integer("provider_status_code"),
  providerMessageId: text("provider_message_id"),
  providerThreadId: text("provider_thread_id"),
  internetMessageId: text("internet_message_id"),
  errorClass: varchar("error_class", { length: 120 }),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => ({
  messageAttemptIdx: uniqueIndex("send_attempts_message_attempt_idx").on(table.messageId, table.attemptNumber),
}));

export const messageEvents = pgTable("message_events", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  providerEventId: text("provider_event_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  metadata: metadata(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerEventIdx: uniqueIndex("message_events_provider_event_idx").on(table.workspaceId, table.providerEventId).where(sql`provider_event_id is not null`),
  messageOccurredIdx: index("message_events_message_occurred_idx").on(table.messageId, table.occurredAt),
  workspaceTypeIdx: index("message_events_workspace_type_idx").on(table.workspaceId, table.eventType),
  workspaceMailboxOccurredIdx: index("message_events_workspace_mailbox_occurred_idx")
    .on(table.workspaceId, sql`(${table.metadata}->>'emailAccountId')`, table.occurredAt)
    .where(sql`${table.eventType} in ('manual_reply_pending', 'manual_reply_sent')`),
}));

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 80 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreatedIdx: index("notifications_workspace_created_idx").on(table.workspaceId, table.createdAt),
  workspaceUnreadIdx: index("notifications_workspace_unread_idx").on(table.workspaceId, table.readAt).where(sql`read_at is null`),
}));

export const guideSignups = pgTable("guide_signups", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  normalizedEmail: text("normalized_email").notNull(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  guideSentAt: timestamp("guide_sent_at", { withTimezone: true }),
}, (table) => ({
  normalizedEmailIdx: uniqueIndex("guide_signups_normalized_email_idx").on(table.normalizedEmail),
}));

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }),
  normalizedEmail: varchar("normalized_email", { length: 320 }),
  emailHash: text("email_hash").notNull(),
  reason: varchar("reason", { length: 80 }).notNull(),
  source: varchar("source", { length: 80 }).notNull(),
  evidence: metadata("evidence"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailIdx: uniqueIndex("suppressions_workspace_email_idx").on(table.workspaceId, table.normalizedEmail).where(sql`normalized_email is not null`),
  hashIdx: uniqueIndex("suppressions_workspace_hash_idx").on(table.workspaceId, table.emailHash),
  reasonTaxonomyCheck: check("suppressions_reason_taxonomy_check", sql`${table.reason} in ('unsubscribed', 'bounced', 'complained', 'blocked', 'customer', 'manual')`),
}));

export const unsubscribes = pgTable("unsubscribes", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  suppressionId: uuid("suppression_id").notNull().references(() => suppressions.id, { onDelete: "cascade" }),
  signedTokenHash: text("signed_token_hash").notNull(),
  userAgent: text("user_agent"),
  ipHash: text("ip_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashIdx: uniqueIndex("unsubscribes_token_hash_idx").on(table.signedTokenHash),
}));

export const providerWebhookEvents = pgTable("provider_webhook_events", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  eventId: text("event_id"),
  logId: text("log_id"),
  signatureTimestamp: timestamp("signature_timestamp", { withTimezone: true }),
  payloadHash: text("payload_hash").notNull(),
  status: webhookStatusEnum("status").notNull().default("received"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  errorClass: varchar("error_class", { length: 120 }),
  payload: metadata("payload"),
}, (table) => ({
  eventIdx: uniqueIndex("provider_webhook_events_event_idx").on(table.provider, table.eventId).where(sql`event_id is not null`),
  logIdx: uniqueIndex("provider_webhook_events_log_idx").on(table.provider, table.logId).where(sql`log_id is not null`),
  payloadHashIdx: index("provider_webhook_events_payload_hash_idx").on(table.payloadHash),
  statusReceivedIdx: index("provider_webhook_events_status_received_idx").on(table.status, table.receivedAt),
}));

export const abuseFlags = pgTable("abuse_flags", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  emailAccountId: uuid("email_account_id").references(() => emailAccounts.id, { onDelete: "set null" }),
  severity: varchar("severity", { length: 40 }).notNull(),
  reason: varchar("reason", { length: 160 }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  metadata: metadata(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  openFlagsIdx: index("abuse_flags_open_idx").on(table.workspaceId, table.severity).where(sql`resolved_at is null`),
}));

export const templates = pgTable("templates", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  bodyHtml: text("body_html"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => ({
  workspaceNameIdx: uniqueIndex("templates_workspace_name_idx").on(table.workspaceId, table.name),
}));

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 80 }).notNull().default("free"),
  status: varchar("status", { length: 80 }).notNull().default("active"),
  currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }),
  dodoCustomerId: text("dodo_customer_id"),
  dodoSubscriptionId: text("dodo_subscription_id"),
  productId: text("product_id"),
  nextBillingDate: timestamp("next_billing_date", { withTimezone: true }),
  trialEnd: timestamp("trial_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  metadata: metadata(),
  ...timestamps,
}, (table) => ({
  workspaceIdx: uniqueIndex("subscriptions_workspace_idx").on(table.workspaceId),
  dodoSubscriptionIdx: uniqueIndex("subscriptions_dodo_subscription_idx").on(table.dodoSubscriptionId).where(sql`dodo_subscription_id is not null`),
}));

export const billingCheckoutIntents = pgTable("billing_checkout_intents", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  productKey: varchar("product_key", { length: 16 }).notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  checkoutUrl: text("checkout_url"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: uuid("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  type: varchar("type", { length: 160 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  webhookIdIdx: uniqueIndex("processed_webhook_events_webhook_id_idx").on(table.webhookId),
}));

export const usageCounters = pgTable("usage_counters", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  counterKey: varchar("counter_key", { length: 120 }).notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  value: integer("value").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCounterPeriodIdx: uniqueIndex("usage_counters_workspace_counter_period_idx").on(table.workspaceId, table.counterKey, table.periodStart),
}));

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 160 }).notNull(),
  entityType: varchar("entity_type", { length: 120 }).notNull(),
  entityId: uuid("entity_id"),
  correlationId: varchar("correlation_id", { length: 120 }),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  metadata: metadata(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreatedIdx: index("audit_logs_workspace_created_idx").on(table.workspaceId, table.createdAt),
  entityIdx: index("audit_logs_entity_idx").on(table.entityType, table.entityId),
  correlationIdx: index("audit_logs_correlation_idx").on(table.correlationId),
}));

export const affiliateReferralStatusEnum = pgEnum("affiliate_referral_status", ["signed_up", "paid"]);
export const affiliateCommissionStatusEnum = pgEnum("affiliate_commission_status", ["pending", "paid", "reversed"]);

export const affiliateCodes = pgTable("affiliate_codes", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 32 }).notNull(),
  clicks: integer("clicks").notNull().default(0),
  commissionPercent: integer("commission_percent"),
  commissionMonths: integer("commission_months"),
  ...timestamps,
}, (table) => ({
  workspaceIdx: uniqueIndex("affiliate_codes_workspace_idx").on(table.workspaceId),
  codeIdx: uniqueIndex("affiliate_codes_code_idx").on(table.code),
}));

export const affiliateReferrals = pgTable("affiliate_referrals", {
  id: uuid("id").primaryKey(),
  affiliateWorkspaceId: uuid("affiliate_workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  referredWorkspaceId: uuid("referred_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  code: varchar("code", { length: 32 }).notNull(),
  status: affiliateReferralStatusEnum("status").notNull().default("signed_up"),
  firstPaidAt: timestamp("first_paid_at", { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  affiliateWorkspaceIdx: index("affiliate_referrals_affiliate_workspace_idx").on(table.affiliateWorkspaceId),
  referredWorkspaceIdx: uniqueIndex("affiliate_referrals_referred_workspace_idx").on(table.referredWorkspaceId),
}));

export const affiliateCommissions = pgTable("affiliate_commissions", {
  id: uuid("id").primaryKey(),
  referralId: uuid("referral_id").notNull().references(() => affiliateReferrals.id, { onDelete: "cascade" }),
  affiliateWorkspaceId: uuid("affiliate_workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  dodoPaymentId: text("dodo_payment_id").notNull(),
  paymentAmountCents: integer("payment_amount_cents").notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  commissionPercent: integer("commission_percent").notNull(),
  commissionCents: integer("commission_cents").notNull(),
  status: affiliateCommissionStatusEnum("status").notNull().default("pending"),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  ...timestamps,
}, (table) => ({
  affiliateWorkspaceIdx: index("affiliate_commissions_affiliate_workspace_idx").on(table.affiliateWorkspaceId),
  dodoPaymentIdx: uniqueIndex("affiliate_commissions_dodo_payment_idx").on(table.dodoPaymentId),
}));

// A refund can arrive before the payment webhook it refunds. The marker lets the late
// payment record its commission already reversed.
export const affiliateRefundedPayments = pgTable("affiliate_refunded_payments", {
  dodoPaymentId: text("dodo_payment_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
