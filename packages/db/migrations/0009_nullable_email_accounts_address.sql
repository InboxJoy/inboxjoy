-- email_accounts.email / normalized_email can no longer be assumed present: the Composio
-- profile-resolution fallback (UX audit item 1) may fail to resolve a real mailbox address,
-- in which case the app stores NULL and the UI renders "Address pending — reconnect"
-- instead of a fabricated address. Relax the NOT NULL constraints to allow that.
ALTER TABLE email_accounts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE email_accounts ALTER COLUMN normalized_email DROP NOT NULL;
