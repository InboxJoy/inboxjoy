CREATE TYPE workspace_status AS ENUM ('active', 'paused', 'disabled');
CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE membership_status AS ENUM ('invited', 'active', 'disabled');
CREATE TYPE mailbox_provider AS ENUM ('gmail', 'outlook');
CREATE TYPE mailbox_status AS ENUM ('connecting', 'active', 'paused', 'expired', 'error', 'disconnected');
CREATE TYPE import_status AS ENUM ('draft', 'validating', 'ready', 'committed', 'failed', 'cancelled');
CREATE TYPE sequence_status AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');
CREATE TYPE enrollment_status AS ENUM ('scheduled', 'active', 'paused', 'replied', 'bounced', 'unsubscribed', 'completed', 'cancelled');
CREATE TYPE message_status AS ENUM ('scheduled', 'claimed', 'sending', 'accepted', 'retryable', 'failed', 'cancelled');
CREATE TYPE webhook_status AS ENUM ('received', 'processed', 'ignored', 'failed');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email varchar(320) NOT NULL,
  normalized_email varchar(320) NOT NULL,
  display_name varchar(160),
  avatar_url text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_normalized_email_idx ON users (normalized_email);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX sessions_user_expires_idx ON sessions (user_id, expires_at);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  slug varchar(80) NOT NULL,
  status workspace_status NOT NULL DEFAULT 'active',
  default_timezone varchar(80) NOT NULL DEFAULT 'UTC',
  daily_send_cap integer NOT NULL DEFAULT 200,
  kill_switch_enabled boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workspaces_slug_idx ON workspaces (slug);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'member',
  status membership_status NOT NULL DEFAULT 'active',
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX memberships_workspace_user_idx ON memberships (workspace_id, user_id);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  normalized_email varchar(320) NOT NULL,
  role workspace_role NOT NULL DEFAULT 'member',
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invitations_token_hash_idx ON invitations (token_hash);
CREATE UNIQUE INDEX invitations_workspace_email_open_idx ON invitations (workspace_id, normalized_email) WHERE accepted_at IS NULL;

CREATE TABLE email_accounts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider mailbox_provider NOT NULL,
  composio_connected_account_id text NOT NULL,
  email varchar(320) NOT NULL,
  normalized_email varchar(320) NOT NULL,
  display_name varchar(160),
  alias varchar(80) NOT NULL,
  status mailbox_status NOT NULL DEFAULT 'connecting',
  timezone varchar(80) NOT NULL DEFAULT 'UTC',
  daily_limit integer NOT NULL DEFAULT 20,
  hourly_limit integer NOT NULL DEFAULT 5,
  ramp_started_on date,
  last_health_check_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_accounts_daily_limit_positive CHECK (daily_limit >= 0),
  CONSTRAINT email_accounts_hourly_limit_positive CHECK (hourly_limit >= 0)
);

CREATE UNIQUE INDEX email_accounts_composio_account_idx ON email_accounts (composio_connected_account_id);
CREATE UNIQUE INDEX email_accounts_workspace_alias_idx ON email_accounts (workspace_id, alias);
CREATE INDEX email_accounts_workspace_email_idx ON email_accounts (workspace_id, normalized_email);
CREATE INDEX email_accounts_active_idx ON email_accounts (workspace_id, status);

CREATE TABLE mailbox_schedules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  day_of_week integer NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  timezone varchar(80) NOT NULL DEFAULT 'UTC',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_schedules_day_range CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT mailbox_schedules_time_order CHECK (start_time < end_time)
);

CREATE UNIQUE INDEX mailbox_schedules_mailbox_day_idx ON mailbox_schedules (email_account_id, day_of_week);

CREATE TABLE mailbox_daily_usage (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  accepted_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  retry_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_account_id, usage_date)
);

CREATE INDEX mailbox_daily_usage_workspace_date_idx ON mailbox_daily_usage (workspace_id, usage_date);

CREATE TABLE sender_health (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  status varchar(40) NOT NULL DEFAULT 'unknown',
  hard_bounce_rate_basis_points integer NOT NULL DEFAULT 0,
  complaint_rate_basis_points integer NOT NULL DEFAULT 0,
  last_error_class varchar(120),
  checked_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX sender_health_mailbox_checked_idx ON sender_health (email_account_id, checked_at);

CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  normalized_email varchar(320) NOT NULL,
  first_name varchar(120),
  last_name varchar(120),
  company varchar(180),
  title varchar(180),
  website text,
  phone varchar(80),
  location varchar(180),
  linkedin_url text,
  source varchar(120),
  lawful_basis_note text,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(40) NOT NULL DEFAULT 'active',
  replied_at timestamptz,
  bounced_at timestamptz,
  unsubscribed_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contacts_workspace_normalized_email_idx ON contacts (workspace_id, normalized_email);
CREATE INDEX contacts_workspace_status_idx ON contacts (workspace_id, status);

CREATE TABLE contact_lists (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  description text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contact_lists_workspace_name_idx ON contact_lists (workspace_id, name);

CREATE TABLE contact_list_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_list_id uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_list_id, contact_id)
);

CREATE INDEX contact_list_members_contact_idx ON contact_list_members (contact_id);

CREATE TABLE contact_custom_fields (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key varchar(80) NOT NULL,
  label varchar(120) NOT NULL,
  field_type varchar(40) NOT NULL DEFAULT 'text',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contact_custom_fields_workspace_key_idx ON contact_custom_fields (workspace_id, key);

CREATE TABLE imports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_list_id uuid REFERENCES contact_lists(id) ON DELETE SET NULL,
  status import_status NOT NULL DEFAULT 'draft',
  file_name varchar(240),
  idempotency_key text,
  field_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows integer NOT NULL DEFAULT 0,
  created_rows integer NOT NULL DEFAULT 0,
  updated_rows integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  suppressed_rows integer NOT NULL DEFAULT 0,
  rejected_rows integer NOT NULL DEFAULT 0,
  error_csv_path text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX imports_workspace_status_idx ON imports (workspace_id, status);
CREATE UNIQUE INDEX imports_workspace_idempotency_idx ON imports (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE import_rows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  normalized_email varchar(320),
  status varchar(40) NOT NULL,
  error_code varchar(80),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX import_rows_import_row_idx ON import_rows (import_id, row_number);
CREATE INDEX import_rows_import_status_idx ON import_rows (import_id, status);

CREATE TABLE lead_searches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider varchar(80) NOT NULL,
  query jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_credits integer NOT NULL DEFAULT 0,
  idempotency_key text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lead_searches_workspace_created_idx ON lead_searches (workspace_id, created_at);
CREATE UNIQUE INDEX lead_searches_workspace_idempotency_idx ON lead_searches (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE sourced_leads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_search_id uuid REFERENCES lead_searches(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  provider varchar(80) NOT NULL,
  provider_record_id text NOT NULL,
  attribution text,
  sourced_at timestamptz NOT NULL DEFAULT now(),
  retention_ends_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX sourced_leads_workspace_provider_record_idx ON sourced_leads (workspace_id, provider, provider_record_id);
CREATE INDEX sourced_leads_contact_idx ON sourced_leads (contact_id);

CREATE TABLE usage_credits (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider varchar(80) NOT NULL,
  amount integer NOT NULL,
  reason varchar(120) NOT NULL,
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_credits_workspace_created_idx ON usage_credits (workspace_id, created_at);

CREATE TABLE sequences (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name varchar(180) NOT NULL,
  status sequence_status NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sequences_workspace_status_idx ON sequences (workspace_id, status);

CREATE TABLE sequence_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status sequence_status NOT NULL DEFAULT 'draft',
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  launched_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sequence_versions_sequence_version_idx ON sequence_versions (sequence_id, version);
CREATE INDEX sequence_versions_workspace_status_idx ON sequence_versions (workspace_id, status);
ALTER TABLE sequences ADD CONSTRAINT sequences_current_version_fk FOREIGN KEY (current_version_id) REFERENCES sequence_versions(id) ON DELETE SET NULL;

CREATE TABLE sequence_steps (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_version_id uuid NOT NULL REFERENCES sequence_versions(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  delay_days integer NOT NULL DEFAULT 0,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequence_steps_order_positive CHECK (step_order > 0),
  CONSTRAINT sequence_steps_delay_nonnegative CHECK (delay_days >= 0)
);

CREATE UNIQUE INDEX sequence_steps_version_order_idx ON sequence_steps (sequence_version_id, step_order);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  sequence_version_id uuid NOT NULL REFERENCES sequence_versions(id) ON DELETE RESTRICT,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE RESTRICT,
  status enrollment_status NOT NULL DEFAULT 'scheduled',
  next_step_order integer NOT NULL DEFAULT 1,
  next_due_at timestamptz,
  started_at timestamptz,
  stopped_at timestamptz,
  stop_reason varchar(80),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX enrollments_contact_version_idx ON enrollments (workspace_id, contact_id, sequence_version_id);
CREATE INDEX enrollments_active_mailbox_due_idx ON enrollments (email_account_id, next_due_at) WHERE status IN ('scheduled', 'active');
CREATE INDEX enrollments_workspace_status_idx ON enrollments (workspace_id, status);

CREATE TABLE conversation_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider_thread_id text,
  last_internet_message_id text,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_threads_provider_thread_idx ON conversation_threads (workspace_id, provider_thread_id);
CREATE INDEX conversation_threads_internet_message_idx ON conversation_threads (workspace_id, last_internet_message_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  sequence_step_id uuid NOT NULL REFERENCES sequence_steps(id) ON DELETE RESTRICT,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_thread_id uuid REFERENCES conversation_threads(id) ON DELETE SET NULL,
  status message_status NOT NULL DEFAULT 'scheduled',
  attempt_kind varchar(40) NOT NULL DEFAULT 'sequence',
  idempotency_key text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  accepted_at timestamptz,
  provider_message_id text,
  provider_thread_id text,
  internet_message_id text,
  recipient_email varchar(320) NOT NULL,
  normalized_recipient_email varchar(320) NOT NULL,
  subject text NOT NULL,
  body_hash text NOT NULL,
  error_class varchar(120),
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX messages_idempotency_key_idx ON messages (idempotency_key);
CREATE INDEX messages_due_idx ON messages (scheduled_at) WHERE status IN ('scheduled', 'retryable');
CREATE INDEX messages_provider_thread_idx ON messages (workspace_id, provider_thread_id);
CREATE INDEX messages_internet_message_idx ON messages (workspace_id, internet_message_id);
CREATE INDEX messages_enrollment_idx ON messages (enrollment_id);

CREATE TABLE send_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  status message_status NOT NULL,
  provider_status_code integer,
  provider_message_id text,
  provider_thread_id text,
  internet_message_id text,
  error_class varchar(120),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT send_attempts_number_positive CHECK (attempt_number > 0)
);

CREATE UNIQUE INDEX send_attempts_message_attempt_idx ON send_attempts (message_id, attempt_number);

CREATE TABLE message_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  event_type varchar(80) NOT NULL,
  provider_event_id text,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX message_events_provider_event_idx ON message_events (workspace_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX message_events_message_occurred_idx ON message_events (message_id, occurred_at);

CREATE TABLE suppressions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email varchar(320),
  normalized_email varchar(320),
  email_hash text NOT NULL,
  reason varchar(80) NOT NULL,
  source varchar(80) NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX suppressions_workspace_email_idx ON suppressions (workspace_id, normalized_email) WHERE normalized_email IS NOT NULL;
CREATE UNIQUE INDEX suppressions_workspace_hash_idx ON suppressions (workspace_id, email_hash);

CREATE TABLE unsubscribes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  suppression_id uuid NOT NULL REFERENCES suppressions(id) ON DELETE CASCADE,
  signed_token_hash text NOT NULL,
  user_agent text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX unsubscribes_token_hash_idx ON unsubscribes (signed_token_hash);

CREATE TABLE provider_webhook_events (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  provider varchar(80) NOT NULL,
  event_id text,
  log_id text,
  signature_timestamp timestamptz,
  payload_hash text NOT NULL,
  status webhook_status NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_class varchar(120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX provider_webhook_events_event_idx ON provider_webhook_events (provider, event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX provider_webhook_events_log_idx ON provider_webhook_events (provider, log_id) WHERE log_id IS NOT NULL;
CREATE INDEX provider_webhook_events_payload_hash_idx ON provider_webhook_events (payload_hash);
CREATE INDEX provider_webhook_events_status_received_idx ON provider_webhook_events (status, received_at);

CREATE TABLE abuse_flags (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  severity varchar(40) NOT NULL,
  reason varchar(160) NOT NULL,
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX abuse_flags_open_idx ON abuse_flags (workspace_id, severity) WHERE resolved_at IS NULL;

CREATE TABLE templates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX templates_workspace_name_idx ON templates (workspace_id, name);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan varchar(80) NOT NULL DEFAULT 'free',
  status varchar(80) NOT NULL DEFAULT 'active',
  current_period_ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscriptions_workspace_idx ON subscriptions (workspace_id);

CREATE TABLE usage_counters (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counter_key varchar(120) NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  value integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX usage_counters_workspace_counter_period_idx ON usage_counters (workspace_id, counter_key, period_start);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(160) NOT NULL,
  entity_type varchar(120) NOT NULL,
  entity_id uuid,
  correlation_id varchar(120),
  ip_hash text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_workspace_created_idx ON audit_logs (workspace_id, created_at);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_correlation_idx ON audit_logs (correlation_id);
