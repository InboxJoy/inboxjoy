# Workspace switching and invitation email

## Contracts

- `GET /v1/workspaces` lists the signed-in user's active memberships, sorted by
  workspace name, with `{ id, name, role, isCurrent }` for each workspace.
- `POST /v1/workspaces/switch` accepts `{ workspaceId }`, validates active
  membership, stores `users.active_workspace_id`, and returns `{ workspaceId }`.
  Missing, unrelated, disabled, and invited-only memberships all return 404.
- Each browser tab stores its workspace ID in `sessionStorage` under
  `inboxjoy.workspace-id`. `apiFetch` and direct API fetches send this value as
  `x-workspace-id`, preserving the tab's workspace for reads and writes.
- Session requests carrying `x-workspace-id` resolve exactly that workspace's
  active membership and role. Malformed values, unrelated workspaces, inactive
  or removed memberships, deleted workspaces, and a previous user's tab pin
  receive HTTP 409 with `{ error: "Your workspace changed. Reload to continue.",
  code: "workspace_changed", correlationId: request.id }` before operations run.
- Header-free session requests use `users.active_workspace_id`, then the most
  recently joined active membership for null or stale preferences. Membership
  self-healing remains available to header-free requests, but provisioning does
  not grant access by itself: both successful provisioning and provisioning
  failure re-resolve active membership and use its workspace ID and role. If no
  active membership exists, return HTTP 403 with
  `{ error: "No active workspace membership found." }`. An existing disabled or
  invited membership must never become implicit owner access. The preference
  provides the default for fresh tabs and fresh logins; switching preserves membership
  timestamps, roles, subscriptions, and delivery data.
- AppShell adopts the `isCurrent` ID after a successful workspace list response
  when the tab's stored ID is empty. Initial requests from a fresh tab use the
  server default until this adoption completes. Storage reads, writes, and
  removals are guarded; pages remain usable when storage is unavailable.
- Workspace switching stores the response's new `workspaceId` in the tab before
  full navigation to `/app`. Invitation acceptance stores the joined workspace
  ID in the same order. Each sign-out flow clears the tab ID; email sign-in and
  signup clear it before authentication.
- On `409 workspace_changed`, `apiFetch` clears the tab ID and reloads once. The
  `inboxjoy.workspace-reload` session flag persists across reloads and clears on
  the next successful `apiFetch` response, including HTTP 204. An in-memory guard
  coalesces concurrent failures; unavailable storage retains this per-page guard.
  The reloaded tab adopts the server default through the workspace list.
- Cross-origin development uses `NEXT_PUBLIC_API_BASE_URL` and permits
  `x-workspace-id` alongside `content-type` and `authorization` in API CORS.
  The same-origin Caddy `/api` proxy carries the same header.
- API keys are forbidden on plural `/v1/workspaces` routes. API keys and MCP
  OAuth bearers resolve their credential's pinned workspace independently of
  `x-workspace-id`. API keys may `GET`/`PATCH` singular `/v1/workspace` for name,
  timezone and postal address, but not `killSwitchEnabled` or `dailySendCap`,
  and never `DELETE` it. MCP tokens remain workspace-pinned, and
  `workspaces.list` / `workspaces.switch` are excluded from MCP tool registration.
- Invitation acceptance sets the active preference in the membership transaction.
- Invitation creation permits 20 unaccepted, unexpired invitations per workspace.
  A workspace row lock serializes creation, and reinviting the same email replaces
  its pending invitation at the cap. Other invitations at the cap return 409.
- `POST /v1/team/invitations` allows ten requests per minute and returns
  `{ invitation, token, emailSent }` with HTTP 201. Email happens after commit;
  disabled/missing service, missing web URL, or send failure returns
  `emailSent: false` without invalidating the invitation.
- `PATCH /v1/team/members/:id` accepts `{ role: "admin" | "member" }` and calls
  the write operation `team.memberRoleChange`, returning `{ id, role }` with
  HTTP 200. The ID is the membership ID returned by `team.list`, also used by
  `team.memberRemove`. Only an active workspace owner can change roles; admin
  and member callers receive 403. Owner targets and the caller's own membership
  receive 403; unknown, cross-workspace, disabled, and invited membership IDs
  receive 404. Invalid roles or IDs receive 400. The update changes only role
  and `updatedAt`; `team.list` reflects the new role. API keys cannot access the
  REST route, and neither API keys nor OAuth tokens can call it through MCP.
- `packages/core/src/mcp-admin-operations.ts` exports `MCP_ADMIN_OPERATIONS`,
  the single exclusion set used by API tool registration and core/API tests.
  Every `apiKeys.*`, `team.*`, `workspaces.*`, and `billing.*` operation, plus
  `suppressions.remove`, `sequences.delete`, and `workspace.delete`, stays out
  of MCP regardless of credential scopes.
- Invitation mail uses `${webBaseUrl}/app/invite/${token}`, a seven-day link,
  escaped HTML names and recipient email, and subject names with CR/LF removed
  and each name truncated to 80 characters. It uses the existing branded shell
  and postal footer with a plain-text alternative.

## Migration and rollback

Apply `packages/db/migrations/0032_users_active_workspace.sql` before running
the new API code:

```sql
ALTER TABLE users
  ADD COLUMN active_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
```

There is no backfill or new required value. Existing users keep null and their
existing selection rule. Deleting a workspace clears preferences referencing it.
The previous release ignores the additional nullable column, so code rollback
leaves the migration in place. No shipped migration changes.

The migration runner retains its session advisory lock and transactional file
execution. It sets `lock_timeout = '5s'` for the migration session and each file
transaction, without changing `statement_timeout`. A file raising PostgreSQL
`55P03` is rolled back and retried for up to five total attempts, with
250/500/750/1000 ms backoff; exhaustion names the file and asks the operator to
release the blocking transaction before rerunning. Other errors fail without
retry. All existing SQL files are transactional; none currently uses
`CREATE INDEX CONCURRENTLY` or other transaction-prohibited statements. Their
existing handling is unchanged; future non-transactional migrations need an
explicit execution design rather than being silently run in a transaction.

## Resolver audit

- `apps/api/src/app.ts`: normal session selection and recovered membership after
  either self-heal success or failure share the active-preference-aware query for
  header-free requests. A supplied workspace header selects the exact active membership's
  workspace and role. Header-free self-heal provisions the user's deterministic
  personal workspace, then validates the actual active membership rather than
  assuming ownership.
- `apps/api/src/auth.ts`: `provisionWorkspace` creates/reuses the deterministic
  personal workspace; it is provisioning, not active-workspace selection.
- `apps/api/src/scripts/affiliate-admin.ts`: owner-email lookup deliberately picks
  an owned workspace for founder-run commission management, preferring the
  created workspace and then the most recently joined active owner membership.
  A browser preference must not redirect commissions to an invited workspace.
- `apps/api/src/mcp-oauth.ts`: resolves a token's explicitly pinned workspace and
  validates its active membership; it must ignore the browser preference.
- Billing recipient lookup, core owner-verification and role helpers, affiliate
  attribution/payout queries, and team listing use an already selected workspace
  or ownership relationship; none selects a browser workspace from a session.
- MCP OAuth consent in `apps/web` explicitly selects a workspace and is untouched.

## Browser fetch audit

Direct fetches to the API carry `workspaceRequestHeaders()`:

- `apps/web/app/app/(product)/settings/danger/page.tsx`: CSV export at
  `${API_BASE_URL}/v1/export.csv`.
- `apps/web/components/api-health.tsx`: `${API_BASE_URL}/health`.
- `apps/web/components/affiliate-ref-capture.tsx`: public affiliate click at
  `/api/v1/public/affiliate/click`.
- `apps/web/components/guide-callout.tsx`: public guide signup at
  `/api/v1/guide-signup`.

`apps/web/lib/auth-client.ts` delegates `/v1/auth` requests to better-auth; these
public auth routes establish and inspect identity. The MCP settings page fetches
`/oauth/grants` and `/oauth/grants/:id/revoke` from Next.js route handlers, which
use session identity and explicit grant IDs. The DNS checker fetches external
DNS-over-HTTPS providers. These paths retain their existing authentication and
resource selection contracts.

## Validation

`apps/api/test/workspaces.integration.test.ts` covers null preferences, persistent
switching and tenant isolation, identical unauthorized/not-found errors, inactive
membership rejection, stale-preference fallback, deletion nullification, API-key
pinning and route denial, invite acceptance, committed-row email delivery, send
failures and disabled/missing dependencies, invitation caps/replacement/concurrency,
and invitation route rate limiting. `packages/core/test/operations.access.test.ts`
covers operation schemas/access, role-change role gates, and all shared MCP
administrative exclusions.
`packages/email/test/transactional.test.ts` covers escaped names, recipient email,
subject CR/LF removal and truncation, role copy, CTA order, and postal footers.

`apps/api/test/team-role-change.integration.test.ts` covers owner promotion and
demotion, role/owner/self gates, tenant isolation, inactive targets, invalid
inputs, updated timestamps, team listing, and valid API-key denial.
`apps/api/test/mcp.integration.test.ts` verifies the real shared exclusion set
against the registry's administrative operation families, checks `tools/list`
with both a valid API key and fully scoped OAuth token, and rejects direct
role-change tool calls. Removing an administrative entry from the production
set fails those assertions rather than silently shrinking the test's expected
exclusions. `apps/api/test/migration-runner.test.ts` covers bounded retries,
rollback, backoff, timeout SQL, success and unrelated failures;
`apps/api/test/migration-lock.integration.test.ts` uses an isolated temporary
schema and a live blocking table lock to verify a real five-second timeout and
successful retry. Migration tests live in the API's existing Vitest harness
because the database package has no test runner configured.

The workspace API suite also covers tab-pinned tenant reads and writes, current
workspace listing, membership roles and owner-only access, malformed/unrelated
headers, inactive/removed/deleted memberships, account changes, header-free
self-healing, CORS, API-key headers, and MCP OAuth pinning.
`apps/web/test/api-workspace.test.ts` exercises header merging, guarded storage,
reload coalescing, persisted reload-loop protection, successful-response reset,
and ordinary conflicts. `apps/web/test/workspace-switcher.test.ts` verifies the
source ordering of shell adoption, switching, invitation acceptance, sign-out,
authentication, and direct API headers. `apps/web/test/workspace-navigation.test.ts`
invokes switch and invitation handlers with mocked React hooks and fetch to
verify the stored workspace ID at navigation time.

For these backend follow-ups, sandbox validation is limited to `pnpm typecheck`;
web-only errors are outside this lane's ownership. No tests are executed here.
PostgreSQL is unreachable from the sandbox, so database suites and migration
application remain unverified here. The tab-header change uses the existing
nullable preference and membership schema, with the current migration and
backfill contract preserved.
Before release, apply migrations to the isolated test database and execute the
focused suites, full validation, and the auth smoke loop from
[regression guardrails](regression-guardrails.md). Browser/provider smoke checks
and real invite delivery require the dev environment; do not treat typecheck or
fake-service coverage as proof of those checks.
