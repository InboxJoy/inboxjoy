# Safe feature plan

Status: proposed implementation plan; documentation work only in this change.
Baseline: `main` at `5a2b589`, reviewed 2026-10-03. The baseline CI run passed all configured gates. This is a code/CI observation, not proof of a production smoke test.

## Objective

Add customer value in small independently reversible changes while preserving campaign audiences, sender assignment, sequence versions, timing, safety gates and lifecycle behavior. Start with delivery visibility; change sending behavior only in a separately scoped later feature.

Documentation and tests reduce regression risk. They cannot guarantee that no future bug will occur; each feature must prove the relevant contracts before rollout.

## Phase 0 — document and freeze the contracts

Deliverables in this change:

- [Architecture](../architecture.md): implemented components, entry points and durable boundaries.
- [Regression guardrails](regression-guardrails.md): historical failures plus current campaign contracts.
- [Regression matrix](campaign-regression-matrix.md): existing test coverage and required new advisor cases.
- [Documentation index](README.md): current references versus original specification and proposed backlog.
- Agent/repository instructions linking these documents before campaign-related work.

Completion: links and source/test paths checked, documentation reviewed against current code, and current baseline gates recorded. No application, schema, queue, runtime configuration or deployment change belongs in this phase.

Baseline validation on 2026-10-03 from the isolated VM worktree: typecheck,
tests and build passed after applying migrations to test PostgreSQL. All 720
Vitest tests passed (0 skipped), plus 2 deployment-script tests. Breakdown:
core 291, worker 94, API 184, web 98, domain 5, Composio 20, email 28.
Real provider sends, checkout and browser smoke checks were not performed for
this documentation change. Re-run relevant checks for each implementation PR;
these results do not validate future advisor code.

## Phase 1A — delivery visibility only

The concrete endpoint/UI/rollout sequence is in the
[delivery advisor implementation plan](delivery-advisor-plan.md), based on
merged `main` at `74eeb5a`. It remains proposed until implemented and tested.

### Customer experience

An optional delivery-advisor panel explains a campaign's recorded state, sender readiness, blocked reasons, estimated remaining capacity and the next known scheduled message time. It is informational: customers keep using the existing launch/pause/resume controls.

### Implementation boundaries

| Proposed work | Constraint |
|---|---|
| Small read adapter in `packages/core/src/delivery/` | Reuse pure canonical policy/entitlement/health helpers and read projections; no second implementation of send permission |
| Additive REST endpoint under `apps/api/src/modules/` | Existing authentication, authorized workspace and permission boundary; bounded grouped queries, no arbitrary workspace from request body |
| Existing campaign/mailbox UI entry point | Read `DESIGN.md`; reuse existing cards/status styles; protect against stale request responses |
| Small server-side enable/disable setting | Proposed, not present today. Default disabled, expose only availability to UI, no credentials. No feature-flag dependency is required |
| Tests | Add the advisor acceptance cases in the regression matrix before enabling the feature |

Initial sources: campaign read/display projections, audience eligibility, mailbox connection/health/schedules, durable message timing, accepted/in-flight/unknown/manual volume accounting. A campaign with an explicitly selected unavailable sender must not be represented as ready because another workspace mailbox is healthy.

A projection may call a pure policy helper with a complete observed snapshot; it cannot reserve workspace capacity or a provider half-open probe. If required data is unavailable, show an unknown/partial answer. Do not read a simplified daily-usage counter and present it as exact remaining capacity.

Display `asOf`/last checked. "Next scheduled" is the timestamp recorded on a message, not a promise of delivery. A paused campaign, cap, missing entitlement, new reply or provider issue can delay it. Do not invent an exact completion forecast in this stage.

### Protected surface for this first feature

- No changes to scheduler/send/reconcile worker jobs, queue names/payloads/cadence or `canSend()` decisions.
- No launch, enrollment, auto-enrollment, sender reassignment, sequence version or lifecycle mutation from the advisor.
- No new launch requirement or DNS prerequisite.
- No schema migration or provider integration is needed for the initial read-only panel.
- No automatic reconnect/resume/repair button in this stage; link to the existing screen when appropriate.

Minimal API route registration, shared exports and a new availability setting may touch existing files; keep those edits additive and list them in the PR. Any necessary sending-policy change becomes a separate scoped change with its own tests.

### Acceptance and rollout

1. Read contract/unit tests, tenant tests and no-write/no-enqueue integration checks pass.
2. Run the matrix's campaign/send/billing/response checks with the setting both disabled and enabled, then full typecheck/test/build with DB suites executing.
3. Verify on dev using authorized test fixtures. Browser use follows the user's instruction; if unavailable, record the missing visual check rather than claiming it passed.
4. Enable for a test workspace/configuration only, observe read latency/errors and unchanged sending outcomes, then expand deliberately. Workspace-level rollout control must be explicitly implemented if needed; it does not exist by implication.
5. Roll back by disabling the advisor and, if needed, deploying the prior compatible application version. Existing campaign rows, messages and jobs require no repair.

## Phase 1B — advisory domain checks

Separate PR after 1A acceptance. Show SPF/DMARC findings and DKIM status only where a selector or trustworthy provider evidence is available. Use bounded DNS lookups, timeout, TTL caching and last-checked metadata. Do not send probe emails, invent DKIM selectors or claim DNS records prove Inbox placement.

Cache or background refresh, if needed, belongs to the new feature and has a separate reviewed lifecycle. Existing send jobs must not wait for these checks. DNS findings remain advice; making them a sending gate would require a later contract change and rollout plan for existing customers.

## Later features — one plan and PR at a time

| Order | Feature | Initial boundary to protect |
|---|---|---|
| 2 | Reply labels, assignment and snooze | Metadata around the existing Inbox; keep webhook classification, stop-on-reply and manual-send idempotency intact. AI drafts require human review |
| 3 | Saved templates and brand voice | Explicitly apply to a draft/new version; never rewrite content already pinned to messages/enrollments |
| 4 | Tags and saved lead segments | Preview membership changes. List additions can already auto-enroll contacts, so segment refresh must not silently trigger sending |
| 5 | Staged draft audience | Separate unscheduled staging; retain current draft enrollment rejection until the new explicit workflow is implemented. |
| 6 | A/B testing, conversion metrics, CRM sync | Separate designs for variant/version identity, measurement and suppression sync; no broad pipeline rewrite bundled with them |

Do not implement these future phases as part of the advisor PR. Existing automatic list enrollment, completion/restart and saved sender selection remain established features, not new work to recreate.

## Per-feature change record

Put these short items in each runtime PR:

- Baseline SHA and customer-visible change.
- Files/operations touched and relevant matrix rows.
- Existing behavior to preserve; additive response/schema/queue contract changes.
- Tests proving the feature on/off and failure paths; DB suites executed, visual/provider checks actually performed.
- Migration/backfill compatibility, rollout setting and rollback procedure.

No new provider keys in customer setup or browser code. Existing server-managed integrations are reused, and deployment secrets stay in their established locations.

## Summary

Document the current contracts first. Ship the read-only advisor next, then advisory DNS checks. Expand to reply workflow and templates through separate tested changes; audience automation and sending-policy changes get their own explicit design before implementation.
