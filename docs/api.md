# InboxJoy API

The API is Fastify and is mounted behind Caddy at `/api`. Caddy strips that
prefix, so the application routes below are called as `/api/<route>` in
production. Product routes require authentication and select the authorized
workspace; API keys are scoped to their workspace and permitted operations.

## Credentials

- **Browser session** (better-auth cookie): the signed-in user's role in the
  selected workspace applies.
- **API key** (`Authorization: Bearer ij_...`): pinned to one workspace and
  acts as its owner for day-to-day work (leads, lists, sequences, campaigns,
  replies, analytics, suppressions add/list, workspace name/timezone/postal
  address/`openTrackingEnabled`). API keys are refused with HTTP 403 on everything in
  `MCP_ADMIN_OPERATIONS` (`packages/core/src/mcp-admin-operations.ts`): team,
  billing, API-key management, workspace list/switch/delete,
  `DELETE /v1/suppressions/:id`, `DELETE /v1/sequences/:id`, and on
  `PATCH /v1/workspace` bodies that set `killSwitchEnabled` or `dailySendCap`.
  This is the same surface MCP exposes to OAuth tokens.

## Health

- `GET /live` — process liveness.
- `GET /health` — returns `{ status: "ok", service: "inboxjoy-api" }`.
- `GET /ready` — checks the PostgreSQL connection when configured; returns
  503 if the database is unavailable.
- `GET /v1/system/status` — service version, start time, and uptime.

## Inboxes and Composio

- `GET /v1/inboxes` — connected inboxes and daily/hourly usage.
- `POST /v1/inboxes/connect-link` with `{ "provider": "gmail" | "outlook" }`
  — creates a Composio hosted connection URL.
- `GET /v1/inboxes/connect/callback` — validates the short-lived, hashed,
  one-time state, verifies the connected account/provider, stores the account,
  and installs the inbound-message trigger.
- `GET /v1/inboxes/:id/status` — status and last health check.
- `POST /v1/inboxes/:id/reconnect` — starts a new connection flow.
- `POST /v1/inboxes/:id/disconnect` — marks the account disconnected.
- `PATCH /v1/inboxes/:id/settings` — updates daily limit, hourly limit, and
  timezone within server-side bounds.

Required for a real connection: `COMPOSIO_API_KEY`, the provider auth-config
ID (`COMPOSIO_GMAIL_AUTH_CONFIG_ID` or `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID`), and
`COMPOSIO_WEBHOOK_SECRET`. Provider tokens remain in Composio.

`POST /v1/webhooks/composio` accepts signed Composio events. It verifies the
`webhook-id`, `webhook-timestamp` (five-minute window), and
`webhook-signature`, persists event IDs/log IDs for dedupe, expires revoked
accounts, and marks active enrollments/messages stopped when an inbound reply
matches a contact. Nested sender payloads are supported.

## Leads, imports, and sequences

- `GET /v1/leads` — workspace contacts.
- `POST /v1/leads` — creates a single lead; supplying `listId` also adds it
  to the list and returns `campaignUpdates` alongside `lead`.
- `POST /v1/leads/import` (`leads.import`) — imports leads; when a list is
  supplied, returns `campaignUpdates` alongside the existing import result.
  Each lead accepts optional `customFields` (`{ name: text | null }`, merged
  into the lead's custom fields; `null` deletes a key) and `variables`
  (`{ name: text | null }`, stored for the campaign named by the top-level
  `campaignId` or `sequenceId` before auto-enrollment runs). Names match
  `^[A-Za-z][A-Za-z0-9_]{0,63}$` and cannot reuse the built-ins `firstName`,
  `lastName`, `company`, `title`, or `email`. When `variables` are stored the
  response adds `variables: { sequenceId, updated, rerendered, enrolledWaiting }`.
  Storing `variables` needs an owner or admin. Changing `customFields` on a
  lead also wakes it in every live campaign whose lists include it and
  re-renders its queued, unattempted emails in every sequence; the response
  then carries `customFieldsRefresh: { enrolledWaiting, rerendered }`.
- `campaigns.setLeadVariables` (MCP tool `inboxjoy_campaigns_setLeadVariables`)
  — writes per-lead, per-campaign custom text variables. Input: exactly one of
  `campaignId` or `sequenceId`, and `leads` (1–1000) of
  `{ email | contactId, variables: { name: text | null } }`. Writes merge into
  stored values; `null` or blank deletes a key. Values are trimmed, line breaks
  become spaces, and the limit is 1000 characters. Returns
  `{ sequenceId, updated, notFound, enrolled, rerendered, stillMissing: [{ email, missing }] }`.
  Owners and admins only. Leads of other workspaces are reported in
  `notFound` and never written.
- `campaigns.getLeadVariables` (MCP tool `inboxjoy_campaigns_getLeadVariables`,
  read access) and `GET /v1/sequences/:id/lead-variables` — read side of
  `setLeadVariables`. Input: exactly one of `campaignId` / `sequenceId` (the
  route uses the sequence id), `filter` (`all` default | `missing`), `variable`
  (narrows `filter=missing` to one name), `page` (default 1), `pageSize`
  (default 50, max 200) and `search` (email or name). The audience is the
  union of leads with a live (`scheduled | active | paused`) or `completed`
  enrollment in the sequence, leads queued for it, and members of the lists
  selected on its non-archived campaigns, excluding suppressed, unsubscribed
  and bounced leads. Returns
  `{ variables: [{ name, ready, missing }], audienceTotal, leads: [{ contactId, email, firstName, lastName, values: { name: { value, source: "campaign" | "lead" } | null }, missing: [name] }], page, pageSize, total }`.
  `variables` lists the custom variables used by the sequence's current
  version, sorted (empty for a sequence published before custom variables
  shipped, see "Custom variables in sequence steps"); `ready` and `missing`
  count the whole audience. Sequences of other workspaces return 404.
- `PUT /v1/sequences/:id/lead-variables` with
  `{ leads: [{ contactId, variables: { name: text | null } }] }` (1–1000) —
  runs `campaigns.setLeadVariables` for that sequence and returns the same
  `{ sequenceId, updated, notFound, enrolled, rerendered, stillMissing }`.
  Owners and admins only.
- `GET /v1/lead-variables/names` (`campaigns.listLeadVariableNames`) — returns
  `{ names: string[] }`, the distinct custom variable names in use in the
  workspace (lead `customFields` keys plus campaign value keys), sorted, at
  most 200. The scan covers the 5,000 most recently updated leads and
  campaign value rows, so very large workspaces see their current names.
- `GET /v1/leads/:id` (`leads.get`) includes `customFields` and
  `campaignVariables: [{ sequenceId, sequenceName, values }]`.

### Custom variables in sequence steps

Steps can use `{{name}}` tokens beyond the built-ins (`firstName`, `lastName`,
`company`, `title`, `email`). A token resolves in this order: built-in lead
field (blank when empty), then the campaign value stored for that lead, then
the lead's `customFields` value of the same name. Whitespace inside the braces
is allowed (`{{ icebreaker }}`); any other text stays literal.

Only sequences published after custom variables shipped enforce them. Every
version created from then on (new sequences, and the new version written when
a live or paused sequence is edited) enforces custom variables. Versions that
were already published at that release keep their previous behavior: custom
`{{tokens}}` stay literal text, built-ins and their aliases still resolve, and
nothing is gated or stopped for missing values (no launch or publish block, no
`skipped.missing_variables`, no follow-up stop, `variables` empty in
`getLeadVariables`, no missing list in previews). Editing a grandfathered
sequence creates a new, enforcing version.

- A campaign cannot launch while any lead in its audience lacks a value for a
  custom variable used in the step subjects or bodies.
- Leads added later to a live campaign's lists wait unenrolled until their
  values are complete, then enroll automatically when the values are written
  (`skipped.missing_variables` and `skippedLeadIds.missing_variables` report
  the waiting leads).
- Older sequences that spell built-ins differently keep working: `{{first_name}}`,
  `{{FirstName}}`, `{{last_name}}`, `{{company_name}}`, `{{job_title}}`,
  `{{title}}` and `{{Email}}` resolve (ignoring case and underscores) to the
  matching built-in and render blank when empty. They never count as custom
  variables.
- Leads re-queued on an already published sequence while they wait for values
  never block a later publish or launch; they enroll when their values arrive.
- Writing values re-renders queued emails that have not been attempted yet.
- Clearing a value never sends the old text. When a write (`setLeadVariables`,
  `PUT /v1/sequences/:id/lead-variables`, a CSV import, or `leads.import`
  `customFields`) leaves a queued email that was never attempted unrenderable,
  that email and its enrollment are cancelled (stop reason `missing_variables`,
  the lead returns to `active` once no other sequence holds it) and the lead
  moves back to the staged queue. When the value returns, the same enrollment
  is revived and resumes at the first step the lead has not received, on the
  same mailbox. Claimed, sending or already-attempted emails are never touched.
- Values written while a campaign (or its sequence) is paused keep the affected
  leads in the staged queue; resuming converts the ones whose values are
  complete. Leads named explicitly in `sequences.enroll` `leadIds` that skip for
  missing variables on a live sequence wait in the same queue and enroll when
  their values arrive.
- `{{name}}` is an alias of `{{firstName}}` (like `{{first_name}}`) and can no
  longer be used as a custom variable name.
- A lead can be active in several campaigns at once. Each sequence holds at
  most one enrollment per lead, and replies, bounces and unsubscribes stop all
  of that lead's enrollments.
- `POST /v1/lists/:id/leads` (`lists.addLeads`) with `{ leadIds: string[] }`
  — adds list memberships and returns `{ added, campaignUpdates }`.
- `GET /v1/imports` — import history.
- `POST /v1/imports/preview` with `csv`, optional `fileName`, `listName`,
  `fieldMapping`, `mode`, `listId` and `variablesSequenceId` — validates rows
  and reports ready, duplicate, invalid, and suppressed rows without
  committing contacts. `fieldMapping` targets may include `custom:<name>`
  (CSV column to custom variable, for example `{ "Ice breaker": "custom:icebreaker" }`).
  Names follow `^[A-Za-z][A-Za-z0-9_]{0,63}$` and cannot reuse a built-in or
  its aliases; an invalid or duplicate target returns 400. Unknown columns are
  never mapped automatically. `variablesSequenceId` (a sequence of the
  workspace, 404 otherwise; owners and admins only) stores the custom columns
  as campaign variables for that sequence; without it they merge into each
  lead's `customFields` (empty cells leave stored values unchanged). The
  `import` object lists the target names in `customFields: string[]`. Custom
  columns apply to created rows and to existing leads. In the default
  `add_only` mode an existing lead whose row has a non-empty custom cell that
  differs from what is stored is previewed as `action: "update"` (status
  `ready`, no `changedFields`): only its custom values are written, standard
  fields stay as they are and the lead is not added to the import list. Rows
  without new custom values stay `unchanged` ("Lead already exists").
- `POST /v1/imports/:id/commit` — commits eligible rows transactionally and
  rechecks suppressions. CSV commits that add list memberships return
  `campaignUpdates` alongside `import`. Custom column values are written
  before list memberships and auto-enrollment; afterwards leads waiting on
  them enroll and queued emails re-render, and the response adds
  `customFields: { storedAs: "campaign" | "lead", sequenceId?, leads, rerendered, enrolledWaiting }`
  when the import carried custom values.
- `GET /v1/sequences` — sequences and steps, including each sequence's saved
  `mailboxIds` (`[]` means rotate across all healthy workspace mailboxes).
- `GET /v1/sequences/:id` — current definition and saved `mailboxIds`.
- `POST /v1/sequences` — creates a draft sequence.
- `PATCH /v1/sequences/:id` — edits an unpublished sequence. Editing a
  finished campaign's published sequence creates a new version only when
  there are zero in-progress enrollments (`scheduled | active | paused`)
  across the entire sequence, including all versions and other campaigns.
  Otherwise it returns `CONFLICT`. Existing enrollment history stays on its
  original version; published sequences keep sending enabled and newly added
  list leads start at step 1 on the new version. Paused edits keep the existing
  publish/resume flow.
- `POST /v1/sequences/:id/publish` — publishes a sequence.
- `PUT /v1/sequences/:id/mailboxes` with `{ mailboxIds: string[] }` — replaces
  the saved sender selection (up to 50 distinct UUIDs; `[]` clears it). Owners
  and admins can save selections for draft, published, or paused sequences;
  archived sequences return `CONFLICT`. IDs outside the authenticated workspace
  return `BAD_INPUT`. Returns `{ sequence, mailboxIds, reassigned }`.
- `POST /v1/sequences/:id/launch` — publishes and optionally enrolls from
  `listIds` or legacy `listId`. Supplied `mailboxIds` are validated and saved
  before enrollment, including when no lists are supplied. Omitted `mailboxIds`
  preserve the saved selection.
- `POST /v1/sequences/:id/enroll` — schedules eligible Ready contacts only;
  requires an active inbox and published sequence. Explicit `inboxIds` (or
  legacy `inboxId`) take precedence; otherwise a non-empty saved selection
  applies. If none of its mailboxes can send, enrollment returns `CONFLICT`
  with reconnect/choose-other-mailboxes guidance, never falling back to other
  senders. With no saved selection, existing rotate-all behavior is unchanged.
  When the sequence has exactly one launched (active, paused or finished)
  campaign and no `campaignId` is supplied, the enrollment joins that campaign:
  a finished campaign restarts and sends begin, a paused campaign returns
  `CONFLICT` until it is resumed, and contacts who already went through the
  sequence on any version are skipped. Draft campaigns are left untouched.

The MCP operation registry exposes the same contract through `sequences.list`,
`sequences.get`, `sequences.setMailboxes` (write access), `sequences.launch`, and
`sequences.enroll`. The separate `campaigns.launch` operation retains its
campaign's explicit `inboxId` override.

Saving a selection moves scheduled, active, and paused enrollments that have
never sent, and have no send claimed or in progress, onto the target
mailboxes: the sendable mailboxes in the saved selection, or in the whole
workspace when the selection is `[]`. Enrollments already on a target mailbox
keep their sender. Moved enrollments are spread round-robin in enrollment
order, and their pending scheduled/retryable messages move in the same
transaction. An enrollment paused for an expired mailbox resumes on its new
sender, exactly as reconnecting would; every other pause stays in place until
the sequence or campaign resumes. Existing threads keep their original sender.
A selection with zero sendable mailboxes is still saved and returns
`reassigned: 0`. `canSend()` remains the delivery permission gate.

### List additions can start sends

Adding leads to a list linked to an active or completed campaign can
automatically enroll them and start sends. A completed campaign restarts as
`active` only if new enrollments are created. The automatic path considers
only newly inserted list memberships, not older list members that have never
been enrolled. Re-adding an existing member is a no-op. Lists linked through
either `listIds` or legacy `listId` use the same behavior.

Automatic enrollment requires a workspace manager (owner or admin), a
verified workspace owner, and a published sequence. It reuses launch's
suppression, eligibility, plan-limit, and sender-selection rules; delivery
still passes through `canSend()` and normal sending windows and caps. These
gates never roll back an otherwise valid lead creation, import, or list
addition: leads remain in the list when campaign enrollment is blocked.

The four mutation paths above expose a `campaignUpdates` array with this
shared entry shape; an empty array means no campaign updates:

```ts
{
  campaignId: string;
  name: string;
  enrolled: number;
  restarted: boolean;
  blockedReason: "campaign_paused" | "sequence_inactive" | "plan_limit"
    | "no_sender" | "sending_disabled" | "not_manager" | null;
}
```

`enrolled` counts new enrollments for that campaign; `restarted` is true only
for a completed-to-active transition. `blockedReason` is `null` when no gate
blocks enrollment; it does not imply that every added lead was eligible.

| `blockedReason` | Meaning |
|---|---|
| `campaign_paused` | Campaign is paused; new leads wait for an explicit launch. |
| `sequence_inactive` | Sequence is not published and active. |
| `plan_limit` | Enrollment would exceed the workspace's plan limit. |
| `no_sender` | No sendable mailbox is available under the sender selection. |
| `sending_disabled` | Workspace is inactive, its kill switch is on, unsubscribe protection is unavailable, or enrollment failed unexpectedly. Delivery entitlement checks remain in `canSend()`. |
| `not_manager` | The manager/verified-owner authorization gate is not satisfied. |

A sequence can be archived while published once it has no leads scheduled or
sending, which is how a finished campaign is archived. When several campaigns
share a sequence, the web app shows the newest one on the row; older ones stay
reachable through the API and MCP.

Leads enrolled straight into a published sequence belong to no launched
campaign. `sequences.list` and `sequences.get` both report that run from the
sequence's own enrollments, through the same shared derivation: `displayStatus`
is `finished` once every lead has ended, with `completedAt` set to the last
lead's stop time. A published sequence with zero enrollments is never
`finished`. The two operations always agree on `displayStatus`, `statusReason`,
and `completedAt` for the same sequence.

Paused campaigns never auto-enroll or restart. Plain Resume resumes existing
enrollments only; `campaigns.launch` resumes and enrolls eligible waiting leads
from the full audience. Draft and archived campaigns and campaigns with zero
lists are absent from `campaignUpdates`. Linked active, paused, and completed
campaigns appear even when enrollment is blocked; archived sequences report
`sequence_inactive`.

Enrollment is deduplicated over the campaign's lifetime: a lead previously
enrolled in that campaign is never enrolled again, even through a different
linked list or after a sequence edit creates a new version. This applies to
both automatic enrollment and manual relaunch.

## Campaign lifecycle

`GET /v1/campaigns` (`campaigns.list`) and `GET /v1/campaigns/:id`
(`campaigns.get`), including their MCP equivalents, return campaign
`displayStatus`, `statusReason`, and `completedAt` fields. Stored `status`
remains `draft | active | paused | completed | archived`.

| `displayStatus` | Meaning |
|---|---|
| `draft` | Never launched. |
| `active` | Launched with leads still in progress and no attention reason. |
| `needs_attention` | Stored status is active, but sending is blocked. |
| `paused` | Campaign was paused by a person. |
| `finished` | Stored status is completed; launched with zero leads in progress. |
| `archived` | Campaign is archived. |

In-progress enrollments are `scheduled | active | paused`; system-paused leads
keep a campaign open. `statusReason` is
`"sequence_paused" | "mailbox_reconnect_required" | "sending_failed_repeatedly" | "sending_disabled" | null`.
It explains `needs_attention` and is `null` for other display statuses.
Normal scheduling windows and daily caps do not mean `needs_attention`.

`completedAt` is an ISO timestamp or `null`, set when a launched campaign
finishes. Restarting preserves this timestamp rather than clearing it;
`displayStatus` and `statusReason` continue to reflect the current state.
Active or paused campaigns finish when their last in-progress lead ends;
draft and archived campaigns are not changed by lifecycle reconciliation.

`campaigns.get` additionally returns `newLeadsReady`: the distinct count of
eligible leads in the campaign's linked lists that have **never been enrolled
in that campaign**, across all sequence versions. This is a waiting audience
count, not a guarantee that sending gates permit launch. It is `0` for draft
or archived campaigns and for campaigns with zero lists.

## Campaign audiences

- `POST /v1/campaigns/audience-preview` with `{ campaignId?, sequenceId?, listIds? }` returns
  `{ eligible, total, skipped }`. An empty list selection previews all active
  contacts. Selected lists are deduplicated; suppression, contact status, and
  existing sequence enrollments use the same rules as launch. Supplying
  `campaignId` also excludes every lead previously enrolled in that campaign,
  across all versions, and derives its sequence when `sequenceId` is omitted.
  `sequenceId` is optional before saving a draft. Preview does not enroll or send.
- `DELETE /v1/lists/:id` returns `CONFLICT` (409) when the list is the only
  list of a draft, active, or paused campaign whose sequence is live, because a
  campaign with zero lists enrolls all ready leads. The error names the
  campaign: add another list to it or archive it (archiving its sequence, as
  the app's Archive button does, counts), then delete the list. Every other
  deletion succeeds: a campaign with other lists keeps the remaining ones, and
  completed campaigns, archived campaigns, and campaigns on an archived
  sequence release the list.
- `POST /v1/campaigns/:id/launch` publishes the sequence and enrolls each
  eligible contact once from the campaign's lists, or all ready leads for a
  campaign saved with zero lists. Launching a completed campaign sets it back
  to `active` when new leads are enrolled, keeps `completedAt`, and enrolls
  eligible contacts never enrolled in that campaign, including older waiting
  list members. A completed campaign with no eligible new leads stays finished;
  one with zero lists returns `CONFLICT` and enrolls nobody. A pause or archive
  that lands during launch stays in place.
- `PATCH /v1/campaigns/:id` with a new `sequenceId` returns `CONFLICT` when the
  campaign has zero lists and its current sequence is archived, unless the
  same request sends `listIds` (`[]` selects all ready leads).

## Delivery advisor (Phase 1A, read-only)

`GET /v1/campaigns/:id/delivery-advisor` is an additive, API-only read
projection — see [the implementation plan](delivery-advisor-plan.md). It is
not a shared operation: there is no MCP tool for it, by design, so this route
is the only entry point.

Gated by the server-side `DELIVERY_ADVISOR_WORKSPACE_IDS` allowlist (a CSV of
workspace UUIDs). Before any advisor read,
the route returns `{ "enabled": false }` for a workspace that is not listed —
this is checked on every request, not cached at boot. A campaign outside the
caller's workspace returns the normal `404` whether or not the feature is
enabled, so a disabled response never implies the campaign exists.

An enabled response is `{ enabled: true, status: "ready" | "partial" | "unavailable", asOf, snapshot }`.
`status: "unavailable"` (snapshot `null`) means the read itself failed or
timed out server-side; existing launch/pause/resume/archive controls are
unaffected either way. `partial` means some fields could not be determined
and are `null` rather than a guessed zero or healthy value. The snapshot
includes the shared `campaignDisplayStatus`/`statusReason`, an ordered list of
findings (each with a stable `code`, `severity`, `source: "observed" | "recorded"`,
`observedAt`, and an optional `navigationTarget` from a fixed allowlist:
`"mailboxes" | "billing" | "sequence"` — the client maps these to routes, the
server never returns a URL), per-mailbox sender rows keyed by
`emailAccountId` with nullable capacity estimates, nullable workspace
capacity, and a nullable `nextScheduledAt` with a `nextScheduledNote` for a
paused campaign or sequence. A draft campaign and a finished/archived one
both report `nextScheduledAt: null` — never an implied upcoming send.

This endpoint performs no writes, no enqueue, no provider calls, and no
capacity/probe reservation; it reads one short, read-only, timeout-bounded
transaction. Repeated calls change nothing except `api_keys.last_used_at`,
which is ordinary authentication bookkeeping.

## Suppression and unsubscribe

- `GET /v1/suppressions` — lists up to 500 workspace suppressions.
- `POST /v1/suppressions` with `{ email, reason? }` — creates a manual
  suppression and is idempotent for the workspace/email.
- `GET /v1/unsubscribe?token=...` — validates a signed token and returns a
  small HTML confirmation page.
- `POST /v1/unsubscribe` with `{ token }` — JSON equivalent.

Sequence messages include signed unsubscribe links. Suppressed recipients are
excluded during import commit, enrollment, and the worker's final send claim.

## Analytics

`GET /v1/analytics/summary` returns 30-day sent, reply, bounce, unsubscribe,
failure, inbox-health, sequence, and recent-reply metrics.

## Billing

- `GET /v1/billing` (`billing.get`) returns the workspace's plan as the send
  gate sees it:
  - `edition`: `"cloud"` (managed) or `"selfhost"` (open source).
  - `tier`: `"lifetime"` or `"comp"` (entitled, no cap), `"free"` (legacy Free
    until `legacyFreeEndsAt`), `"none"` (needs the license) or `"selfhost"`.
  - `needsLicense`: cloud and tier `none` or `free`. Clients decide whether to
    show the license banner, and whether a Dodo return has finished, from this
    field, never from `tier`/`status`.
  - `legacyFreeEndsAt`: ISO time the legacy Free window ends (or ended) while
    `needsLicense`; otherwise `null`.
  - `sendingEnabled`: whether campaign email can go out under the plan now
    (entitled, or legacy Free with sends left this month).
  - `freePlan` (tier `free`), `monthlySendLimit` (`10000` for tier `free`,
    otherwise `null`), `sendsThisMonth`, `monthlyResetsAt`, `status`,
    `nextBillingDate`, `trialEnd`, `cancelAtPeriodEnd`, `configured`,
    `hasCustomer`, `canManage`.
  - Self-host: `tier: "selfhost"`, `configured: false`, `sendingEnabled: true`,
    `needsLicense: false`.
- In self-host, checkout, the portal link, cancel and reconcile refuse with
  code `not_available`.
- `POST /v1/billing/checkout` with `{ productKey: "lifetime" }` (owner only)
  returns `{ checkoutUrl }` for the one-time lifetime license
  (`DODO_PRODUCT_LIFETIME`). Monthly and Yearly were retired. A
  workspace holds at most one checkout intent. A request within 30 minutes
  returns the same checkout session; after that it first reconciles with Dodo
  Payments (lifetime payments, then subscriptions) and then replaces the
  intent with a fresh session.
- `409 CONFLICT` from this route always means the workspace already has a plan
  (`active`, `trialing`, `on_hold`, or `paused`, including a lifetime license),
  including one found during that reconciliation.
- The Dodo webhook grants the lifetime license on `payment.succeeded` for the
  lifetime product (a `subscriptions` row with `metadata.lifetime`, status
  `active`, no end date) and moves it to `refunded` on a full
  `refund.succeeded` or a `dispute.lost`. `POST /v1/billing/reconcile` grants
  a paid lifetime purchase whose webhook is late. Either grant makes campaign
  email waiting on `payment_required` or `free_monthly_cap` due at once.

## Workspace export and import

`GET /v1/workspace/export` downloads the workspace as one JSON file and
`POST /v1/workspace/import` loads such a file into an empty workspace. Owner
only, browser session only: API keys get HTTP 403 and there is no MCP tool.
Format, status codes and limits: [workspace transfer](workspace-transfer.md).

## Known limitations

Provider event payload formats can vary; unknown webhook shapes are recorded but do not stop a send.
