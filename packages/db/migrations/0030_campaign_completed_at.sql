ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE campaigns
SET completed_at = updated_at
WHERE status = 'completed' AND completed_at IS NULL;
