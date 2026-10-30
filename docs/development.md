# InboxJoy development

Before campaign-related changes, read [architecture](../architecture.md),
[regression guardrails](regression-guardrails.md) and the
[campaign regression matrix](campaign-regression-matrix.md). Planned feature
stages are in [feature-plan.md](feature-plan.md).

## Prerequisites

- Node.js 22 or newer
- pnpm 11 (`corepack enable` can provide pnpm)
- Docker, for local PostgreSQL

Install dependencies from the repository root:

```sh
pnpm install
```

## Local setup

Copy `.env.example` to `.env`. Keep real credentials out of git. Start PostgreSQL with:

```sh
docker compose up -d postgres
```

The Compose database uses the `inboxjoy` user and `inboxjoy_dev_password` password. Set `DATABASE_URL` in `.env` to match that database. `AUTH_SECRET` must be at least 32 characters for the API and worker.

Apply migrations before starting services:

```sh
pnpm db:migrate
```

## Environment

Required by the API: `DATABASE_URL`, `API_BASE_URL`, `WEB_BASE_URL`, `API_HOST`, `API_PORT`, and `NODE_ENV`.

Required by the worker: `DATABASE_URL`, `API_BASE_URL`, `AUTH_SECRET`, `WORKER_HEALTH_PORT`, and `NODE_ENV`.

Optional integration settings include `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET`, `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID`, `COMPOSIO_TOOLKIT_VERSION`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_COMMUNICATION_EMAIL_ENDPOINT`, `AZURE_COMMUNICATION_EMAIL_SENDER`, `AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS`, and `AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID`. Leave integration settings empty for safe local development; provider connections, transactional email, sends, and AI sequence drafting remain disabled.

## Run services

Run everything together:

```sh
pnpm dev
```

Or run individual services:

```sh
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

The web app uses port 3000, the API 4000, and worker health checks 4001 by default.

## Checks and tests

```sh
pnpm typecheck
pnpm build
pnpm test
```

Package-specific checks use the same scripts, for example `pnpm --filter @inboxjoy/worker test` or `pnpm --filter @inboxjoy/api typecheck`.

DB suites require `DATABASE_URL` pointing to an isolated test database with
migrations applied. Skipping them is not a campaign regression pass. Never run
regression fixtures against production or the dev stack's customer-like data.
Report actual test counts and any skipped checks.

## Workspace layout

- `apps/web` — Next.js user interface
- `apps/api` — Fastify HTTP API
- `apps/worker` — pg-boss workers, scheduling, and delivery safeguards
- `packages/db` — Drizzle schema and PostgreSQL migrations
- `packages/composio` — server-side Composio client
- `packages/email` — unsubscribe token and footer helpers
- `packages/domain` — state rules
- `packages/queue` — queue names and payload validation
- `packages/ui` — shared React components

## Database changes

Update `packages/db/src/schema.ts`, then generate a migration when the change is schema-derived:

```sh
pnpm db:generate
```

For carefully controlled SQL, add the next numbered file under `packages/db/migrations/`. Migrations run in filename order and are recorded in `inboxjoy_schema_migrations`. Review generated SQL before applying it with `pnpm db:migrate`.

## Safe local Composio behavior

Provider keys stay server-side in `.env` or deployment secrets. Without `COMPOSIO_API_KEY`, the API rejects mailbox connection attempts and the worker refuses to send. Never place provider keys in browser code, committed files, or documentation.
