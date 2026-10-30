-- Grandfather sequences that existed before custom lead variables (0038): their
-- versions keep the old rendering ({{unknown}} stays literal text, nothing is gated
-- or cancelled for missing values). Only versions created afterwards enforce
-- custom variables, so existing campaigns cannot change behavior on deploy.
ALTER TABLE sequence_versions ADD COLUMN custom_variables_enforced boolean NOT NULL DEFAULT false;

-- New versions enforce by default.
ALTER TABLE sequence_versions ALTER COLUMN custom_variables_enforced SET DEFAULT true;

-- A draft version has never been published, so it is a "campaign published after this
-- release" and enforces from the start.
UPDATE sequence_versions SET custom_variables_enforced = true WHERE status = 'draft';

-- Bounded scan for campaigns.listLeadVariableNames (most recently updated contacts first).
CREATE INDEX contacts_workspace_updated_idx ON contacts (workspace_id, updated_at);
