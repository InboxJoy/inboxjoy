CREATE TABLE replies (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  sequence_id uuid REFERENCES sequences(id) ON DELETE SET NULL,
  email_account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  in_reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  provider_message_id text,
  provider_thread_id text,
  subject text,
  body_text text,
  snippet varchar(320),
  from_email varchar(320) NOT NULL,
  received_at timestamptz NOT NULL,
  read_at timestamptz,
  source varchar(16) NOT NULL DEFAULT 'webhook',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX replies_workspace_provider_message_idx ON replies (workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX replies_workspace_received_idx ON replies (workspace_id, received_at DESC);
CREATE INDEX replies_workspace_unread_idx ON replies (workspace_id, read_at) WHERE read_at IS NULL;

CREATE INDEX message_events_workspace_type_idx ON message_events (workspace_id, event_type);
