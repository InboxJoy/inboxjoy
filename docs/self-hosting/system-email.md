# System email

InboxJoy sends a few emails of its own: password resets, team invitations and
alerts (a mailbox disconnected, a campaign finished, a reply arrived). These are
**system emails**. They are separate from your campaigns, which go out through
the mailboxes you connect.

System email goes through an SMTP service you choose. Set it with three
settings in `/opt/inboxjoy/.env`, or answer the question during install:

```
MAIL_SMTP_URL='smtps://USER:PASSWORD@smtp.example.com:465'
MAIL_FROM=noreply@example.com
MAIL_REPLY_TO=you@example.com
```

`MAIL_REPLY_TO` is optional. After editing, run `inboxjoy restart`.

InboxJoy starts without it. The owner account works straight away, and invite
links can be copied and shared by hand. Set it up before you rely on "Forgot
password", emailed invites or mailbox alerts.

## Writing the URL

The format is `scheme://user:password@host:port`:

- Use `smtps://` with port `465` when your provider offers it (the connection
  is encrypted from the first byte). For providers that only offer port `587`,
  use `smtp://` with `:587`; the connection is upgraded to TLS.
- If the user name or password contains special characters, encode them:
  `@` as `%40`, `:` as `%3A`, `/` as `%2F`, `#` as `%23`, `?` as `%3F`, `%` as
  `%25`. This one-liner does it for you:

  ```sh
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' 'p@ss:word'
  ```

- Keep the single quotes around the whole URL in `.env`. They stop Docker from
  treating a `$` as a variable.

`MAIL_FROM` must be on a domain your provider has verified. Providers ask you to
add DNS records (SPF and DKIM) to prove you own the domain. Do this first, or
the provider will refuse the messages.

## Providers

Any SMTP service works. These are common and have free tiers that are plenty
for system email.

| Provider | Host and port | User | Password |
| --- | --- | --- | --- |
| [Resend](https://resend.com) | `smtp.resend.com`, 465 | `resend` | an API key |
| [Postmark](https://postmarkapp.com) | `smtp.postmarkapp.com`, 587 | your Server API token | the same token |
| [Amazon SES](https://aws.amazon.com/ses/) | `email-smtp.REGION.amazonaws.com`, 465 | SES SMTP user name | SES SMTP password |
| [Mailgun](https://www.mailgun.com) | `smtp.mailgun.org`, 465 | `postmaster@your-sending-domain` | the domain's SMTP password |

Examples:

```
# Resend
MAIL_SMTP_URL='smtps://resend:re_xxxxxxxxxxxx@smtp.resend.com:465'

# Postmark (port 587)
MAIL_SMTP_URL='smtp://TOKEN:TOKEN@smtp.postmarkapp.com:587'

# Amazon SES in Frankfurt
MAIL_SMTP_URL='smtps://AKIAXXXXXXXX:SMTP_PASSWORD@email-smtp.eu-central-1.amazonaws.com:465'

# Mailgun (the @ in the user name is written %40)
MAIL_SMTP_URL='smtps://postmaster%40mg.example.com:PASSWORD@smtp.mailgun.org:465'
```

Notes:

- **Amazon SES** SMTP credentials are not your normal AWS keys: create them
  under SES, "SMTP settings". New SES accounts start in a sandbox that only
  sends to verified addresses; request production access first.
- **Gmail or Microsoft 365 as system email** is possible with an app password
  but not recommended: daily limits are low and the provider may treat
  automated mail as suspicious.
- A transactional service is better than your campaign mailboxes for this job.
  Keep the two apart so a campaign problem never stops password resets.

## Check that it works

1. Run `inboxjoy restart`.
2. Open the sign-in page in a private window and use **Forgot password** with
   the owner's address. The email should arrive within a minute.
3. If nothing arrives, read the log: `inboxjoy logs api`. Authentication
   errors mean a wrong user or password; "sender not verified" errors mean the
   domain of `MAIL_FROM` is not verified yet at your provider. Check the spam
   folder too.
