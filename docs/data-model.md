# InboxJoy data model

Read [architecture](../architecture.md) and
[regression guardrails](regression-guardrails.md) before changing campaign
relationships or state transitions.

The database is PostgreSQL 16. All workspace-owned records carry a
`workspace_id`; timestamps are stored with time zones. The canonical schema is
`packages/db/src/schema.ts`, and migrations live in `packages/db/migrations/`.

## Main table groups

This is a grouped overview, not an exhaustive schema inventory. Consult the
canonical schema for all columns, constraints and tables.

- **Identity and workspace:** app `users`/`sessions`, Better Auth
  `auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, plus
  `workspaces`, `memberships`, and `invitations`.
- **API/MCP access:** `api_keys`, `oauth_clients`, `mcp_grants`,
  `mcp_oauth_codes`, and `mcp_oauth_tokens`.
- **Mailboxes and sender safety:** `email_accounts`, `connect_states`,
  `mailbox_schedules`, `mailbox_daily_usage`, `mailbox_health`, and
  `provider_circuit`.
- **Leads and imports:** `contacts`, `contact_lists`, `contact_list_members`,
  `contact_custom_fields`, `imports`, `import_rows`, `lead_searches`,
  `sourced_leads`, and `usage_credits`.
- **Sequences:** `sequences`, `sequence_versions`, `sequence_steps`, and
  `sequence_email_accounts`.
  Publishing moves a sequence to the `active` database state. The API returns
  this as `published` for the web UI.
- **Campaigns and audiences:** `campaigns` and `campaign_contact_lists`.
- **Enrollment and delivery:** `enrollments`, `conversation_threads`,
  `messages`, `send_attempts`, `message_events`, and `replies`.
- **Compliance and provider events:** `suppressions`, `unsubscribes`,
  `provider_webhook_events`, and `abuse_flags`.
- **Billing:** `subscriptions`, `billing_checkout_intents`, and
  `processed_webhook_events`.
- **Workspace configuration and operations:** `templates`, `usage_counters`,
  `audit_logs`, and `worker_heartbeats`.

## Important relationships

An `email_account` belongs to a workspace and represents a Gmail or Outlook
sender connected through Composio. A contact can belong to many contact lists.
A sequence has versioned steps; an enrollment joins one contact, one sequence
version, and one sender. Message delivery has send attempts and message events;
provider webhook receipts are stored separately. Suppressions and unsubscribe
records are workspace-wide safety checks.

`sequence_email_accounts` stores an optional sender selection keyed by
`(sequence_id, email_account_id)`, with `workspace_id` and `created_at`. Its
foreign keys cascade on deletion and `email_account_id` is indexed. Migration
`0029_sequence_email_accounts.sql` adds no backfill: zero selection rows mean
the pre-existing rotation across all healthy workspace senders. Existing
sequences and enrollments do not change until a user explicitly saves a set.

The assigned sender is stored in both `enrollments.email_account_id` and
`messages.email_account_id`. Worker queue payloads identify the enrollment,
step, workspace, and idempotency key, not the mailbox; claims read the sender
from `messages`. Reassignment updates only scheduled/retryable message rows
and their eligible scheduled/active/paused enrollment, in one transaction and
a fixed number of set-based statements. It takes the worker's
`send-capacity:<workspaceId>` advisory lock plus enrollment and message row
locks, then rechecks enrollment/message eligibility in the update. An
enrollment paused with `stop_reason = 'mailbox_auth_expired'` returns to its
`status_before_pause` when it moves; other paused enrollments stay paused.
Accepted/sent, claimed/sending, recorded acceptance, and uncertain provider
results preserve the sender, including pending follow-ups. No conversation
thread or historical send-attempt sender is rewritten.

## Operational states

Campaign `status` uses the shared `sequence_status` enum: `draft`, `active`, `paused`,
`completed`, and `archived`. `campaigns.completed_at` is the nullable timestamp
of the latest finish, retained across restarts. Migration
`0030_campaign_completed_at.sql` backfills completed campaigns from `updated_at`.
Workspace-scoped reconciliation locks the campaign: launched active campaigns
finish when no scheduled/active/paused enrollments remain; completed campaigns
restart as active only when the enrollment path has just added leads. Draft,
paused and archived campaigns never transition automatically. Each transition
records an in-app `campaign_completed` or `campaign_restarted` notification; the
five-minute worker sweep is finish-only and records none.

Campaign responses include `displayStatus`, `statusReason`, and `completedAt`.
Completed displays as `finished`; an active campaign displays as
`needs_attention` when workspace sending is disabled, its sequence is inactive,
or all in-progress enrollments are paused by mailbox authentication/repeated
provider failures. Display state does not change send gating or stored status.

Mailbox states are `connecting`, `active`, `paused`, `expired`, `error`, and
`disconnected`. Enrollment states include `scheduled`, `active`, `paused`,
`replied`, `bounced`, `unsubscribed`, `completed`, and `cancelled`. Message
states include `scheduled`, `claimed`, `sending`, `accepted`, `retryable`,
`failed`, and `cancelled`.

## Current limitations

Production routes use authenticated session/API-key workspace scope and
permission checks; a new read endpoint must preserve that boundary. Analytics
are derived from operational records and API projections, not a separate
analytics table. Deployment applies migrations before replacing application
services. Application rollback does not undo migrations; never edit a shipped
migration, and keep new migrations compatible with the previous release.
