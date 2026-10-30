ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS email_account_id uuid;
ALTER TABLE enrollments ALTER COLUMN email_account_id DROP NOT NULL;
ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_email_account_id_fkey;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_email_account_id_fkey
  FOREIGN KEY (email_account_id) REFERENCES email_accounts(id) ON DELETE SET NULL;

UPDATE enrollments e
SET email_account_id = m.email_account_id
FROM (
  SELECT DISTINCT ON (enrollment_id) enrollment_id, email_account_id
  FROM messages
  ORDER BY enrollment_id, created_at ASC
) m
WHERE m.enrollment_id = e.id
  AND e.email_account_id IS NULL;
