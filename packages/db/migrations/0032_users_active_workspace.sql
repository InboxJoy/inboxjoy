ALTER TABLE users
  ADD COLUMN active_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
