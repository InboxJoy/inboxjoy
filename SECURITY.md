# Security policy

InboxJoy sends email on behalf of its users and stores mailbox credentials, so
we take security reports seriously. Thank you for helping keep users safe.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security
problem.**

Report it privately, using either route:

1. **GitHub private vulnerability reporting (preferred).** Open the
   repository's **Security** tab, choose **Report a vulnerability**, and fill in
   the form: <https://github.com/inboxjoy/inboxjoy/security/advisories/new>.
2. **Email** **security@inboxjoy.online** with the subject line
   `Security report`.

Please include:

- What you found and why it matters (who can do what to whom).
- The version or commit, and whether it affects self-hosted installs, the
  managed service at inboxjoy.online, or both.
- Steps to reproduce, ideally with a minimal proof of concept.
- Any logs, requests or screenshots that help. Redact real credentials,
  tokens and other people's personal data.

## What to expect

| Step | Target |
| --- | --- |
| We acknowledge your report | within 3 business days |
| We confirm the issue or ask for more detail | within 7 days |
| We ship a fix for a confirmed high-severity issue | within 30 days where possible |
| We publish an advisory and credit you (if you want) | when the fix is released |

We ask for **90 days** of coordinated disclosure from your first report, or
until a fix is released, whichever comes first. If a fix needs more time, we
will tell you why and agree a new date with you.

## Supported versions

InboxJoy is pre-1.0 software. Security fixes go into:

| Version | Supported |
| --- | --- |
| `main` branch | Yes |
| Latest tagged release | Yes |
| Older releases | No. Please upgrade |

Self-hosters should run the latest release and upgrade promptly when a
security advisory is published. Watch the repository (Releases and Security
advisories) to be notified.

## Scope

In scope:

- The code in this repository (web app, API, worker, packages, migrations,
  Docker and deployment files that ship here).
- The managed service at `inboxjoy.online`, including its API and MCP
  endpoint.

Examples we care about: authentication or authorization bypass, one workspace
reading or changing another workspace's data, leaking stored mailbox
credentials or API keys, sending email as another user, injection (SQL, header,
template), server-side request forgery, stored or reflected cross-site
scripting, and weaknesses in the OAuth and MCP consent flows.

Out of scope:

- Problems that exist only in a self-hosted install that is misconfigured (for
  example an exposed database port, default secrets left in place, or a missing
  firewall).
- Denial of service through traffic volume, and automated scanner output with
  no demonstrated impact.
- Missing security headers or cookie flags without a working exploit.
- Social engineering, phishing, physical attacks, and attacks on our
  employees, vendors or other customers' mailboxes.
- Vulnerabilities in third-party services we integrate with (report those to
  the vendor).

## Safe harbor

If you act in good faith and follow this policy, we will not pursue legal
action against you or ask a platform to take your account down. Good faith
means you:

- test only against your own accounts and workspaces, or a self-hosted
  instance you control;
- stop as soon as you have shown the issue, and do not read, change or delete
  other people's data;
- do not degrade the service for others;
- give us reasonable time to fix the issue before telling anyone else.

## Handling secrets

Never commit real credentials. If you find a live secret in the repository
or its history, report it privately as above so we can rotate it.
