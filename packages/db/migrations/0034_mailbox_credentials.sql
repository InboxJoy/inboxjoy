CREATE TABLE mailbox_credentials (
  email_account_id uuid PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  smtp_host text NOT NULL, smtp_port integer NOT NULL, smtp_secure boolean NOT NULL DEFAULT true,
  smtp_username text NOT NULL, smtp_password_encrypted text NOT NULL,
  imap_host text NOT NULL, imap_port integer NOT NULL, imap_secure boolean NOT NULL DEFAULT true,
  imap_username text NOT NULL, imap_password_encrypted text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  verified_at timestamptz, last_verify_error text,
  last_imap_uid bigint, last_imap_uidvalidity bigint, last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mailbox_credentials_poll_idx ON mailbox_credentials (last_polled_at NULLS FIRST);
