# Self-hosting InboxJoy

Run your own InboxJoy on a small server. It is free and open source, has every
feature, and has no sending limits. You bring the server, a domain name and
your mailboxes. One command installs it, one command upgrades it, one command
backs it up.

> Prefer not to run a server? The managed edition is a one-time $79 lifetime
> licence and we handle updates, backups and one-click Gmail and Outlook
> sign-in. Both editions are the same code.

## What you need

- **A server running Linux** with **2 GB of memory**, 2 CPU cores and 10 GB of
  disk. Ubuntu 22.04/24.04 or Debian 12 are the tested choices. Any VPS works:
  Hetzner CX22, a DigitalOcean $12 droplet, Lightsail, and so on. Intel/AMD
  and ARM servers are both supported.
- **A domain name** (or a subdomain such as `inboxjoy.example.com`) with an
  `A` record pointing at the server's public IP address.
- **Ports 80 and 443 open** to the internet. HTTPS certificates are automatic.
- **Root access** (or `sudo`) on the server.
- **Docker.** The installer sets it up for you if it is missing (it asks first).

Nothing else is required to start. You will want these soon after:

- An SMTP service for InboxJoy's own emails (password resets, invitations,
  alerts). See [system email](system-email.md).
- Mailboxes to send from. See [connecting mailboxes](mailboxes.md).
- An AI key if you want AI-written drafts (optional). See [AI](ai.md).

## Install

Point your domain at the server first, then log in to the server and run:

```sh
curl -fsSL https://raw.githubusercontent.com/inboxjoy/inboxjoy/main/deploy/install.sh | sudo sh
```

The installer asks three things: your domain, your email address (for
certificate notices) and, optionally, your SMTP URL for system email. Then it
does the rest in about five minutes and prints the setup link to open. The
link ends in `?token=...`: it includes a one-time setup token that only you
have, so nobody else can create the first account.

It does this, in order:

1. Checks the server (Linux, memory, disk, free ports).
2. Installs Docker with Docker's official script, only if you agree.
3. Offers a 2 GB swap file if the server has little memory and no swap.
4. Creates `/opt/inboxjoy` with a private `.env` holding freshly generated
   secrets and the setup token. It never prints the secrets; the setup token
   appears only in the final setup link.
5. Downloads the stack files and the `inboxjoy` command for the latest release.
6. Downloads the images, sets up the database and starts everything.
7. Waits until every part reports healthy.

It is safe to run again: your `.env`, secrets and setup token are kept, and
the stack files are refreshed. (It never changes the installed version, even
if `INBOXJOY_VERSION` is set in your shell; use `inboxjoy upgrade` for that.)
To skip the questions (for scripts), set `INBOXJOY_DOMAIN` and
`INBOXJOY_EMAIL`; the top of
[`deploy/install.sh`](../../deploy/install.sh) lists every option.

## First sign-in

Open the setup link the installer printed (`https://your-domain/app/setup?token=...`).
**The first account you create becomes the owner**, so do this right away. The
token in the link proves you are the person who installed the server; without
it, nobody can create that first account. If you lose the link, run the
installer again (it prints it again) or find `SETUP_TOKEN` in
`/opt/inboxjoy/.env` and open `https://your-domain/app/setup?token=<that value>`.
Keep the link private until you have used it. After that the site is invite-only (change this with `SIGNUP_MODE`, see
[configuration](configuration.md)). The owner invites teammates from Settings, then Team.

## Everyday commands

Run these on the server. They ask for `sudo` themselves if needed.

| Command | What it does |
| --- | --- |
| `inboxjoy status` | Shows what is running, whether the site answers, and your latest backup |
| `inboxjoy logs [service]` | Follows the logs. Services: `api`, `worker`, `web`, `caddy`, `postgres` |
| `inboxjoy backup` | Saves a database backup now |
| `inboxjoy restore <file>` | Replaces the database with a backup (asks first) |
| `inboxjoy upgrade [version]` | Backs up, downloads the new version, updates the database, restarts |
| `inboxjoy restart [service]` | Applies changes you made to `.env` |
| `inboxjoy version` | Shows the installed and running versions |

## What is on your server

Everything lives in `/opt/inboxjoy`:

| Path | What it is |
| --- | --- |
| `.env` | Your settings and secrets. Private (mode 600). Back it up. |
| `compose.yml`, `Caddyfile` | The stack. Refreshed by `inboxjoy upgrade`; do not edit |
| `backups/` | Nightly database backups, newest 14 kept |

The stack is six small containers: Postgres 16 (the database and the job
queue), the API, one worker (sends email and reads replies), the web app,
Caddy (HTTPS) and a backup job. Only Caddy is reachable from the internet;
the database has no public port. All of it together uses about 0.8 GB of
memory when idle.

## Good to know

- **Back up off the server.** Backups on the same disk do not survive losing
  the server. See [backups](backups.md).
- **Keep your secrets.** Without `AUTH_SECRET` and `MAILBOX_CREDENTIALS_KEY`
  from `.env`, a restored database cannot be used and stored mailbox passwords
  cannot be read.
- **Sending reputation is yours.** Mail goes out through your own mailboxes
  and domains. Warm-up, daily limits and unsubscribe links stay on by default;
  please keep them on.

## Guides

- [Configuration reference](configuration.md): every setting
- [Connecting mailboxes](mailboxes.md): Gmail, Google Workspace, Outlook, any SMTP/IMAP
- [System email](system-email.md): Resend, Postmark, SES, Mailgun
- [AI drafting](ai.md)
- [Upgrading](upgrading.md)
- [Backups and restore](backups.md)
- [Troubleshooting](troubleshooting.md)

Questions and bug reports: https://github.com/inboxjoy/inboxjoy/discussions
