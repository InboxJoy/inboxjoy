-- Better Auth 1.7.0 to 1.7.2 identified sign-in accounts by (issuer, account_id)
-- and required issuer. 1.7.3 went back to (provider_id, account_id) and never
-- writes issuer, so new accounts would fail the NOT NULL. Keep the column (rows
-- created before the upgrade have it) but stop requiring it, as the Better Auth
-- 1.7 upgrade guide says, and replace its unique index with a plain lookup index
-- on the pair Better Auth now queries by. The new index is not unique so this
-- migration cannot fail on accounts that already share a pair.
ALTER TABLE auth_accounts ALTER COLUMN issuer DROP NOT NULL;
DROP INDEX IF EXISTS auth_accounts_issuer_account_idx;
CREATE INDEX IF NOT EXISTS auth_accounts_provider_account_idx ON auth_accounts (provider_id, account_id);
