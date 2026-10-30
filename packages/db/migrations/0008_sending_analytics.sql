CREATE TABLE campaigns (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_list_id uuid REFERENCES contact_lists(id) ON DELETE SET NULL,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE RESTRICT,
  name varchar(180) NOT NULL,
  status sequence_status NOT NULL DEFAULT 'draft',
  launched_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaigns_workspace_status_idx ON campaigns (workspace_id, status);
CREATE INDEX campaigns_sequence_idx ON campaigns (sequence_id);

ALTER TABLE enrollments ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX enrollments_campaign_status_idx ON enrollments (campaign_id, status);

ALTER TABLE messages ADD COLUMN tracking_token varchar(32);
UPDATE messages
SET tracking_token = md5(random()::text || clock_timestamp()::text || id::text)
WHERE tracking_token IS NULL;
ALTER TABLE messages ALTER COLUMN tracking_token SET DEFAULT md5(random()::text || clock_timestamp()::text);
ALTER TABLE messages ALTER COLUMN tracking_token SET NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_tracking_token_hex_check CHECK (tracking_token ~ '^[0-9a-f]{32}$');
CREATE UNIQUE INDEX messages_tracking_token_idx ON messages (tracking_token);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type varchar(80) NOT NULL,
  title varchar(240) NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_workspace_created_idx ON notifications (workspace_id, created_at DESC);
CREATE INDEX notifications_workspace_unread_idx ON notifications (workspace_id, read_at) WHERE read_at IS NULL;
