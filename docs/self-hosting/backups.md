# Backups and restore

Your data is the database: accounts, leads, campaigns, sequences, mailbox
connections and sent history. InboxJoy backs it up every night. A backup is
only worth something if a copy is also somewhere other than this server, so
read [Copy backups off the server](#copy-backups-off-the-server).

## What happens automatically

A small backup job runs next to the app. Each night around 03:00 UTC it saves a
full database dump to `/opt/inboxjoy/backups` as
`inboxjoy-YYYYMMDDTHHMMSSZ.dump` and keeps the newest 14. If the server was off
at that hour, it catches up as soon as it is back and a day has passed without a
backup. Backup files are readable only by root.

Change the number kept with `BACKUP_KEEP`, and the hour with `BACKUP_HOUR_UTC`
(see [configuration](configuration.md)), then run `inboxjoy restart`.

## Back up now

```sh
inboxjoy backup
```

This saves a dump right away and prints its path. `inboxjoy upgrade` does this
for you before every upgrade.

## Copy backups off the server

A backup on the same disk does not help if the server is lost. Pick one:

- **From your own computer**, with a scheduled job:

  ```sh
  rsync -a root@your-server:/opt/inboxjoy/backups/ ~/inboxjoy-backups/
  ```

- **To object storage** (S3, Backblaze B2, Hetzner Storage Box and others) with
  [rclone](https://rclone.org), from a daily cron job on the server:

  ```sh
  0 5 * * * rclone copy /opt/inboxjoy/backups remote:inboxjoy-backups
  ```

- **Provider snapshots** of the whole server also work. Take them in addition,
  not instead: a snapshot taken while the database is writing may not be
  consistent.

Also keep a copy of **`/opt/inboxjoy/.env`**. It holds `AUTH_SECRET` and
`MAILBOX_CREDENTIALS_KEY`. A database backup restored without them signs
everyone out, breaks old unsubscribe links, and leaves every connected mailbox
needing a reconnect, because its stored password cannot be decrypted. The
`.env` is not in the database backup and contains secrets, so store it
somewhere private such as a password manager.

## Restore

To roll back on the same server:

```sh
ls /opt/inboxjoy/backups
inboxjoy restore /opt/inboxjoy/backups/inboxjoy-20261029T031500Z.dump
```

It asks you to type `restore` to confirm, then:

1. Saves the current data as a `pre-restore-...dump` safety copy.
2. Stops the app.
3. Replaces the database with the backup.
4. Updates the database to match the installed version.
5. Starts the app again.

Anything created after the backup was taken is lost, except what is in the
safety copy. Add `--yes` to skip the question in scripts.

### Moving to a new server

1. Create the new server and point your domain at it.
2. Run the [installer](README.md#install) there.
3. Put your old secrets into the new `/opt/inboxjoy/.env`: copy
   `AUTH_SECRET` and `MAILBOX_CREDENTIALS_KEY` (and
   `MAILBOX_CREDENTIALS_KEY_PREVIOUS` if you had one). Keep the new
   `POSTGRES_PASSWORD`; it belongs to the new database.
4. Copy the backup file to the new server and run
   `inboxjoy restore /path/to/backup.dump --yes`. This stops the app, loads
   the data and starts it again.
5. Run `inboxjoy restart` so the app picks up the secrets you copied, then
   check the site.

If the old and new versions differ, run `inboxjoy upgrade` on the new server
afterwards; restoring a backup from a newer version onto an older install is
not supported.

## Test your backups

A backup you have never restored is a guess. Once, on a spare server or a small
test VPS: install, restore the latest backup, sign in, and check that your
campaigns and mailboxes are there. It takes ten minutes.

## Not the same as workspace export

InboxJoy can also export a single workspace as one file from its settings, for
moving between editions. That is not a backup of your server: it carries your
data but no credentials or mailbox connections. Use the backups on this page
for disaster recovery.
