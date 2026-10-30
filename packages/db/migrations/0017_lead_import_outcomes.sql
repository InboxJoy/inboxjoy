ALTER TABLE imports ADD COLUMN mode varchar(40) NOT NULL DEFAULT 'add_only';
ALTER TABLE imports ADD COLUMN list_name varchar(160);
ALTER TABLE imports ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE imports ADD COLUMN ready_rows integer NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN create_rows integer NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN update_rows integer NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN unchanged_rows integer NOT NULL DEFAULT 0;
ALTER TABLE imports ADD COLUMN skipped_rows integer NOT NULL DEFAULT 0;

ALTER TABLE import_rows ADD COLUMN action varchar(40) NOT NULL DEFAULT 'rejected';
ALTER TABLE import_rows ADD COLUMN changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE import_rows ADD COLUMN preview_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE import_rows
SET action = CASE status
  WHEN 'ready' THEN 'create'
  WHEN 'duplicate' THEN 'duplicate'
  WHEN 'suppressed' THEN 'suppressed'
  ELSE 'rejected'
END;

UPDATE imports AS i
SET list_name = COALESCE(l.name, 'Imported leads'),
    ready_rows = CASE WHEN i.status = 'committed' THEN i.created_rows ELSE GREATEST(i.total_rows - i.duplicate_rows - i.suppressed_rows - i.rejected_rows, 0) END,
    create_rows = CASE WHEN i.status = 'committed' THEN i.created_rows ELSE GREATEST(i.total_rows - i.duplicate_rows - i.suppressed_rows - i.rejected_rows, 0) END,
    skipped_rows = CASE WHEN i.status = 'committed' THEN GREATEST(i.total_rows - i.created_rows - i.updated_rows, 0) ELSE i.duplicate_rows + i.suppressed_rows + i.rejected_rows END
FROM contact_lists AS l
WHERE i.contact_list_id = l.id;

UPDATE imports
SET list_name = 'Imported leads',
    ready_rows = CASE WHEN status = 'committed' THEN created_rows ELSE GREATEST(total_rows - duplicate_rows - suppressed_rows - rejected_rows, 0) END,
    create_rows = CASE WHEN status = 'committed' THEN created_rows ELSE GREATEST(total_rows - duplicate_rows - suppressed_rows - rejected_rows, 0) END,
    skipped_rows = CASE WHEN status = 'committed' THEN GREATEST(total_rows - created_rows - updated_rows, 0) ELSE duplicate_rows + suppressed_rows + rejected_rows END
WHERE list_name IS NULL;

ALTER TABLE imports ADD CONSTRAINT imports_mode_check
  CHECK (mode IN ('add_only', 'update_only', 'add_and_update'));

ALTER TABLE import_rows ADD CONSTRAINT import_rows_action_check
  CHECK (action IN ('create', 'update', 'unchanged', 'duplicate', 'suppressed', 'rejected', 'not_found'));
