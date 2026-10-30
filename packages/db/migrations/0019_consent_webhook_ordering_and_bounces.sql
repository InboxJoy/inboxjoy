ALTER TABLE users ADD COLUMN terms_version text;
ALTER TABLE auth_users ADD COLUMN accepted_terms boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN provider_updated_at timestamptz;
ALTER TABLE messages ADD COLUMN bounced_at timestamptz;
