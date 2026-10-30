CREATE TABLE sequence_email_accounts (
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sequence_id, email_account_id)
);

CREATE INDEX sequence_email_accounts_email_account_idx
  ON sequence_email_accounts (email_account_id);
