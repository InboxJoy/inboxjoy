CREATE TABLE staged_enrollments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- The campaign (if any) this queue entry is for, resolved at staging time the
  -- same way direct enrollment resolves campaign association. Nullable: a
  -- sequence-level enroll with no single matching campaign stays campaign-less.
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  -- The explicit sender mailboxes requested at staging time (inboxId/inboxIds),
  -- normalized to an array. Null means "use saved/rotation mailboxes" at convert time.
  inbox_ids uuid[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX staged_enrollments_sequence_lead_idx ON staged_enrollments (sequence_id, lead_id);
CREATE INDEX staged_enrollments_workspace_idx ON staged_enrollments (workspace_id, sequence_id);
CREATE INDEX staged_enrollments_campaign_idx ON staged_enrollments (campaign_id) WHERE campaign_id IS NOT NULL;
