-- 0002 seeded a placeholder owner on every install: profile ...0002
-- (hey@replyless.ai, no sign-in account), the "InboxJoy" workspace ...0001 and
-- the owner membership ...0003. A self-hosted server has no use for it: it is
-- someone else's address owning an empty workspace. This removes those three
-- rows, all or nothing, only when the seed was never claimed and holds nothing.
--
-- Why this is a no-op on production: there 0038 claimed the address. A real
-- hey@replyless.ai sign-in account exists (guard 1) and 0038 made it a second
-- owner of workspace ...0001, which also holds campaign data (guard 3). Either
-- guard alone stops this migration before it deletes anything.
--
-- Guard 3 checks every foreign key that points at users or workspaces, read
-- from the catalog rather than a hand-kept list, so a table added later is
-- covered too. Deleting the workspace cascades only to rows that reference it;
-- the guard has already proven the only such row is membership ...0003. Deleting
-- the profile then has nothing left to cascade to or set null.

DO $$
DECLARE
  placeholder_user_id constant uuid := '00000000-0000-4000-8000-000000000002';
  bootstrap_workspace_id constant uuid := '00000000-0000-4000-8000-000000000001';
  bootstrap_membership_id constant uuid := '00000000-0000-4000-8000-000000000003';
  seeded_ids constant uuid[] := ARRAY[placeholder_user_id, bootstrap_workspace_id, bootstrap_membership_id];
  fk record;
  referenced boolean;
BEGIN
  -- Guard 1: the seed was never claimed. No sign-in account has the placeholder
  -- id or the address it was seeded with.
  IF EXISTS (
    SELECT 1 FROM auth_users
    WHERE id = placeholder_user_id OR lower(email) = 'hey@replyless.ai'
  ) THEN
    RETURN;
  END IF;

  -- Guard 2: the rows are still the seed itself. A membership ...0003 that is
  -- not the placeholder's ownership of ...0001, or a workspace ...0001 created
  -- by someone else, means the ids were reused, so leave them alone.
  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE id = bootstrap_membership_id
      AND (workspace_id <> bootstrap_workspace_id OR user_id <> placeholder_user_id)
  ) OR EXISTS (
    SELECT 1 FROM workspaces
    WHERE id = bootstrap_workspace_id
      AND created_by_user_id IS DISTINCT FROM placeholder_user_id
  ) THEN
    RETURN;
  END IF;

  -- Guard 3: nothing but the three seeded rows references the profile or the
  -- workspace: no other member, invitation, lead, list, sequence, campaign,
  -- mailbox, message, API key, subscription, suppression or anything else.
  FOR fk IN
    SELECT c.conrelid::regclass AS source_table,
           a.attname AS source_column,
           c.confrelid::regclass AS target_table
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(source_attnum, target_attnum)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.source_attnum
    JOIN pg_attribute t ON t.attrelid = c.confrelid AND t.attnum = k.target_attnum
    WHERE c.contype = 'f'
      AND c.confrelid IN ('users'::regclass, 'workspaces'::regclass)
      AND t.attname = 'id'
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s r WHERE r.%I = $1%s)',
      fk.source_table,
      fk.source_column,
      CASE WHEN fk.source_table IN ('users'::regclass, 'workspaces'::regclass, 'memberships'::regclass)
        THEN ' AND r.id <> ALL ($2)'
        ELSE ''
      END
    )
    INTO referenced
    USING CASE WHEN fk.target_table = 'users'::regclass THEN placeholder_user_id ELSE bootstrap_workspace_id END,
      seeded_ids;
    IF referenced THEN
      RETURN;
    END IF;
  END LOOP;

  DELETE FROM memberships WHERE id = bootstrap_membership_id;
  DELETE FROM workspaces WHERE id = bootstrap_workspace_id;
  DELETE FROM users WHERE id = placeholder_user_id;
END $$;
