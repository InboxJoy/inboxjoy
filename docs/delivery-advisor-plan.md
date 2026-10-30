# Delivery advisor implementation plan

Status: proposed; this change contains documentation only. Baseline: merged
`main` at `74eeb5a`, 2026-10-03. Architecture/guardrails PR #14 passed CI and is
merged. Runtime code is unchanged from the validated `5a2b589` baseline.

Read [architecture](../architecture.md), [guardrails](regression-guardrails.md),
[regression matrix](campaign-regression-matrix.md) and [DESIGN.md](../DESIGN.md)
before implementation. This is the concrete Phase 1A plan from
[the feature roadmap](feature-plan.md).

## Customer outcome

The campaign overview gains an optional Delivery advisor card explaining its
recorded delivery state, selected senders, capacity estimates and next recorded
scheduled message. It helps customers understand what needs attention without
adding another launch step.

## First release

| Card item | What customers see | Meaning |
|---|---|---|
| Campaign state | Existing campaign status and reason | Reuse the shared display-status map |
| Attention items | Verification/payment, workspace kill switch, pause, sender/health, provider circuit, window/min-gap or recorded blockers | Separate observed conditions from historical message failures; unknown inputs stay unknown |
| Senders | Actual campaign sender or saved sequence selection/rotation, plus senders pinned to pending enrollments | An unrelated healthy mailbox must not make a selected failed mailbox appear healthy |
| Capacity | Shared estimated headroom: workspace daily, mailbox daily/hourly | Counts all campaigns and manual replies; not capacity allocated to this campaign; unknown if inputs are missing |
| Next scheduled | Earliest recorded pending-message timestamp, labelled as scheduled | Not a promise that the provider will accept it at that time |
| Freshness | Last checked and refresh action | Results are a snapshot and may change after reading |

Use existing navigation for any suggested action, such as opening mailbox
settings or billing. Advisor actions only refresh or navigate. Keep current
launch/pause/resume/archive controls and their existing permission rules.

A paused campaign may retain a pending timestamp; show its pause beside the
reading. Finished/archived rows must not imply a legitimate upcoming send.
No pending message means no recorded next send. Draft campaigns have no forecast.

## Scope boundaries

- New read endpoint and isolated card; additive changes to route registration,
  API response types and configuration only.
- No changes to campaign launch/enrollment, automatic list enrollment, audience
  membership, sequence versions, sender reassignment, workers, queue contracts,
  `canSend()` decisions or recovery behavior.
- No writes to business/delivery state, provider calls, probe reservations or
  send-capacity locks. Existing authentication bookkeeping stays intact.
- No migration, new dependency, AI-generated advice, DNS lookup, delivery score,
  completion forecast or automated repair action in this release.

Later DNS checks are a separate Phase 1B plan/PR. Uncertain manual replies must
be explained honestly; this release does not add a resolution mechanism.

## Read contract

The server owns the projection and all workspace scope. The browser receives
only authorized campaign/mailbox information and safe display values; it never
receives provider credentials or derives sending entitlement itself.

Proposed route: `GET /v1/campaigns/:id/delivery-advisor`, at the same authenticated
workspace-member read permission level as campaign detail. API keys keep their
existing access/scope rules; this does not grant lifecycle-write permission.

Return `{enabled:false}` when the authorized workspace is not enabled, before
advisor queries. Enabled responses discriminate `ready`, `partial` and
`unavailable`, with a nullable snapshot. Read failures return safe unavailable
information and log server-side; authentication/validation/not-found errors keep
normal API behavior. Never return SQL, provider error bodies or secrets.

Define an additive typed snapshot with:

- Campaign ID, snapshot `asOf` and completeness (`complete` or `partial`).
- Existing stored/display campaign state and reason.
- Ordered findings with stable code, severity, source and observed timestamp;
  navigation targets come from an internal allowlist.
- Sender results keyed by mailbox ID, including relevant limit window and
  nullable estimates. Mark missing inputs explicitly; never convert missing
  records to zero usage or healthy state.
- Nullable `nextScheduledAt`; omit live-delivery guarantees.

Use “No known blockers” rather than a “Ready to send” authorization. A mailbox
snapshot cannot establish contact-level suppression, replies, sequence timing
or the final worker decision. Recorded blockers must include their timestamp
and must not be presented as freshly evaluated conditions.

## Data and query rules

1. Authenticate and authorize through the existing API boundary. When enabled,
   a campaign outside the active workspace returns the normal not-found response.
   Disabled responses contain no campaign data and do not perform advisor reads.
2. Read a consistent database snapshot with one captured time for usage windows.
   Use a short read-only transaction; no `FOR UPDATE`, reconciliation or advisory
   send locks. Set a bounded query timeout and release the connection on failure.
3. Resolve the effective campaign/sequence sender selection and pending pinned
   senders without assigning or reassigning anything. Use grouped reads rather
   than queries per contact/message/mailbox.
4. Use the final claim/recheck counts from `send-message.ts` as the reference:
   accepted message rows, live `sending` claims, recent failed
   `unknown_provider_result` rows, and `manual_reply_pending`/`manual_reply_sent`
   events in the relevant windows. Scheduler counts omit unknown-result rows;
   inbox `sentToday` only reflects accepted usage. Neither is complete headroom.
   Do not count send attempts again. There is no workspace hourly cap, and summed
   mailbox headroom is not campaign allocation. Confirm DB/UTC day parity and
   rolling-hour boundaries; reservations cannot be reproduced by a read.
5. Use existing pure policy/entitlement/health helpers only with complete inputs.
   Missing data yields a partial/unknown finding. If a trustworthy capacity
   projection cannot be added independently, keep the field null and ship the
   other readings; changing send accounting requires a separate scoped PR.
6. Query `min(scheduled_at)` only for `scheduled`/`retryable` messages, scoped
   through workspace and campaign enrollments. Read historical blocked reasons
   separately from current conditions.

Reuse `hasSendingEntitlement` and `warmupDailyLimit` for supported dimensions.
Do not call `canSend` with invented recipient/reply fields or imply a provider
half-open probe was acquired. Avoid `findEligibleEnrollmentAudience`,
`campaignMetrics` and full inbox/plan reads here: they materialize unbounded rows
or expose incomplete/non-coherent usage. Existing campaign display helpers can
inform the projection, but multiple reads must share the same snapshot.

Manual uncertain reservations count within their day/hour windows and age out;
there is no automated cleanup endpoint. Unknown-result recency lacks a dedicated
index today, so query-plan/timeout checks are a release gate for capacity output.

Do not load message bodies or full lead lists into the API. Use aggregate reads
with scoped time windows and bounded response sizes. Inspect query plans with
representative isolated fixtures; add no index migration casually.
If a read cannot be bounded with existing indexes, reduce the first-release
scope or propose a separate backward-compatible index change.

## Availability and rollout

Proposed server configuration: one CSV workspace allowlist,
`DELIVERY_ADVISOR_WORKSPACE_IDS`. Empty by default means disabled everywhere.
Validate entries as workspace UUIDs rather than silently accepting bad IDs.
The endpoint exposes only availability for the authorized workspace; the raw
allowlist remains server-side. No customer setup or credentials are required.
There is no shared feature-capability bootstrap today. Keep one independent
advisor request and render nothing for `{enabled:false}`; avoid adding AppShell
context/extra workspace calls just to discover availability.

Enable only explicitly listed test workspaces first. The advisor endpoint must
enforce availability as well as authorization; hiding a card is not enough.
Avoid a global-on shortcut in the first pilot. Removing IDs disables the card
and read endpoint after applying the environment change and restarting the API
through the approved dev/release workflow. Verify container configuration
forwards the setting; environment edits alone are not a live toggle.

## UI behavior

- Place the card in the existing campaign overview below its current summary.
  Follow the existing Card/StatusBadge/Button tokens and responsive patterns.
- Fetch independently after the actual campaign identity resolves.
  The page route `/app/sequences/[id]` uses a sequence ID despite naming its prop
  `campaignId`; resolve the existing selected campaign and use its actual ID.
  Preserve current selection behavior when several campaigns share a sequence.
  Do not put this read in the campaign's required `Promise.all` load or wizard
  eligibility check. Errors affect only the advisor card.
- Fetch on opening overview and explicit refresh; no new background polling.
  Abort/ignore stale responses on campaign, workspace or request changes.
- Show loading, partial, unavailable and last-checked states in the card. Keep
  previously fetched data only for the same campaign/workspace and label it
  stale after a failed refresh. Refresh after successful lifecycle actions.
- Render only after availability is positively known; initial transport failure
  cannot expose a card in a disabled workspace. Previously enabled cards can show
  a local retry state. Advisor errors never set the page's shared fatal error or
  inherit the wizard's mandatory-check action-disabling pattern.
- Preserve keyboard focus and readable status text. Stack sender rows on mobile;
  add no modal, fixed action bar, overlay or campaign-tab dependency.

## Files and existing extension points

New paths below are proposed files, not existing implementation.

| Owner | Files | Planned change |
|---|---|---|
| Backend agent | New `packages/core/src/delivery/advisor.ts` and core tests | Consistent scoped read projection, typed snapshot and accounting tests |
| Backend agent | `packages/config/src/index.ts` and config tests | Default-empty CSV workspace allowlist |
| Backend agent | `apps/api/src/app.ts`, new API advisor tests | Register the API-only route beside campaign routes using `request.workspaceId`; pass only DB/read inputs to the core helper |
| UI agent | New `apps/web/app/app/(product)/sequences/[id]/delivery-advisor.tsx` and pure state helper/tests | Card, response mapping, request identity and local error states |
| UI agent | `apps/web/app/app/(product)/sequences/[id]/sequence-detail.tsx` | Add the card after `.campaign-overview-summary`, before `CampaignEditor`; pass the actual resolved campaign ID |
| UI agent | `apps/web/lib/api.ts` only if a typed adapter is needed | Reuse `apiFetch`; no independent entitlement/capacity calculation |
| UI agent | `apps/web/app/app/dashboard-polish.css`; `DESIGN.md` only if adding a new pattern | Reuse current card/status/button tokens and responsive layout |
| Lead | Deployment environment forwarding if required, rollout docs | Confirm the API container receives the allowlist; no deployment during planning |
| Review agent / lead | Matrix/docs and affected test suites | Independent source review, regressions and final validation |

Do not register a new shared operation for this release: operation registration
also expands MCP discovery. API-only scope keeps availability enforcement in
one supported boundary and avoids an accidental second feature entry point.

The detail component already has request-token patterns for analytics/contacts;
give the advisor separate request identity/state. `withCampaignStatus()` drops
some campaign fields, so do not derive mailbox selection from that reduced
state. The endpoint owns the sender/read projection.

Existing UI tests are Vitest pure helpers; React Testing Library is not installed.
Extract the request/state mapper for meaningful unit coverage without a new
dependency. API/core integration tests prove permission, data and no-write
behavior. Source checks alone do not establish rendered UI behavior.

## Implementation sequence and ownership

1. Backend read adapter, typed contract and availability boundary, with regression
   tests. Verify query and capacity semantics before exposing estimates.
2. Separate card and client adapter consuming the settled contract, plus state
   tests. Existing campaign controls must work through advisor failures.
3. Independent regression review, focused matrix checks and full validation.
4. Pilot rollout using authorized isolated fixtures, then deliberate expansion.

Implementation agents get non-overlapping file ownership, use the requested
low-cost models, and preserve other agents' edits. The lead integrates shared
contracts and runs the final checks. Backend contract changes settle before UI
integration; reviewers report findings before merge.

## Acceptance and merge gates

- Disabled/default configuration hides the feature; unauthorized/cross-workspace
  requests return no campaign data. Existing session/API-key role rules apply.
- Repeated reads do not change business tables, enqueue jobs, call providers or
  reserve capacity. API-key `last_used_at` remains expected auth bookkeeping.
- Equivalent fixtures with advisor on/off preserve launch, auto-enrollment,
  pause/resume/archive, version/sender pinning, finish/restart and send recovery.
- Capacity cases cover UTC rollover, rolling hour, ramp pause, workspace/mailbox
  caps, multiple campaigns, in-flight/unknown results, accepted bookkeeping and
  pending/sent manual replies. Unsupported readings stay null/partial.
- Timestamp tests select only scheduled/retryable messages for the actual
  campaign; foreign, sending, accepted and cancelled rows cannot become the
  recorded next send.
- Explicit failed sender, empty rotation selection, pinned sender and no pending
  message cases produce honest output. Historical errors retain timestamps.
- Failed/slow advisor reads never disable launch or erase the campaign page.
  Out-of-order refreshes and campaign/workspace switches cannot replace newer
  state with stale data.
- Run affected suites, then typecheck/test/build with migrations applied to the
  isolated test database. Record executed/skipped counts and query timings.
- Browser/real-provider checks follow user authorization. Visual verification is
  unverified until actually performed; mocked tests do not prove delivery.

Pilot success means the card is useful, reads stay bounded and all existing
campaign behavior remains covered by passing regression checks. Rollback is
removing the workspace allowlist entries, applying/restarting the API through the
approved workflow, and deploying the prior compatible application if necessary.
No campaign/message/job repair is part of rollback.

## Summary

Implement one optional campaign card through a scoped read endpoint. Settle the
read contract and safe accounting first, add the independent UI second, prove
the regression gates, then enable a small pilot. DNS and delivery-policy changes
remain separate later work.
