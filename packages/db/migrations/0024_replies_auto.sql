ALTER TABLE replies ADD COLUMN is_auto_reply boolean NOT NULL DEFAULT false;

CREATE INDEX replies_workspace_human_idx ON replies (workspace_id, received_at DESC) WHERE is_auto_reply = false;
