# Troubleshooting

Start with two commands:

```sh
inboxjoy status         # what is running, whether the site answers
inboxjoy logs api       # or worker, web, caddy, postgres
```

`inboxjoy logs` with no name follows every service at once. Press Ctrl+C to
stop. Logs are kept per service and rotated (about 30 MB each at most).

## The installer stopped

It is safe to run again; it keeps your settings and secrets.

| Message | What to do |
| --- | --- |
| "Run the installer as root" | Use `curl ... \| sudo sh`, or log in as root |
| "needs 2 GB" | The server is too small. Use a 2 GB server, or set `INBOXJOY_FORCE=yes` to try anyway (expect out-of-memory kills) |
| "Port 80 is already in use" | Another web server (nginx, Apache) is running. Stop and disable it (`systemctl disable --now nginx`), then run the installer again |
| "Docker is required" | Allow the installer to install Docker, or install it yourself from https://docs.docker.com/engine/install/ |
| "Could not download ..." | The server cannot reach GitHub or the image registry. Check the server's internet access and DNS |
| "Could not find the latest release" | GitHub rate-limited the server. Wait a few minutes or name a version: `INBOXJOY_VERSION=1.2.3` |
| "api did not start" | Read the log lines printed above it, fix what they name in `/opt/inboxjoy/.env`, then run `inboxjoy restart` |

## The site does not open

1. **DNS.** `getent hosts your-domain` must print your server's public IP. A new
   record can take a few minutes to reach you; if you changed it recently,
   wait and retry.
2. **Firewall.** Ports 80 and 443 must be open both in the server's own
   firewall (`ufw allow 80,443/tcp`) and in your provider's firewall or
   security group. Caddy cannot get a certificate if port 80 is blocked.
3. **Certificate.** `inboxjoy logs caddy`. Messages about "challenge" or
   "no such host" mean DNS or a closed port. Let's Encrypt limits repeated
   failures (five per hour per domain); fix the cause, then wait before retrying.
4. **A proxy in front.** If the domain goes through Cloudflare's proxy (orange
   cloud), switch the record to "DNS only" for the first certificate, or use
   Cloudflare's "Full (strict)" mode once the certificate exists.

The browser shows a certificate warning right after install, or the site loads
over http but not https: HTTPS is still being issued. Give it a minute and
reload.

## A service keeps restarting

`inboxjoy status` shows `Restarting` or `unhealthy` for it. Read its log:

```sh
inboxjoy logs api
```

- **"INBOXJOY_EDITION must be set"**: the `INBOXJOY_EDITION=selfhost` line is
  missing from `.env`. Add it and run `inboxjoy restart`.
- **Email settings:** the log asks for `MAIL_SMTP_URL`. See
  [system email](system-email.md).
- **"MAILBOX_CREDENTIALS_KEY"**: the key is missing or malformed. It must be a
  base64 32-byte value. `openssl rand -base64 32` makes one, but never replace
  a key that already protects stored mailboxes.
- **"password authentication failed for user inboxjoy"**: `POSTGRES_PASSWORD`
  in `.env` does not match the one the database was created with (someone
  edited it). Put the original back; the database keeps the password it was
  created with.
- **Killed or "out of memory"**: see [memory](#the-server-runs-out-of-memory).

After fixing `.env`, always run `inboxjoy restart`; editing the file alone
changes nothing until the containers are recreated.

## The server runs out of memory

Check with `free -m` and `docker stats --no-stream`. InboxJoy needs about 0.8 GB
at rest and more during upgrades. On a 2 GB server:

- Add swap (the installer offers it). To do it by hand:

  ```sh
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```

- Do not run other heavy software on the same server.
- Do not scale the worker up; one worker is enough for one server.
- Move to a 4 GB server if you run many mailboxes with high volume.

## Mail problems

**Mailbox will not connect.** The error names the field. Check, in order:
the password is an app password with no spaces; IMAP is enabled at the
provider; the host names are right; the ports are ones InboxJoy accepts (see
[mailboxes](mailboxes.md)). Test from the server with
`openssl s_client -connect smtp.example.com:465` (it should print a
certificate; a hang means the port is blocked).

**Many VPS providers block outgoing mail ports** (25 especially, sometimes 465
and 587) on new accounts to fight spam. If connections to a mail server time
out from your server but work from your laptop, ask the provider to lift the
block, or use a provider that does not block it.

**System emails never arrive.** Follow [the check in system
email](system-email.md#check-that-it-works). The two usual causes are a wrong
password in `MAIL_SMTP_URL` (including characters that need encoding) and a
`MAIL_FROM` domain the provider has not verified.

**Campaign emails land in spam.** That is domain reputation, not the server:
SPF, DKIM and DMARC set up, a separate sending domain, slow warm-up. See the end
of [mailboxes](mailboxes.md).

## Locked out

- **Forgot the owner password:** use **Forgot password** on the sign-in page.
  It needs [system email](system-email.md) to be working.
- **Nobody can create an account:** the instance is invite-only after the first owner exists. The owner invites
  people from Settings, then Team. To let anyone sign up, set
  `SIGNUP_MODE=open` and run `inboxjoy restart`; switch it back afterwards.
- **Someone else claimed the owner account:** reinstall on a clean server, or
  restore a backup from before. Create the owner account right after install
  next time.

## Disk is full

```sh
df -h /
docker system df
docker image prune -f          # removes old, unused images
journalctl --vacuum-size=200M  # trims the system journal
```

`inboxjoy upgrade` already prunes unused images. Backups live in
`/opt/inboxjoy/backups`; lower `BACKUP_KEEP` or move old files off the server.

## Commands say "Cannot talk to Docker"

You are not root and not in the `docker` group. Use `sudo inboxjoy ...` (the
command also tries `sudo` by itself).

## An upgrade failed

See [upgrading](upgrading.md#if-something-goes-wrong). Nothing is restarted if
the database update fails, and a backup is taken first.

## Start over

This deletes everything, including the database and certificates:

```sh
cd /opt/inboxjoy && docker compose down -v
```

Then remove `/opt/inboxjoy` and run the installer again. Take a backup first
and copy it off the server if there is anything you may need.

## Still stuck

Open a discussion at https://github.com/inboxjoy/inboxjoy/discussions with
the output of `inboxjoy status`, `inboxjoy version`, and the last 50 lines of the
failing service's log (`docker compose -f /opt/inboxjoy/compose.yml logs --tail=50 api`).
Remove secrets and addresses you do not want to share. Bugs go to the issue
tracker in the same repository.
