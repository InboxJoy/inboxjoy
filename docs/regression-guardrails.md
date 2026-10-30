# Regression guardrails

Historical failures from launch week (2026-09-11 → 2026-09-14), followed by
current campaign contracts verified against `main` at `5a2b589` on 2026-10-03.
Sections 1–7 retain the launch lessons; sections 8–12 document implemented
behavior that new features must preserve, without claiming every case was a
production incident. Read this with [architecture](../architecture.md) and the
[regression matrix](campaign-regression-matrix.md) before changing dependencies.

## 1. Auth URLs: matching vs. link-building are different URLs

**What broke:** verification/reset email links 404'd, then the fix broke route
matching entirely, then a login `callbackURL` bounced successful sign-ins back
to the form.

**Why:** better-auth uses `baseURL` both to MATCH incoming requests and to
BUILD outgoing links — but Caddy strips the public `/api` prefix before the API
sees requests, so the two legitimately differ. And `signIn.email({ callbackURL })`
redirects on success, not just for verification emails.

**Guardrails**
- `apps/api/src/auth.ts`: `baseURL` stays the bare origin (matching); public
  links go through `toPublicUrl()` (adds `/api`). Never "simplify" these into one.
- Never pass `callbackURL` to `signIn.email` — only to verification/reset email
  senders.
- After ANY auth change, run the smoke loop (section 6) — auth breakage is
  invisible to typecheck and unit tests.

## 2. Feature gates need a backfill for existing rows

**What broke:** enabling `requireEmailVerification` locked every pre-existing
account out of login (dev and prod, including the owner).

**Guardrail:** any newly-enforced flag (verification, consent, entitlement)
ships WITH a backfill migration or one-time script for rows created before the
feature. Ask: "what happens to every existing row when this gate turns on?"

Workspace switching keeps its nullable preference and existing-row access.
Header-free requests retain the most-recently-joined active membership fallback
for null or stale `users.active_workspace_id` values in both session-resolution
paths. Browser tabs pin reads and writes with `sessionStorage` key
`inboxjoy.workspace-id` and `x-workspace-id`; supplied headers require that exact
active membership and role, with HTTP 409 `workspace_changed` prompting a guarded
reload when the pin is stale or malformed. Header-free requests retain membership
self-healing, but must re-read an active membership after provisioning succeeds
or fails; provisioning conflicts on disabled/invited memberships never confer
owner access. API-key and MCP-token workspace pinning stays independent of the
browser preference and header. Coverage lives
in `apps/api/test/workspaces.integration.test.ts`; see
[workspace switching rollout](workspace-switching.md).

## 3. Payment/entitlement enforcement lives in `canSend`

**What broke (pre-launch):** nothing checked subscriptions at send time; unpaid
workspaces could send forever.

**Guardrails**
- All send-permission logic goes through `canSend()`
  (`packages/core/src/delivery/can-send.ts`) — never add a parallel check.
- New deny reasons: add a test per entitlement state in
  `packages/core/test/can-send.test.ts` (no sub / trialing / active / on_hold
  in + past grace / cancelled).
- One plan rule, `sendingPlan()`,
  read by canSend, both worker paths, `billing.get`, campaign status, the
  delivery advisor and the test-send footer:
  - Self-host (`INBOXJOY_EDITION=selfhost`): always `entitled`.
    `hasSendingEntitlement()` returns true there, whatever the rows say.
  - Cloud `entitled`: an `active` subscription row (the lifetime license or a
    comp), a trial before `trial_end`, or `on_hold` within 7 days of
    `updated_at`. No monthly cap, no footer. `entitlingSubscriptionSql()` is
    the same rule in SQL (scheduler tick size and order, migration 0042).
  - Cloud `legacy_free`: not entitled and `workspaces.legacy_free_until` in
    the future (stamped 30 days out by migration 0042 on every workspace that
    existed when the release shipped, entitled or not, so a trial, grace or
    comp that lapses inside the window falls back to Free; NULL for new
    sign-ups). Capped at `FREE_PLAN_MONTHLY_SEND_LIMIT` campaign sends per UTC month
    (`free_monthly_cap`), counted by the single `freePlanMonthlySendsSql()`
    fragment, with the "Sent via InboxJoy" footer set at claim time and the
    2,500-contact enrollment cap. A capped message waits for the month reset
    or the end of the window, whichever comes first.
  - Cloud `unlicensed`: everything else. Campaign sends are denied with
    `payment_required`, rechecked every 6 hours (`PAYMENT_REQUIRED_RETRY_MS`,
    from `canSend`, so both worker paths agree). The scheduler orders these
    workspaces' due rows after everyone else's (`unlicensedWorkspaceSql()`),
    so an unpaid backlog never takes tick slots from a workspace that can
    send. Setup, enrollment and launch still work.
- Manual replies are never gated by the plan, counted or capped.
- Every entitlement path releases parked `payment_required` and
  `free_monthly_cap` messages to now (`releasePlanBlockedSends`) in the same
  transaction as the row it writes: buying the license
  (`grantLifetimeLicense`), a comp (`grantCompSubscription`) and a Dodo
  subscription that ends up entitling (`upsertDodoSubscription`: webhooks,
  checkout and reconcile). A new entitlement path must call it too, or parked
  email waits up to 6 hours. Anything that reschedules a parked message from
  the sequence (resume, `refreshPendingOnResume`) clears its `blocked_reason`,
  so a later release can never pull a follow-up forward.
- `OperationContext.env.edition`, `CanSendContext.edition`, the worker's send
  and scheduler deps and `campaignDisplayStatuses`/`readDeliveryAdvisor` all
  take the edition as a required value. Never default it inside core: a
  missing edition must fail typecheck, not quietly make the managed service
  free. Production refuses to boot without `INBOXJOY_EDITION`.
- UI that asks "can this workspace send?" or "does it need to buy?" reads
  `sendingEnabled` / `needsLicense` / `legacyFreeEndsAt` / `sendsThisMonth`
  from `billing.get`, which uses the same `sendingPlan()` and count canSend
  uses. Never re-derive entitlement in the web app from `tier`/`status`.
  Payment confirmation after a Dodo return and the license banner wait on
  `needsLicense === false` (tier `none` has `freePlan: false` but still needs
  the license; a legacy Free workspace can already send). Self-host reports
  `tier: "selfhost"`, `needsLicense: false`, `configured: false`, and every
  billing write (`checkoutStart`, `portalLink`, `cancel`, `reconcile`)
  refuses with `not_available`.
- New `CanSendContext` fields must be wired into BOTH worker SQL paths
  (`schedule-due-messages.ts` AND `send-message.ts`, which has two queries:
  the claim and the final pre-send gate) — the ramp-pause bug shipped because
  a field existed in the type but neither query selected it.
  `legacy_free_until` is selected in all three.

## 4. CSS: three traps that recur

- **`position: fixed` + animated ancestors**: any `transform` on an ancestor —
  including a finished animation holding `translateY(0)` (an identity matrix) —
  becomes the containing block and strands the fixed element off-screen. Pages
  hosting fixed elements (campaign action bar) use fade-only entrances
  (`ij-page-fade`), never transform-based ones.
- **Full-viewport backdrops**: an `inset: 0` backdrop above content swallows
  clicks on everything (inbox actions bug). Interactive clusters that must stay
  clickable get an explicit z-index above the backdrop, below the popover.
- **`padding: 0` cards**: every section inside supplies its own inset — adding
  a new child (heading, empty state) without one puts it flush against the edge
  (suppressions card bug). Grep the card's siblings for their `padding-inline`
  and match it.

## 5. Verify with rendered pixels, not computed styles

Two visual bugs shipped "verified" because checks used `getComputedStyle` while
the in-app browser pane was hidden (hidden pane = no paint = blank screenshots
that grep fine). Rule: user-visible changes are verified with a real rendered
screenshot (real Chrome against localhost or dev) showing the affected region,
at desktop AND mobile widths when layout changed. "It's in the bundle" is not
verification. Follow the user's browser constraints; if browser use is not
authorized, report the visual check as unverified. Documentation-only changes
do not require screenshots.

## 6. The launch smoke loop (run after auth/billing/send changes)

Manual, ~5 minutes on the dev stack:
1. Sign up with a real inbox → consent checkbox gates submit → "check your
   email" state appears.
2. Verification email arrives, link resolves (`/api/v1/auth/verify-email` — a
   bogus token must return 401, never 404) → banner on login.
3. Sign in → lands on `/app` (NOT back on the login form).
4. `?plan=lifetime` signup lands on `/app` — never in
   Dodo. The sticky "Get your lifetime license" banner shows; clicking it
   opens the plan picker with the lifetime license selected. Pay →
   Dodo checkout → cancel returns to `/app?checkout=cancelled` with the banner
   still there; pay returns to `/app?billing=success`, the activation modal
   resolves and the banner disappears. Trialing/active/comp/lifetime
   workspaces never see the banner. A full refund of the lifetime payment in
   Dodo returns the workspace to needing the license (or to legacy Free while
   its window lasts).
5. Connect inbox → campaign → test send (cloud edition). An unlicensed
   workspace can set up and launch, but its campaign email waits with
   `blocked_reason = 'payment_required'` in `messages` (a claim-time denial
   creates no `send_attempts` row); a manual Inbox reply still goes out. Buying
   the license releases the waiting email on the next scheduler tick, with no
   footer. The dev stack has no Dodo keys: its banner says billing isn't set
   up, and a comp (`billing-admin comp <owner-email> <months>`, see
   [development](development.md)) releases the email instead. A legacy Free workspace sends with "Sent via InboxJoy" on both the
   test send and real sends, and at the monthly limit gets
   `blocked_reason = 'free_monthly_cap'`. With `INBOXJOY_EDITION=selfhost` the
   same workspace sends with no license, no footer and no billing page.
   `apps/worker/test/payment-gate.integration.test.ts` covers the claim and
   scheduler paths in both editions.
6. Password reset end-to-end; old session must be dead afterward.

Automated floor before any push: `pnpm typecheck`, `pnpm test`, and `pnpm build`
at repo root. Apply existing migrations to the isolated test database first.
DB suites skipping without `DATABASE_URL` are not a passing campaign regression
check. Record actual executed/passed/skipped counts rather than relying on old
test totals. The [matrix](campaign-regression-matrix.md) lists focused suites.

Run manual send/payment smoke checks only with authorized test accounts,
recipients and transactions. Mocked tests do not establish real provider or
checkout behavior. For documentation-only changes, check source references,
links and baseline gates; do not rebuild/deploy live services for documentation.

## 7. Deploy-day rules

- Prod deploy = the deploy script only; it health-gates and auto-rolls-back
  code, but NOT applied migrations — migrations must be backward-compatible
  with the previous release (add columns nullable, never rename/drop in the
  same release that stops writing them).
- Hot-patches on the prod checkout block the next deploy (`git checkout`
  refuses). Never edit `/opt/inboxjoy/source` directly; land the change on main.
- Migration files keep their advisory lock and transactional execution, with a
  five-second PostgreSQL `lock_timeout` (not `statement_timeout`). Retry only
  `55P03` lock failures after rollback, for at most five total attempts with
  short backoff; fail with the migration name if contention persists. Never
  edit shipped SQL files to work around contention. Existing migrations contain
  no transaction-prohibited statements; future concurrent-index migrations
  require explicit non-transactional handling.
- Any entitlement change: check the owner's own workspaces have subscription
  rows first (they stop sending otherwise).
- Two checkouts (Mac + VM) diverge fast; pull/rebase before starting local
  work and push through main — see AGENTS.md Remote Development Workflow.

## 8. Audiences and lifecycle are campaign contracts

- Use selected lists as a distinct union and preserve workspace scope,
  suppression, contact state and enrollment/history eligibility. Preview and
  actual enrollment must agree; raw list member counts are not eligible counts.
- Changing a sequence version must not resend contacts already enrolled in the
  same campaign. Sent messages keep their version and step references.
- Edits saved while paused reach leads already in the campaign
  (`refreshPendingOnResume`, `packages/core/src/resume-pending.ts`, called by
  both `sequences.resume` and campaign resume). Only an email still
  `scheduled` with no `send_attempts` row is re-rendered, from the
  same-numbered step of the current version, keeping its idempotency key and
  unsubscribe link; the enrollment then moves to that version. A lead stays on
  its version when that step number is gone, a variable has no value, or the
  stored email has no unsubscribe link. Never re-render a claimed, sending,
  retryable or ambiguous message.
- Pausing never pushes email later. While paused the scheduler keeps bumping a
  due email a few minutes ahead, so shifting by the pause length stacked on
  those bumps and held final emails back for days (UAE Architects batches,
  2026-10-24). Resume sets a follow-up to the previous accepted send + the
  step's wait + `followUpSendJitterMs`; first emails keep their time. Coverage:
  `apps/api/test/sequences.integration.test.ts` ("resumes an overdue final
  email…", "resumes a paused campaign without pushing…").
- The campaign action bar's Publish, Pause, Resume and "send to new leads"
  remount the editor, so they save unsaved edits first and stop if that save
  fails (`EditorLifecycle`, `hasUnsavedContent`). Coverage:
  `apps/web/test/campaign-status.test.ts`.
- Preserve current last-list deletion rules: block the sole list for
  draft/active/paused campaigns when their sequence is not archived; permit
  removal from a multi-list audience and repair the legacy primary list.
  Completed/archived campaigns may lose their last list. Completed relaunch
  still requires an attached list; never fall back silently to all leads.
- Only launched active campaigns with zero scheduled/active/paused enrollments
  auto-finish. Paused enrollments remain unfinished. The worker sweep is
  finish-only and quiet; completed restart happens when eligible leads are
  actually enrolled, not on a read or sweep.
- Keep campaign pause/archive scoped to that campaign and sequence controls
  scoped across its enrollments. Launch/enrollment transactions must recheck
  state so concurrent pause/archive is not overwritten.
- Campaign list/detail/audience-preview reads remain free of enrollment and
  lifecycle writes. Do not call reconciliation from a new read endpoint.

## 9. Lead additions can already trigger delivery

`enrollNewListLeads` is called by list additions and lead creation/import into a
list. Newly added eligible contacts auto-enroll into active campaigns and can
restart completed campaigns. Paused campaigns block enrollment; draft/archived
campaigns are excluded. Saving leads and enrolling them are distinct outcomes.

New tags, saved segments, import tools or list refreshes must account for this
side effect and expose membership/delivery impact explicitly. Do not route a
supposedly read-only preview through membership writes. Never broaden automatic
enrollment to draft/paused/archived campaigns as an incidental change.

## 10. Sender, version and send recovery must stay pinned

- Preserve sender precedence: explicit enrollment selection, saved sequence
  selection, then sendable workspace rotation. Campaign launch/auto-enrollment
  supplies the campaign sender. Empty saved selection retains rotation.
- Reassignment is limited to contacts eligible to move before their first
  send. Keep sent, in-flight, uncertain and conversation senders pinned.
- Deleting a mailbox (`removeMailbox`, status `removed`) keeps its row and
  every campaign sender list that names it, so a list never empties into
  "all mailboxes". Its never-emailed leads move to the campaign's other
  sendable senders by the reassignment rule above (or wait until one is
  added); leads it already emailed are threaded to it and stop with
  `mailbox_removed`. Sender checks treat a removed mailbox as belonging to the
  workspace but never sendable; the Composio expiry webhook never revives it.
  Coverage: `packages/core/test/sequence-mailboxes.integration.test.ts`
  ("deleting a mailbox"), `apps/api/test/production-bugs.integration.test.ts`.
- Active sequence content edits require no in-progress enrollments across that
  sequence, including sibling campaigns. Draft edits replace draft steps; paused
  edits create a new version that resumed leads pick up for unsent email
  (section 8); archived sequences cannot be edited.
- Preserve message idempotency keys, claim/capacity locks, send attempts and
  provider identifiers. A queue retry is not proof that a resend is safe.
- Persist accepted submission before scheduling the next step. Recover pending
  acceptance bookkeeping without another provider send.
- Ambiguous provider results pause for evidence-based reconciliation. Do not
  clear them to make retry/repair buttons convenient.
- SMTP DATA-stage timeout/socket loss is ambiguous; connection-stage failures
  are safely retryable. SMTP authentication failures reuse mailbox expiration
  and enrollment pause handling. Reconciliation can report `not_sent` only
  after opening the IMAP Sent folder, successfully searching the pinned RFC
  Message-ID, and waiting more than ten minutes from the attempted submission.
  Sent-folder APPEND failure must never invalidate a successful SMTP send.

## 11. Replies, suppressions and manual sends share safety rules

- Verified webhook events and provider reply lookup must preserve deduplication,
  human/automatic reply classification and contact-wide stop behavior.
- Persist missed reply/event data before stopping follow-ups. A reply storage
  failure must not allow the follow-up to send anyway.
- A lead's message is captured even when none of their enrollments is live,
  as long as a campaign emailed them: it goes to the latest enrollment that sent
  to them, receiving mailbox first. A human reply after the last step turns that
  `completed` enrollment into `replied`, so it counts; later messages after a
  reply, opt-out or bounce only add to the Inbox. An opt-out still suppresses.
  Nothing is resent or restarted, and mail from non-leads is ignored
  (`packages/core/test/inbound-ingest.integration.test.ts`).
- Preserve suppression from opt-out, complaints and permanent bounce evidence.
  Temporary provider/bounce warnings must not suppress contacts or stop
  enrollments through permanent-bounce handling.
  Unsubscribe GET is a confirmation view; suppression is an explicit action.
- Manual Inbox replies bypass sequence pacing through the existing manual
  policy, while retaining entitlement, safety and shared daily-volume checks.
  They do not restart campaigns. Pending/sent manual markers reserve volume;
  ambiguous results retain their reservation and reject the same request on
  retry. Inspect the provider conversation before any retry; no automated
  manual-pending resolution path exists today.
- A sequence test email via transactional infrastructure does not verify the
  connected Gmail/Outlook campaign path.
- SMTP manual replies use reply MIME without campaign unsubscribe headers.
  The optional mailbox resolver preserves the existing Composio fallback;
  SMTP replies use RFC reply/reference headers, not Gmail-only thread IDs.

## 12. Extend through additive, independently reversible features

Follow [the feature plan](feature-plan.md). The first delivery advisor is
read-only: no enrollment, reconciliation, queue dispatch, provider send/probe,
capacity reservation, sender reassignment or lifecycle mutation. Reuse pure
canonical helpers with complete snapshots; report unknown/partial data honestly.

Advisor failures must leave existing campaign actions usable. Initial DNS
checks are advice, not new send gates. Any future gate needs a separate design,
existing-customer/backfill analysis, tests and rollout plan.

Each runtime PR names affected contracts, tests, migration/backfill needs and
rollback. Require on/off and failure-path checks for optional features. Keep
provider keys managed server-side; never request customer API keys for managed
features. Update this document and the matrix when implemented contracts change.

## 13. SMTP/IMAP mailboxes: gates, secrets and rollback

- `SMTP_MAILBOXES_ENABLED` gates SMTP creation, credential update/verification,
  inbound polling and the SMTP connection UI (`GET /v1/inboxes.features.smtp`).
  It does **not** gate sending for existing SMTP rows. Turning it off is not a
  delivery kill switch; OAuth connections and existing sender selection remain
  usable, and existing SMTP rows still display their correct provider label.
- Rollback order: pause or disconnect SMTP mailboxes **before** reverting code
  that supports them. Confirm sending has stopped, then disable the feature and
  revert. Do not assume removing the connect menu stops already queued delivery.
- Passwords never appear in API responses or logs. Edit forms prefill only
  non-secret host/port/security/username values; passwords start empty and PATCH
  omits unchanged passwords. Analytics records only the provider, using the
  existing `mailbox_connect_started/succeeded/failed` event names.
- Provider circuit breakers use the per-mailbox key `smtp:<id>`, not a shared
  SMTP or OAuth-provider circuit. A single mailbox failure must not stop others.
- SMTP reconnect uses the credentials PATCH route, never OAuth connect-link.
  Check connection uses POST verify; because verification reactivates the row,
  the UI disables it for paused/disconnected mailboxes rather than resuming
  sending implicitly. Existing send safety, sender pinning, reply-stop,
  suppression and rotation contracts apply to SMTP too.
- Web regression coverage: `apps/web/test/smtp-mailbox-form.test.ts` and
  `apps/web/test/smtp-mailbox-ui.test.ts` protect validation, non-secret prefills,
  password retention/replacement, API field errors and submission locking.
  Browser and real-provider verification remain separate checks; a mocked web
  test does not prove SMTP delivery or IMAP polling.
- Changing an SMTP mailbox's host, port or username requires the password in
  the same request (`parseConnection`). A stored password is never sent to a
  different server. Saving or re-verifying resumes enrollments paused for
  `mailbox_auth_expired` and clears the IMAP poll backoff.
- An IMAP failure is not a reason to drop a lead. The pre-send reply lookup
  retries (`ImapError`; auth failures pause the mailbox). The poller backs off
  per mailbox (`imap_poll_failures`, `imap_poll_retry_at`), notifies once at
  five failures or on a failed login, and never expires the mailbox itself.
- The poll cursor moves past a message only when it was ingested, confirmed
  expunged, or failed three polls in a row for a message-level reason and a
  failed `provider_webhook_events` row was written. Connection and database
  errors never skip a message.
- Opt-out replies on SMTP mailboxes use core `applySuppression`, the same path
  as the webhook. An opt-out whose suppression did not run still stops the
  sequence as a reply.
- Sender-side SMTP 5xx (any command except `RCPT`) counts toward the
  repeated-failure sequence pause, scoped to the mailbox. `RCPT` rejections
  stay per-recipient.

## 14. Authorization boundaries closed by the 2026-10-20 security audit

Gaps where a credential, an unproven identity or hostile inbound mail reached
more than it should. Keep each boundary where it is.

- **Founder stop is workspace status, not the user's pause.**
  The founder stop sets `workspaces.status = 'paused'`; the user's
  "Pause all sending" is `kill_switch_enabled`. `workspace.update` must never
  accept `status`, and anything that gates sending must keep checking
  `status === "active"` alongside the kill switch (`canSend`, `enrollSequence`,
  worker SQL, campaign status, sequence test sends). Coverage:
  `apps/api/test/settings.integration.test.ts` ("founder stop").
- **API keys never reach admin-only operations.** Every request carries
  `request.authKind` (`"api_key"` or `"session"`), set in the auth hook.
  `runWorkspaceOperation` rejects any operation named in
  `MCP_ADMIN_OPERATIONS` for API keys with the same 403 the route-level
  `keyForbidden` list uses, so REST and MCP expose the same surface to machine
  credentials. Adding an operation to `MCP_ADMIN_OPERATIONS` closes it to API
  keys automatically; a new key-forbidden route still needs the hook list when
  it has no operation name.
- **Sending controls are never set by a machine credential.**
  `MACHINE_FORBIDDEN_FIELDS` (`packages/core/src/mcp-admin-operations.ts`)
  lists operation fields only a signed-in person may set; today that is
  `killSwitchEnabled` and `dailySendCap` on `workspace.update`.
  `machineForbiddenField()` is checked in both places a machine reaches an
  operation: `PATCH /v1/workspace` for API keys and the MCP tool handler for
  every MCP token (API key or OAuth). A new machine entry point must check it
  too. Coverage: `apps/api/test/auth-hook-encoded-paths.test.ts`,
  `apps/api/test/settings.integration.test.ts`,
  `apps/api/test/mcp.integration.test.ts`.
- **Invitations need a verified email.** Signup does not require
  verification, so `team.invitePreview` and `team.inviteAccept` join
  `auth_users.email_verified` and return/raise `verify_email` for a matching
  but unverified address (a missing auth row counts as unverified). The web
  invite page shows "verify your email first" with a resend that carries
  `next=/app/invite/<token>`. Do not relax this to the email string
  comparison alone. Coverage:
  `packages/core/test/team-invite-verification.integration.test.ts`,
  `apps/api/test/workspaces.integration.test.ts`,
  `apps/web/test/invite-auth-paths.test.ts`.
- **Invite-only sign-up admits by the invitation's token, never the address.**
  A matching address alone proves nothing: anyone can type an address that
  has a pending invitation. `admitSignup` (`apps/api/src/auth.ts`) admits an
  invitee only when the sign-up body's `inviteToken` hashes to a pending,
  unexpired invitation for that exact address; the sign-up form sends it from
  `?next=/app/invite/<token>`. Sign-up, preview and accept all look tokens up
  through `findInvitationByToken` (`packages/core/src/invitation-token.ts`).
  In invite mode the inviting workspace must also have the instance owner
  (the oldest `auth_users` row) as an active member, any role
  (`instanceOwnerBelongsTo`). Every invitee owns a personal workspace and may
  invite from it, so without this check one invitation would open the server
  to anyone; those invitations still reach existing accounts but never admit
  a new one (`signup_closed`). Do not drop the check or widen it to "any
  verified inviter". `team.invite` requires the calling owner to be verified
  (`email_unverified`), because its link admits a new account. On self-host
  only, an account created with a valid token starts verified (the owner
  handed the link over, and the server may have no system email); cloud
  invitees still verify by email. Coverage:
  `apps/api/test/signup-mode.integration.test.ts`,
  `packages/core/test/team-invite-verification.integration.test.ts`,
  `packages/core/test/invitation-token.test.ts`,
  `apps/web/test/signup-status.test.ts`.
- **A fresh self-hosted server is claimed only through the installer's link.**
  While no sign-in account exists and `SETUP_TOKEN` is set (self-host only),
  the first sign-up must carry a matching `setupToken` (constant-time compare)
  or gets 403 `setup_token_required`. The token is checked before the
  first-account claim, so a refused attempt never holds the claim. The first
  account on a self-hosted server starts verified in both sign-up modes.
  `/v1/public/status` reports `setupTokenRequired`, never the token. Coverage:
  `apps/api/test/signup-mode.integration.test.ts`,
  `apps/api/test/edition-gating.test.ts`.
- **Inbound parsing stays linear.** Anyone can send a `mailer-daemon@` email,
  and bounce parsing reads the whole body, so a pattern that backtracks
  quadratically stalls the reply worker. Email-address matching in
  `packages/core/src/inbound/classify.ts` uses `EMAIL_PATTERN`, whose
  lookbehind lets a match start only at the beginning of a run; never put two
  quantifiers that can match the same characters next to each other (e.g.
  `\s*;?\s*`). Coverage: `packages/core/test/inbound-classify-redos.test.ts`
  (500 KB hostile bodies).
