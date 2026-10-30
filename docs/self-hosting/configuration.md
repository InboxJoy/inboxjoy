# Configuration reference

All settings live in `/opt/inboxjoy/.env`, one `NAME=value` per line. The
installer fills in everything required. To change something, edit the file and
run `inboxjoy restart`.

Rules for the file:

- No spaces around `=` and no quotes needed.
- If a value contains a `$` sign, wrap the value in single quotes:
  `MAIL_SMTP_URL='smtps://user:pa$$word@smtp.example.com:465'`.
- Keep the file private (`chmod 600`) and include it in your off-server backups.

The template with every option is
[`deploy/env.example`](../../deploy/env.example).

## Required (the installer sets these)

| Setting | Default | What it does |
| --- | --- | --- |
| `INBOXJOY_VERSION` | newest release | Which release to run (it is also the version the app reports, for example in workspace exports). `inboxjoy upgrade` changes it. Use a number such as `1.2.3`, or `latest` to follow the newest build when you run `docker compose pull` yourself |
| `APP_DOMAIN` | none | Your domain, without `https://`. Its `A` record must point at this server. Caddy gets the HTTPS certificate for it |
| `ACME_EMAIL` | none | Your email address. Let's Encrypt sends certificate expiry notices here |
| `INBOXJOY_EDITION` | `selfhost` | Which edition runs. Leave as `selfhost`. The value `cloud` is for our hosted service and would block sending until a licence is bought |
| `SIGNUP_MODE` | `invite` | `invite`: the first account becomes the owner and everyone else needs an invitation. `open`: anyone who finds the site can create an account |
| `SETUP_TOKEN` | generated | Protects first-run setup: until the owner account exists, it can only be created from the setup link the installer prints, `https://APP_DOMAIN/app/setup?token=` followed by this value. At least 24 characters. It does nothing once the owner exists. Without it, whoever opens a fresh site first becomes the owner |
| `API_BASE_URL` | `https://APP_DOMAIN/api` | The public address of the API. Derived from your domain |
| `WEB_BASE_URL` | `https://APP_DOMAIN` | The public address of the site, used in links inside emails. Derived from your domain |
| `CORS_ORIGINS` | `https://APP_DOMAIN` | Which sites may call the API from a browser. Derived from your domain |
| `BETTER_AUTH_URL` | `https://APP_DOMAIN/api` | The address the sign-in system uses. Derived from your domain |
| `AUTH_SECRET` | generated | Secret that signs sessions and unsubscribe links. At least 32 characters. Never change it once people use the site (everyone is signed out and old unsubscribe links stop working). `BETTER_AUTH_SECRET` is accepted as an alternative name |
| `POSTGRES_PASSWORD` | generated | Password for the bundled database. Created together with the database: changing it later does not change the database's password |
| `SMTP_MAILBOXES_ENABLED` | `true` | Lets you connect any mailbox with SMTP/IMAP. Needs `MAILBOX_CREDENTIALS_KEY` |
| `MAILBOX_CREDENTIALS_KEY` | generated | Encrypts stored mailbox passwords (a base64 32-byte key). If you lose it, every mailbox must be reconnected. Back it up |

To change your domain, change `APP_DOMAIN`, `API_BASE_URL`, `WEB_BASE_URL`,
`CORS_ORIGINS` and `BETTER_AUTH_URL` together, point the new domain's DNS at
the server, and run `inboxjoy restart web api worker caddy`.

## System email (recommended)

Password resets, invitations and alerts are sent by InboxJoy itself through an
SMTP service. See [system email](system-email.md) for providers and examples.

| Setting | Default | What it does |
| --- | --- | --- |
| `MAIL_SMTP_URL` | none | Where to send system email, as a URL: `smtps://user:password@smtp.example.com:465`. Percent-encode special characters in the user and password |
| `MAIL_FROM` | none | The From address of system email, for example `noreply@example.com`. It must belong to a domain your SMTP service has verified |
| `MAIL_REPLY_TO` | none | Where replies to system email go. Optional |

## AI drafting (optional)

See [AI](ai.md). Without these, everything works except AI-written drafts.

| Setting | Default | What it does |
| --- | --- | --- |
| `AI_API_KEY` | none | Key for any OpenAI-compatible service |
| `AI_MODEL` | none | The model name to use. Required together with the key |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Address of the service. Change it for OpenRouter, a local Ollama and similar |

## One-click Gmail and Outlook sign-in (optional)

Needs your own [Composio](https://composio.dev) account. Without it, connect
mailboxes with an app password instead; see [mailboxes](mailboxes.md).

| Setting | Default | What it does |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | none | Your Composio API key |
| `COMPOSIO_WEBHOOK_SECRET` | none | Secret for Composio's reply notifications. At least 32 characters. Point the Composio webhook at `https://APP_DOMAIN/api/v1/webhooks/composio` |
| `COMPOSIO_GMAIL_AUTH_CONFIG_ID` | none | ID of your Composio Gmail auth config |
| `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` | none | ID of your Composio Outlook auth config |
| `COMPOSIO_TOOLKIT_VERSION` | built in | Pins Composio's API version. Leave unset unless we tell you to change it |

## Advanced

The defaults suit a 2 GB server.

| Setting | Default | What it does |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | How much the API and worker log: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `BACKUP_KEEP` | `14` | How many nightly backups to keep |
| `BACKUP_HOUR_UTC` | `3` | The hour (0 to 23, no leading zero, UTC) when the nightly backup runs |
| `SMTP_ALLOW_PRIVATE_HOSTS` | `false` | Set to `true` only if your mail server has a private (LAN) address. Off by default so a mailbox form cannot be used to probe your network |
| `FOUNDER_ALERT_EMAIL` | off | Sends an email to this address whenever someone signs up. Needs system email |
| `MAILBOX_CREDENTIALS_KEY_PREVIOUS` | none | Your old key, kept while you move mailboxes to a new `MAILBOX_CREDENTIALS_KEY`. See [mailbox credentials rotation](../smtp-mailboxes.md) |
| `WORKER_CONCURRENCY` | `5` | How many emails the worker handles at once. If you raise it above 5, also set `WORKER_DATABASE_POOL_MAX` higher than it |
| `API_DATABASE_POOL_MAX` | `8` | Database connections the API may open |
| `WORKER_DATABASE_POOL_MAX` | `6` | Database connections the worker may open (must be larger than `WORKER_CONCURRENCY`) |
| `WEB_DATABASE_POOL_MAX` | `5` | Database connections the web app may open |
| `QUEUE_POOL_MAX` | `5` | Database connections for the worker's job queue |

The bundled database allows 60 connections in total. If you raise the pool
sizes, keep their sum (plus about 10) below that.

## Not used when self-hosting

These exist in the code for our hosted service. Leave them out of your `.env`:
`DODO_PAYMENTS_*` and `DODO_PRODUCT_LIFETIME` (billing), `AZURE_*` (our cloud's
email and AI), `TURNSTILE_*` and `POSTHOG_*` (hosted sign-up protection and
analytics; the prebuilt images ship with both off), and
`DELIVERY_ADVISOR_WORKSPACE_IDS` (an unreleased pilot).
