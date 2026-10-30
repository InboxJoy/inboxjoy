# Campaign regression matrix

Baseline: `main` at `5a2b589`, reviewed 2026-10-03. This maps existing tests to contracts. It does not claim full coverage of every production outcome. The proposed advisor tests below are future acceptance criteria, not tests already present.

## Existing protected behavior

| Area | Must preserve | Existing coverage |
|---|---|---|
| Campaign lifecycle | Distinct list audience; last-list protection and completed relaunch; launch/archive race; pause/resume scope; finish/restart; new-version history; auto-enroll only new list members | `packages/core/test/campaign-lifecycle.integration.test.ts`, `packages/core/test/campaign-status.test.ts`, `packages/core/test/enroll-new-list-leads.test.ts` |
| Eligibility | Deduplicated overlapping lists; tenant scope; suppression; already-enrolled history; completed contacts not resent in same campaign | `packages/core/test/enrollment-eligibility.test.ts`, `packages/core/test/campaign-lifecycle.integration.test.ts` |
| Staged enrollment | Draft `sequences.enroll` queues only (no schedule); publish converts the queue through the normal enroll path (suppression applied, duplicates ignored); repeated publish does not double-enroll; archive/delete discards the queue; queue is tenant-isolated; a queue row is deleted only in the transaction that enrolls its lead, so a crash or blocked publish (any queue size) keeps every unconverted contact queued | `packages/core/test/staged-enrollment.integration.test.ts`, `packages/core/test/staged-conversion-durability.integration.test.ts` |
| Sequence editing | Active/archived edit restrictions; sent mail keeps its version; edits saved while paused re-render resumed leads' next unsent email (leads missing a variable stay on their version); resume never pushes follow-ups later; action-bar lifecycle buttons save unsaved edits first; mailbox-only editing compatibility | `apps/api/test/sequences.integration.test.ts`, `packages/core/test/campaign-lifecycle.integration.test.ts`, `apps/web/test/campaign-status.test.ts` |
| Sender assignment | Saved sender selection; explicit override; empty-selection rotation; keep sent/in-flight/uncertain senders; reconnect reassignment; mailbox deletion moves never-emailed leads, stops threaded ones and never empties a sender list | `packages/core/test/sequence-mailboxes.integration.test.ts`, `packages/core/test/sequence-mailboxes.test.ts`, `apps/worker/test/inbox-rotation.integration.test.ts`, `apps/api/test/inbox-rotation.integration.test.ts` |
| Final permission | Owner verification, payment, kill switch, suppression, sequence/campaign state, volume, health and windows rechecked before send | `packages/core/test/can-send.test.ts`, `apps/worker/test/payment-gate.integration.test.ts`, `apps/worker/test/delivery-control.integration.test.ts`, `apps/worker/test/send-message.test.ts` |
| Scheduling/capacity | Duplicate ticks/jobs cannot send twice; in-flight and manual replies reserve shared volume; bounded stagger/claim behavior | `apps/worker/test/schedule-due-messages.test.ts`, `apps/worker/test/send-message.test.ts`, `packages/core/test/transaction-retry.test.ts`, `apps/api/test/production-bugs.integration.test.ts`, `apps/api/test/mcp-ops.integration.test.ts` |
| Send recovery | Unknown provider result pauses; accepted-message bookkeeping retries without resend; reply persistence retries safely; manual definite rejection releases reservation and ambiguous result retains it | `apps/worker/test/send-message.test.ts`, `apps/worker/test/reply-fallback.integration.test.ts`, `apps/api/test/mcp-ops.integration.test.ts` |
| Inbound safety | Genuine reply stops; automatic reply distinction; opt-out/permanent-bounce evidence; idempotent reply persistence on redelivery; unsubscribe GET does not suppress; replies after the last step and follow-up messages are captured without restarting anything | `apps/api/src/modules/webhooks/index.test.ts`, `apps/api/test/unsubscribe.integration.test.ts`, `apps/worker/test/backfill-replies.test.ts`, `packages/core/test/inbound-ingest.integration.test.ts` |
| Lifecycle sweep | Bounded finish-only sweep, no restart, no notification burst | `apps/worker/test/reconcile-campaign-statuses.test.ts` |
| Billing | Pending checkout reuse, expired reconciliation races, canonical entitlement and webhook idempotency | `packages/core/test/billing.integration.test.ts`, `apps/api/test/billing-webhook-regressions.integration.test.ts`, `apps/api/test/billing-reconcile-route.test.ts` |
| Tenant isolation | Session/API-key workspace boundaries and role checks, including MCP operations | `packages/core/test/tenant-security.integration.test.ts`, `packages/core/test/operations.access.test.ts`, `apps/api/test/tenant-isolation.integration.test.ts`, `apps/api/test/mcp-ops.integration.test.ts` |
| UI state | Refinement uses step ID + source snapshot; wizard audience count contract; saved sender compatibility | `apps/web/app/app/(product)/sequences/new/campaign-wizard.test.ts`, `apps/web/app/app/(product)/sequences/sender-mailboxes.test.ts` |

Existing pure/source tests do not prove rendered UI behavior. Inbox stale-selection/filter behavior still needs a browser/component regression when its UI changes; no-browser runs must report that visual verification was not performed.

### SMTP/IMAP provider contracts

These rows are acceptance contracts for SMTP alongside Gmail/Outlook. Backend
phases are being integrated separately; listed backend suites are not a claim
that phase 6 ran them or that provider behavior has been smoke-tested.

| Area | SMTP must preserve | Coverage / remaining verification |
|---|---|---|
| Send | Canonical final permission and MIME; accepted submission persisted before progression; ambiguous DATA outcome held; existing rows still send with the creation/polling/UI flag off; per-mailbox `smtp:<id>` circuit | Phase 4: `apps/worker/test/send-message-smtp.integration.test.ts`, `packages/email/test/campaign-mime.test.ts`; real SMTP delivery and flag-off sending need provider/backend validation |
| Reply-stop | IMAP human replies stop contact-wide follow-ups; automatic replies do not; persist reply evidence before stopping, preserve deduplication and pinned sender | Phase 5 polling/reply-stop coverage must be confirmed by the backend owner; real IMAP reply detection is unverified by web tests |
| Bounce-suppression | Permanent SMTP/IMAP bounce evidence suppresses once with tenant isolation; temporary failures do not suppress; preserve opt-out and complaint handling | Existing shared classification: `apps/api/src/modules/webhooks/index.test.ts`; SMTP-specific bounce parsing/polling coverage must be confirmed by the backend owner |
| Rotation | SMTP joins sendable workspace rotation; saved/explicit selection wins; sent/in-flight/uncertain and conversation senders stay pinned | Phase 4: `apps/api/test/inbox-rotation.integration.test.ts`, `apps/worker/test/inbox-rotation.integration.test.ts`; web sender compatibility: `apps/web/app/app/(product)/sequences/sender-mailboxes.test.ts` |
| Connection UI | Feature-gated connect/edit/verify; no SMTP OAuth redirect; empty saved-password prefills and omitted unchanged passwords; field validation/errors; provider-only analytics | `apps/web/test/smtp-mailbox-form.test.ts`, `apps/web/test/smtp-mailbox-ui.test.ts`; desktop/mobile, keyboard and live connection checks belong to browser/provider verification |

The listed webhook tests cover classification helpers, suppression writing and
idempotent reply persistence; they do not establish route-level signature
verification or `provider_webhook_events` ledger deduplication. Add those
integration regressions before changing that endpoint. Manual reply recovery is
also distinct from campaign recovery: retained pending reservations have no
automated resolution path today.

## How to run focused checks

SMTP phase 4 coverage: `packages/email/test/campaign-mime.test.ts` protects the
unchanged campaign MIME; `packages/smtp/test/client.test.ts` and
`apps/worker/test/reconcile-inbox-smtp.test.ts` cover submission and conservative
Sent evidence. `apps/worker/test/send-message-smtp.integration.test.ts` covers
durable acceptance, retry/auth/ambiguous-result handling, credential redaction
and per-mailbox circuit keys. The existing API and worker inbox-rotation suites
also cover SMTP participation and pinned senders. SMTP live delivery is opt-in
through `packages/smtp/test/smtp.live.test.ts`; skipped DB/live suites are not
provider verification.

Run from a branch or worktree, using the isolated test database.

```sh
# Load the isolated test database settings in this shell first.
# DATABASE_URL must target the test container/database, never dev or production data.
pnpm --filter @inboxjoy/core exec vitest run test/campaign-lifecycle.integration.test.ts test/enrollment-eligibility.test.ts test/sequence-mailboxes.integration.test.ts test/can-send.test.ts
pnpm --filter @inboxjoy/worker exec vitest run test/schedule-due-messages.test.ts test/send-message.test.ts test/payment-gate.integration.test.ts test/delivery-control.integration.test.ts test/reply-fallback.integration.test.ts test/reconcile-campaign-statuses.test.ts
pnpm --filter @inboxjoy/api exec vitest run test/sequences.integration.test.ts test/tenant-isolation.integration.test.ts src/modules/webhooks/index.test.ts test/unsubscribe.integration.test.ts
```

Apply existing migrations to the isolated test database before running DB suites. Choose additional rows based on touched behavior, then run the full gates:

```sh
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

DB suites that skip because `DATABASE_URL` is missing are not a campaign regression pass. Keep logs and report actual executed/passed/skipped counts. PR CI creates a fresh test database, runs migrations plus all three workspace gates and posts the `vm-ci` commit status.

## Acceptance tests to add with the first advisor feature

1. Calling the advisor repeatedly leaves campaigns, versions/steps, list memberships, enrollments, messages, attempts, events, notifications, suppression and mailbox assignments unchanged. Assert no enqueue/provider send/probe reservation/lifecycle write, not only HTTP success.
2. Existing launch, automatic list enrollment, pause/resume/archive, finish/restart and unknown-send recovery behave identically with the advisor enabled and disabled, using equivalent isolated fixtures.
3. The read endpoint enforces session/API-key permissions and workspace boundaries; a supplied campaign/mailbox ID from another workspace returns no data.
4. Advisor errors or timeouts leave existing launch controls usable. Empty/stale snapshots show unknown/last checked rather than a false sending guarantee.
5. Effective capacity accounts for configured limits, ramp, health, accepted sends, in-flight/unknown submissions and manual reply reservations. Test midnight, caps, paused campaigns, unpaid workspaces and unhealthy selected mailboxes.
6. Stale UI responses cannot overwrite a newer campaign/mailbox selection. Keyboard/mobile layout and loading/error states are checked when browser use is authorized.

These no-write assertions apply to business/delivery state. Existing API-key
authentication may update `api_keys.last_used_at`; test that established access
bookkeeping separately rather than changing it for the advisor.

Implemented coverage (Phase 1A): items 1 and 3–5 above are covered by
`packages/core/test/delivery-advisor.integration.test.ts` (no-write across
repeated reads, tenant isolation/not-found, draft/paused/finished
`nextScheduledAt` behavior, accepted/in-flight/unknown-result/manual-reply
capacity accounting, an explicitly failed sender not masked by an unrelated
healthy mailbox, and recorded-vs-observed finding timestamps). Item 3's
route-level enforcement (session, API key, allowlist-disabled path, malformed
id) is covered by `apps/api/test/delivery-advisor.integration.test.ts` and
`apps/api/test/delivery-advisor-env.test.ts`. Item 2 (equivalent on/off
regression fixtures for launch/enrollment/pause/resume/finish) relies on the
existing suites in this matrix passing unchanged with the advisor's additive
code present, rather than a dedicated advisor-specific duplicate of each; see
the PR for the executed/skipped counts that confirm this on the isolated test
database. Item 6's
client-side stale-response guard is covered by the pure state-mapping tests
in `apps/web/app/app/(product)/sequences/[id]/delivery-advisor-state.test.ts`;
keyboard/mobile/loading visual behavior still requires a browser check (see
the PR for whether one was performed).

Later DNS-stage tests must cover timeout, missing/multiple records, an unknown DKIM selector and tenant-safe caching. DNS failure must not pause, enroll or block an existing campaign.

## Merge evidence

Each runtime PR should list the baseline SHA, changed contracts, relevant matrix rows, executed checks, migration/rollout risks and rollback method. A docs-only PR lists changed docs and validates links/source references; it does not need a live-stack rebuild. No automatic CI claim implies real Gmail/Outlook delivery or payment checkout was tested.
