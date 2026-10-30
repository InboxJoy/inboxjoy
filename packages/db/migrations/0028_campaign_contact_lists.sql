CREATE TABLE campaign_contact_lists (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_list_id uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, contact_list_id)
);

CREATE INDEX campaign_contact_lists_contact_list_idx
  ON campaign_contact_lists (contact_list_id);

INSERT INTO campaign_contact_lists (campaign_id, contact_list_id, workspace_id)
SELECT id, contact_list_id, workspace_id
FROM campaigns
WHERE contact_list_id IS NOT NULL
ON CONFLICT DO NOTHING;
