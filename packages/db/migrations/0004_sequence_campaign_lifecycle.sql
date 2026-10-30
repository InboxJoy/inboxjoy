ALTER TABLE sequences ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS status_before_pause enrollment_status;

CREATE INDEX IF NOT EXISTS enrollments_sequence_paused_idx
  ON enrollments (sequence_id, status) WHERE status = 'paused';
