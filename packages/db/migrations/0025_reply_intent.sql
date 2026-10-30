ALTER TABLE replies ADD COLUMN intent varchar(16) NOT NULL DEFAULT 'human';

CREATE INDEX replies_workspace_intent_idx ON replies (workspace_id, intent);
