ALTER TABLE mailbox_credentials
  ADD COLUMN imap_poll_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN imap_poll_retry_at timestamptz,
  ADD COLUMN imap_stuck_uid bigint,
  ADD COLUMN imap_stuck_attempts integer NOT NULL DEFAULT 0;
