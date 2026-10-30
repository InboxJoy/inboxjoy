# Workspace export and import

Move a workspace between InboxJoy Cloud and a self-hosted install, in either
direction, with one JSON file. The workspace owner downloads the file from
**Settings → Export & import** on one install and loads it on the other.

Code: `packages/core/src/workspace-transfer/` (format, export, import),
`apps/api/src/modules/workspace-transfer/index.ts` (routes),
`apps/web/app/app/(product)/settings/export/page.tsx` (page).

## Move from InboxJoy Cloud to self-hosted

1. On InboxJoy Cloud, open **Settings → Export & import** and click
   **Download export**. You get `inboxjoy-<workspace>-<date>.json`.
2. Install InboxJoy on your server ([self-hosting](self-hosting/README.md)) and sign up.
   Signing up creates an empty workspace; you are its owner.
3. Open **Settings → Export & import** there, choose the file, check the
   summary, and click **Import into …**.
4. Follow the result page:
   - **Reconnect your senders.** Connect each listed mailbox again from
     Mailboxes. Connections and passwords never leave the old install.
   - **Share invitation links.** Teammates become pending invitations. No
     email is sent; copy each link, or invite again from **Team** to email it.
   - **Pick lists and senders again.** Every campaign arrives as a draft with
     no audience and no sender. The result lists what each one used before.
5. Before you launch anything on the new install, stop the same campaigns on
   the old one (see "Sending history does not move" below).

Moving from self-hosted to InboxJoy Cloud is the same, in the other direction.
The target must be a workspace with no leads, lists or campaigns yet.

## What moves

| Data | How it arrives |
|---|---|
| Workspace settings: name, timezone, daily send cap, open tracking, postal address | Overwrite the target's. A postal address in the target is never cleared. |
| Sending pause | Only ever turns on. A paused source stays paused; an import never resumes a paused target. |
| Leads, all fields and custom fields | New ids. `replied`, `bounced`, `unsubscribed` and `suppressed` states are kept, so those leads stay out of new campaigns. `enrolled` becomes `active`. A lead whose address the target then suppresses (by address or, for an erased address, by hash) arrives `suppressed`, unless it is already `bounced` or `unsubscribed`. |
| Lists and list membership | Same names and members. |
| Suppressions | Merged: an address the target already suppresses keeps its existing entry. Hash-only entries (erased addresses) move as hashes. |
| Campaigns (sequences) | The current version only: name, description, steps (subject, text, HTML, wait days) and per-lead campaign variables. Archived campaigns stay archived; every other one arrives as a **draft**. |
| Campaign audience and sender | Not recreated. Listed in the file and on the result page so you can pick them again. |
| Teammates (email and role) | Pending invitations, no email sent. The previous owner is invited as an admin (a workspace has one owner: the person importing). At most 20 open invitations, as in Team. |
| Mailboxes | Address, provider, display name, limits and sending windows as **information only**, to show what to reconnect. |

## What does not move

- Mailbox connections, OAuth grants, SMTP/IMAP passwords and provider ids.
- Messages, send attempts, enrollments, replies, open and click events,
  analytics and notifications.
- Older campaign versions (only the current one moves).
- API keys, MCP grants and OAuth clients.
- Billing, subscriptions, lifetime licenses and affiliate data.
- CSV import history, sourced-lead records and audit logs.
- Suppression evidence and unsubscribe-link records (the suppression itself moves).

### Sending history does not move

Enrollments are not exported, so the new install does not know which leads a
campaign already emailed. Launching an imported campaign starts every eligible
lead in its audience at step 1. Leads who replied, bounced or unsubscribed are
still excluded (their lead state and the suppressions move). Before
relaunching, pick lists of leads you have not contacted yet, and stop the
campaign on the old install so both do not send.

## Who can use it

- **Owner only**, and only from a signed-in browser session. Admins and
  members see the page with its buttons disabled.
- **Import needs a verified email**, the same bar as sending, so an
  unverified account cannot create invitation links through a file. Export
  does not.
- **API keys cannot** call either endpoint (HTTP 403), and there is no MCP
  tool. An API key is pinned to a workspace and always acts as its owner,
  whoever created it, so it cannot show that a person chose to download every
  lead or to overwrite workspace settings. A leaked key must not be a bulk
  export.

## API

Both routes check, before a byte of the request body is read: no API key, a
valid session, and that the person is the owner of the workspace the request
names (`x-workspace-id`, or their active workspace). The same session and
membership lookups as every other route are used; the app's usual auth check
runs only after the body is parsed, which is why these routes check first.
The import also needs a verified email. Each workspace runs one import at a
time and each API process at most two, and the file must finish uploading
within 2 minutes. While it streams in, the upload is stopped as soon as it holds more
objects and arrays, or deeper nesting, than a file at the limits below can
(`WORKSPACE_TRANSFER_SHAPE`), so nothing that size reaches `JSON.parse`.

- `GET /v1/workspace/export` → `200` with the file as an attachment
  (`Content-Disposition: attachment; filename="inboxjoy-<workspace>-<date>.json"`,
  `Cache-Control: no-store`). Ten per minute.
- `POST /v1/workspace/import` with the file as the JSON body → `200` with a
  summary: `imported` counts, `invitations` (email, role, invitation token,
  expiry), `notInvited`, `mailboxesToReconnect`, `campaignsToRebuild`, `kept`
  and `warnings`. Five per minute.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `not_workspace_export` | Not an InboxJoy workspace file. |
| 400 | `unsupported_version` | A format version this install cannot read (usually newer: update first). |
| 400 | `import_too_large` | Over a count limit (below). |
| 400 | `invalid_export` | A field failed validation (`details.issues` lists up to ten), duplicate lead emails or list names, or a value the database cannot store. |
| 400 | `import_too_large` / `invalid_export` | The upload has more objects or deeper nesting than a workspace file can (stopped while it streams). |
| 401 | | No session, or a session that is not valid. |
| 403 | `FORBIDDEN` | Not the owner, or an API key. |
| 403 | `email_unverified` | Import only: the owner has not verified their email. |
| 409 | `workspace_changed` | `x-workspace-id` names a workspace the person is not in, or the workspace changed between the check and the import. |
| 409 | `workspace_not_empty` | The workspace already has leads, lists or campaigns. Nothing changed. |
| 409 | `workspace_changed_during_import` | Someone added data while the import ran. Nothing changed. |
| 413 | | Body over 50 MB. |
| 408 | | The upload did not finish within 2 minutes. Nothing changed. |
| 429 | `import_in_progress` | This workspace already has an import running, or the server is running its maximum of two. `Retry-After: 60`. |

## Limits

One file can hold up to 100,000 leads, 1,000 lists, 250,000 suppressions, 500
campaigns (50 steps each), 500,000 campaign variable rows, 100 teammates and
500 mailboxes, within a 50 MB upload. 100,000 leads with a few custom fields is
roughly 25-35 MB, which is why the upload limit stays at 50 MB (the web page
checks the same number before sending). A larger workspace can move its leads
separately with CSV import after the rest.

## Safety

- The import runs in **one transaction**: it either completes or changes
  nothing. It locks the workspace row first, so two imports cannot interleave.
- Every row gets a new id; the file contains no database ids, so nothing can
  point at another workspace's data. Export reads only the owner's workspace
  and drops any reference that does not resolve inside it.
- Import never enrolls, launches, publishes or schedules anything, and never
  calls list auto-enrollment (`enrollNewListLeads`). Nothing can send until
  you connect a mailbox and launch a campaign yourself.
- Suppression hashes are recomputed from the address when there is one, so a
  file cannot pair an address with another address's hash.

## File format (version 1)

A JSON object. Fields with no value are left out to keep files small. Unknown
fields are ignored on import, so later releases can add fields without a new
version. A change that older installs would misread bumps `version`.

```json
{
  "format": "inboxjoy-workspace",
  "version": 1,
  "exportedAt": "2026-10-29T10:00:00.000Z",
  "source": { "edition": "cloud", "appVersion": "1.4.0" },
  "workspace": { "name": "Acme outbound", "defaultTimezone": "Asia/Dubai", "dailySendCap": 300, "killSwitchEnabled": false, "openTrackingEnabled": true, "postalAddress": "1 Main St" },
  "leads": [
    { "email": "ana@example.com", "firstName": "Ana", "company": "Example", "customFields": { "icebreaker": "Saw your talk" }, "createdAt": "2026-09-01T08:00:00.000Z" },
    { "email": "bo@example.com", "status": "replied", "repliedAt": "2026-09-10T09:00:00.000Z" }
  ],
  "lists": [{ "name": "Founders", "leadEmails": ["ana@example.com", "bo@example.com"] }],
  "suppressions": [
    { "email": "gone@example.com", "reason": "unsubscribed", "source": "link" },
    { "emailHash": "<sha-256 of the lowercased address>", "reason": "manual", "source": "manual" }
  ],
  "sequences": [{
    "name": "Intro",
    "description": "First touch",
    "status": "active",
    "steps": [{ "delayDays": 0, "subject": "Hi {{firstName}}", "bodyText": "{{icebreaker}}" }],
    "campaigns": [{ "name": "Intro - Founders", "status": "active", "listNames": ["Founders"], "senderEmail": "sales@acme.test" }],
    "leadVariables": [{ "email": "ana@example.com", "values": { "icebreaker": "Loved the podcast" } }]
  }],
  "mailboxes": [{ "email": "sales@acme.test", "provider": "gmail", "dailyLimit": 40, "hourlyLimit": 5, "timezone": "Asia/Dubai", "sendingWindows": [{ "dayOfWeek": 1, "startTime": "09:00:00", "endTime": "17:00:00", "timezone": "Asia/Dubai", "isActive": true }] }],
  "team": [{ "email": "owner@acme.test", "role": "owner" }, { "email": "rep@acme.test", "role": "member" }]
}
```

- Leads, list members and campaign variables refer to leads by email, so a
  file can be built by other tools. Lead emails must be unique (ignoring case)
  and list names must be unique.
- `sequences[].status` and `campaigns[].status` record the source state; the
  import uses them only to decide archived versus draft.
- `customFields` values are strings, numbers, booleans or null. Nested values
  stored by older imports are exported as their JSON text.
- Steps carry no `variables`: that legacy column is not read anywhere. A
  file that still has it imports; the field is ignored.
- Sending windows live on mailboxes in InboxJoy, so they travel with the
  mailbox metadata and are re-entered when the mailbox is reconnected.

The schema is `workspaceTransferFileSchema` in
`packages/core/src/workspace-transfer/format.ts`.

## Tests

- `packages/core/test/workspace-transfer.test.ts` — format, limits, import
  plan, export assembly, JSON round trip and the streaming shape check (no
  database).
- `packages/core/test/workspace-transfer.integration.test.ts` — export
  isolation and secrets, owner-only, import into an empty workspace, round
  trip, refusal of a non-empty workspace, rollback, sending pause, invitations,
  leads matching a hash-only suppression, unverified owners.
- `apps/api/test/workspace-transfer-routes.test.ts` — API keys, anonymous and
  forged sessions, non-owners and unverified importers refused before the body
  is read, one import at a time, the streaming shape check, attachment
  headers, size limit (no database).
- `apps/api/test/workspace-transfer.integration.test.ts` — the HTTP flow end to end.
- `apps/web/test/workspace-transfer.test.ts` — file checks and owner gating on the page.
