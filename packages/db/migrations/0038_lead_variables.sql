-- Per-lead, per-sequence custom text variables (e.g. {{icebreaker}}), written
-- mainly through MCP. Keyed on the sequence because the web "campaign" is a
-- sequence row and campaigns can be null or many per sequence.
CREATE TABLE campaign_lead_variables (
  sequence_id uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  "values" jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sequence_id, contact_id),
  CONSTRAINT campaign_lead_variables_values_object_check CHECK (jsonb_typeof("values") = 'object')
);

CREATE INDEX campaign_lead_variables_workspace_contact_idx ON campaign_lead_variables (workspace_id, contact_id);
