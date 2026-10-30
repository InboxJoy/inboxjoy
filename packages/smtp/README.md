# SMTP mail client

`createSmtpMailClient({ smtp, imap, transportFactory?, imapFactory?, now?, logger? })`
returns the core `MailClient` plus a synchronous, idempotent `close()` method.
SMTP uses a pool of two connections. STARTTLS and certificate verification are
required by default; `MailConnectionConfig.requireTLS` and
`MailConnectionConfig.rejectUnauthorized` allow explicit overrides for controlled
test environments. Verification helpers retain their existing strict behavior.

Campaign sends require `unsubscribeUrl` and a pinned, angle-bracketed `messageId`.
Manual replies omit `unsubscribeUrl`, still require `messageId`, and support
`inReplyTo` and a space-separated `references` chain. The returned thread ID is
the root of the emitted MIME References header, or the pinned Message-ID.

Successful SMTP submission is never failed by IMAP Sent-copy errors. Logs and
`SmtpSendError` messages are static and exclude provider responses and secrets.
`findSentMessage` searches the Sent folder by Message-ID. Empty successful
searches produce `not_sent` only when `attemptedAt` is more than ten minutes old;
missing/recent timestamps and IMAP failures produce `unknown`. `after` is not
used as a substitute for the actual submission timestamp.

`createMailClientResolver({ db, keys?, composio, smtpFactory?, now?, ttlMs? })`
returns `{ getMailClientFor({ provider, emailAccountId }), close() }`. Gmail and
Outlook receive the exact shared Composio object. SMTP credentials are read with
`includeSecrets`, and clients are cached for five minutes, coalescing concurrent
loads and closing on expiry or shutdown. Supply the same key-version map used
when writing mailbox credentials; the resolver does not renumber keys.

## Tests

Unit tests inject SMTP/IMAP factories. Resolver tests mock credential reads and
never access a database. The live suite skips unless `SMTP_TEST_HOST` is set.
It sends one real campaign email and requires `SMTP_TEST_USERNAME`,
`SMTP_TEST_PASSWORD`, and `SMTP_TEST_TO`. Optional SMTP variables are
`SMTP_TEST_PORT` (587), `SMTP_TEST_SECURE` (`false`), and `SMTP_TEST_FROM` (username).
IMAP defaults to the SMTP host/credentials with port 993 and implicit TLS;
override using `IMAP_TEST_HOST`, `IMAP_TEST_PORT`, `IMAP_TEST_SECURE`,
`IMAP_TEST_USERNAME`, and `IMAP_TEST_PASSWORD`. The account must expose a usable
Sent folder so the suite can verify the appended copy. Only use controlled
mailboxes and authorized recipients; do not put passwords in command history.
