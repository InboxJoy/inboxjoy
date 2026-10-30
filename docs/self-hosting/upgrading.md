# Upgrading

```sh
inboxjoy upgrade
```

That is the whole upgrade. It takes a couple of minutes and the site is
unavailable only for a few seconds, while the app restarts.

## What it does

1. Finds the newest release on GitHub (or uses the version you name).
2. Downloads the stack files for that release, so a new version can change how
   the stack is wired.
3. **Backs up the database** to `/opt/inboxjoy/backups`.
4. Downloads the new images.
5. Updates the database. The app is not restarted unless this succeeds.
6. Restarts the app and waits until every part reports healthy.
7. Replaces the `inboxjoy` command itself with the new release's copy.

If anything fails before step 6, nothing is restarted and your settings are put
back as they were: the site keeps running the old version.

## Choosing a version

```sh
inboxjoy upgrade            # the newest release
inboxjoy upgrade 1.3.0      # a specific release
inboxjoy upgrade --no-backup   # skip the backup (not recommended)
inboxjoy version            # what is installed and running now
```

Release notes are on the releases page of
https://github.com/inboxjoy/inboxjoy. Read them before upgrading across a
major version (the first number), because those can include changes you need to
act on.

Your `.env` is never changed by an upgrade, except for the version number. If a
release needs a new setting, its release notes say so, and the setting's
[reference entry](configuration.md) lists what it does.

## If something goes wrong

If the new version starts but misbehaves, go back:

```sh
inboxjoy upgrade 1.2.0        # the version you were on
```

Upgrades change the database, and older versions cannot always use a newer
database. If the old version will not start after going back, restore the
backup the upgrade took first:

```sh
ls /opt/inboxjoy/backups
inboxjoy restore /opt/inboxjoy/backups/inboxjoy-20261029T031500Z.dump
```

See [backups](backups.md). Anything created between the upgrade and the restore
is lost, so decide quickly.

## Good habits

- Upgrade when you are not in the middle of a large send. Emails already
  scheduled are kept in the database and continue afterwards, but a short
  restart is a good moment to be around.
- Keep a copy of the newest backup off the server before a major upgrade.
- Update the server itself (`apt update && apt upgrade`) separately; the app
  does not need a reboot for that, but Docker restarts it if you do reboot.
- To follow a fork or a private mirror, run the installer or command with
  `INBOXJOY_REPO=your-name/your-repo`.

## Pinning

The installer pins the exact version in `.env` (`INBOXJOY_VERSION`). Nothing
upgrades unless you run `inboxjoy upgrade`, so the site never changes under you.
