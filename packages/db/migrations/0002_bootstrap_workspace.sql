INSERT INTO users (id, email, normalized_email, display_name)
VALUES ('00000000-0000-4000-8000-000000000002', 'hey@replyless.ai', 'hey@replyless.ai', 'InboxJoy Owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, name, slug, status, default_timezone, daily_send_cap, created_by_user_id)
VALUES ('00000000-0000-4000-8000-000000000001', 'InboxJoy', 'inboxjoy', 'active', 'UTC', 200, '00000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (id, workspace_id, user_id, role, status, joined_at)
VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'owner', 'active', now())
ON CONFLICT (id) DO NOTHING;
