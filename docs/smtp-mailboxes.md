# SMTP/IMAP mailbox connections (Phase 3)

This phase stores encrypted credentials and verifies SMTP/IMAP connections. It
does not implement SMTP sending or IMAP polling. Apply migrations through
`0034_mailbox_credentials.sql` before enabling the feature.

## Configuration

Both the API and worker validate these environment variables:

- `SMTP_MAILBOXES_ENABLED`: defaults to `false`; use `true` to enable the API.
- `MAILBOX_CREDENTIALS_KEY`: base64-encoded 32-byte AES key, required when enabled.
- `MAILBOX_CREDENTIALS_KEY_PREVIOUS`: optional previous base64-encoded 32-byte key.
- `SMTP_ALLOW_PRIVATE_HOSTS`: defaults to `false`; development-only escape hatch
  for DNS names resolving to private addresses. IP literals remain disallowed.

Keep keys server-side and backed up securely. Envelopes use AES-256-GCM, a random
12-byte IV and account/field-bound AAD. The API derives a stable positive integer
key version from the key's SHA-256 fingerprint; adding/removing the previous key
does not change the current key's version. To rotate, retain the old key as
`MAILBOX_CREDENTIALS_KEY_PREVIOUS`, set a new current key and successfully PATCH
each existing mailbox to re-encrypt both passwords. Verification alone does not
re-encrypt stored credentials. Do not remove the previous key until all its
credentials have been re-encrypted.

## API contracts

- `POST /v1/inboxes/smtp`: accepts `email`, optional `displayName`, and `smtp`/
  `imap` objects with `host`, `port`, `secure`, `username`, `password`. Both
  connections must verify before the account and encrypted credentials are
  inserted in one transaction. The initial IMAP cursor starts at `uidNext - 1`.
  Duplicate active normalized addresses in a workspace return `409`.
- `PATCH /v1/inboxes/:id/smtp`: accepts partial SMTP/IMAP settings and optional
  `email`/`displayName`. Omitted passwords retain their existing value. Active
  duplicate normalized addresses remain blocked. Verification failure retains old settings
  and credentials and records a sanitized error with account status `error`.
- `POST /v1/inboxes/:id/verify`: checks existing connections and updates health
  and verification timestamps without advancing the polling cursor.
- `GET /v1/inboxes`: adds `features.smtp` and non-secret SMTP/IMAP connection
  objects. No endpoint returns stored passwords or ciphertext.

The three SMTP write endpoints return `404` while disabled and require owner or
admin permissions. Verification attempts share a budget of ten per workspace per
hour across all three endpoints, using the registered Fastify rate limiter's
process-local store. SMTP allows ports `25`, `465`, `587`, `2525`; IMAP allows
`143`, `993`. Plain-port connections require STARTTLS; certificate validation is
always enabled. Connection failures return `400` with `{ error, field }`.

## Validation

Unit coverage lives in `packages/core/test/secret-box.test.ts`,
`packages/core/test/mailbox-credentials.test.ts`, `packages/smtp/test/`,
`apps/api/test/inboxes-smtp.test.ts`, `apps/api/test/smtp-env.test.ts` and
`apps/worker/test/env.test.ts`. Database coverage lives in
`apps/api/test/inboxes-smtp.integration.test.ts`; run it only against an isolated,
migrated test database. It skips without `DATABASE_URL`, which is not a passing
database regression check. Provider checks in automated tests use injected
transport/client factories, not live mail servers.
