# Connecting mailboxes

InboxJoy sends campaigns from your own mailboxes and reads replies from them.
On your own server there are two ways to connect one:

- **SMTP and IMAP with an app password.** Works with Gmail, Google Workspace,
  Outlook and almost any other provider. No extra accounts. This is the default
  and what this page covers first.
- **One-click sign-in through Composio.** Optional. You press "Connect Gmail" or
  "Connect Outlook", approve access with your provider and you are done, with
  no password to paste. It needs your own Composio account. See
  [the end of this page](#optional-one-click-gmail-and-outlook-with-composio).

To connect with SMTP/IMAP, open the **Mailboxes** page in InboxJoy, choose
**Connect mailbox**, then **SMTP/IMAP**. Fill in the mailbox's address and the
SMTP (sending) and IMAP (receiving) details from the sections below. InboxJoy
tests both connections before it saves anything. Passwords are stored
encrypted and never shown again.

This needs `SMTP_MAILBOXES_ENABLED=true` and a `MAILBOX_CREDENTIALS_KEY` in
your `.env`. The installer sets both.

## Gmail and Google Workspace

Google does not accept your normal password here. You create an **app
password**, a 16-character password that works for one app only.

1. Sign in to the Google account and turn on **2-Step Verification**
   (Google Account, then Security). App passwords need it.
2. Open https://myaccount.google.com/apppasswords, name it "InboxJoy" and
   create it. Copy the 16 characters; Google shows them once.
3. In InboxJoy, connect with:

| | SMTP (sending) | IMAP (receiving) |
| --- | --- | --- |
| Host | `smtp.gmail.com` | `imap.gmail.com` |
| Port | `465` (SSL/TLS) or `587` (STARTTLS) | `993` (SSL/TLS) |
| Username | the full email address | the full email address |
| Password | the app password | the same app password |

**Google Workspace** (your own domain on Gmail) works the same way, with two
extras: a Workspace administrator must allow app passwords and IMAP for your
user, and 2-Step Verification must be on for that user. If the app password
page is missing, your administrator has turned it off.

Gmail limits how much one account may send each day (about 500 for a free
account, about 2,000 for Workspace). InboxJoy's own daily limits and warm-up
stay below that; do not raise them past what your account allows.

## Outlook and Microsoft 365

| | SMTP (sending) | IMAP (receiving) |
| --- | --- | --- |
| Host | `smtp.office365.com` | `outlook.office365.com` |
| Port | `587` (STARTTLS) | `993` (SSL/TLS) |
| Username | the full email address | the full email address |
| Password | an app password | the same app password |

Microsoft is phasing out password sign-in for mail. What works depends on the
account:

- **Personal Outlook.com, Hotmail and Live accounts:** turn on two-step
  verification, then create an app password in your Microsoft account's
  security settings.
- **Microsoft 365 work or school accounts:** your administrator must allow
  "Authenticated SMTP" for the mailbox and IMAP access, and must allow
  password (basic) sign-in for these protocols. Many organisations have turned
  this off. If InboxJoy reports an authentication error, ask your administrator,
  or use Composio's one-click sign-in below, which does not need passwords.

## Any other provider (SMTP/IMAP)

Ask your provider for its "SMTP server" and "IMAP server" settings. Fastmail,
Zoho, Namecheap, cPanel hosts, Mailcow and most business email work.

What InboxJoy accepts:

- SMTP ports `465` (SSL/TLS), `587` or `2525` (STARTTLS), or `25`.
- IMAP ports `993` (SSL/TLS) or `143` (STARTTLS).
- A plain port must upgrade with STARTTLS. Certificates are always checked, so
  a self-signed certificate is refused.
- Host names only, never IP addresses. Names that point to a private (LAN)
  address are refused unless you set `SMTP_ALLOW_PRIVATE_HOSTS=true` in `.env`
  and run `inboxjoy restart`.
- The username is usually the full email address. If your provider gives a
  separate sending password, untick "Use same password as SMTP" and enter the
  IMAP password separately.

Errors name the field to fix (host, port, username or password). The most common
causes are an app password typed with spaces, IMAP switched off in the
provider's settings, and a server that blocks outgoing connections on these
ports. Some VPS providers block outgoing port 25 or 465; see
[troubleshooting](troubleshooting.md).

## Before you send anything

Cold email lives or dies on setup. A few basics:

- **Send from a domain you own** and set up **SPF, DKIM and DMARC** for it with
  your mail provider. Without them, mail lands in spam.
- **Use a separate domain** (for example `getinboxjoy.com` next to
  `inboxjoy.com`) for cold outreach, so a problem never touches your main
  domain's reputation.
- **Let warm-up run.** InboxJoy raises each mailbox's daily volume gradually.
  Keep the defaults for the first few weeks.
- **Keep unsubscribe links on** and stop writing to people who ask.

## Optional: one-click Gmail and Outlook with Composio

Self-hosters can get the same one-click buttons as the managed edition by using
their own [Composio](https://composio.dev) account:

1. Create a Composio account and an API key.
2. In Composio, create a **Gmail** auth config and an **Outlook** auth config.
   Follow Composio's instructions for the OAuth app behind each one.
3. In Composio, add a webhook that points to
   `https://your-domain/api/v1/webhooks/composio`, with a secret of at least 32
   characters.
4. Add the settings to `/opt/inboxjoy/.env`:

```
COMPOSIO_API_KEY=your-composio-api-key
COMPOSIO_WEBHOOK_SECRET=the-secret-you-chose-above
COMPOSIO_GMAIL_AUTH_CONFIG_ID=your-gmail-auth-config-id
COMPOSIO_OUTLOOK_AUTH_CONFIG_ID=your-outlook-auth-config-id
```

5. Run `inboxjoy restart`. The **Connect Gmail** and **Connect Outlook**
   buttons now work on the Mailboxes page.

Composio is a separate service with its own pricing and terms. InboxJoy works
fully without it.
