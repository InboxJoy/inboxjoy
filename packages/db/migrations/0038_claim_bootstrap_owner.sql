-- 0002 seeded a users row for hey@replyless.ai (id ...0002, owner of the
-- bootstrap "InboxJoy" workspace ...0001) with no sign-in account behind it.
-- When that address signed up for real, provisioning hit the unique
-- normalized_email index and the account was left with no profile.
--
-- For the real hey@replyless.ai sign-in account this:
--   1. releases the email from the placeholder row,
--   2. creates the account's profile,
--   3. creates its personal workspace exactly as provisionWorkspace would
--      (same deterministic id, name and slug), and
--   4. adds it as an owner of the bootstrap workspace when that still exists,
-- so both workspaces appear in the workspace switcher.
-- It is a no-op where that address has no sign-in account (dev, test, fresh installs).

UPDATE users
SET normalized_email = left(normalized_email, 260) || '#unclaimed-' || id::text,
    updated_at = now()
WHERE id = '00000000-0000-4000-8000-000000000002'
  AND normalized_email = 'hey@replyless.ai'
  AND NOT EXISTS (SELECT 1 FROM auth_users a WHERE a.id = users.id)
  AND EXISTS (SELECT 1 FROM auth_users a WHERE lower(a.email) = 'hey@replyless.ai');

INSERT INTO users (id, email, normalized_email, display_name, avatar_url)
SELECT a.id, a.email, lower(a.email), a.name, a.image
FROM auth_users a
WHERE lower(a.email) = 'hey@replyless.ai'
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.normalized_email = lower(a.email))
ON CONFLICT (id) DO NOTHING;

-- Mirrors workspaceIdForUser / workspaceSlug in apps/api/src/auth.ts.
WITH owner AS (
  SELECT a.id, a.name,
    substring(sha256(convert_to('inboxjoy-workspace:' || a.id::text, 'UTF8')) FROM 1 FOR 16) AS digest
  FROM auth_users a
  JOIN users u ON u.id = a.id
  WHERE lower(a.email) = 'hey@replyless.ai'
), shaped AS (
  SELECT id, name,
    encode(set_byte(set_byte(digest, 6, (get_byte(digest, 6) & 15) | 80), 8, (get_byte(digest, 8) & 63) | 128), 'hex')::uuid AS workspace_id
  FROM owner
)
INSERT INTO workspaces (id, name, slug, status, default_timezone, daily_send_cap, kill_switch_enabled, created_by_user_id)
SELECT workspace_id,
  coalesce(nullif(trim(name), ''), 'My') || '''s workspace',
  coalesce(nullif(left(trim(BOTH '-' FROM regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')), 60), ''), 'workspace')
    || '-' || left(replace(id::text, '-', ''), 12),
  'active', 'UTC', 200, false, id
FROM shaped
ON CONFLICT DO NOTHING;

INSERT INTO memberships (id, workspace_id, user_id, role, status, joined_at)
SELECT gen_random_uuid(), w.id, u.id, 'owner', 'active', now()
FROM auth_users a
JOIN users u ON u.id = a.id
JOIN workspaces w ON w.created_by_user_id = u.id OR w.id = '00000000-0000-4000-8000-000000000001'
WHERE lower(a.email) = 'hey@replyless.ai'
ON CONFLICT (workspace_id, user_id) DO NOTHING;
