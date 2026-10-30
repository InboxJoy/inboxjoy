# Repository Guidelines

These guidelines are for contributors, human or AI-assisted. [CONTRIBUTING.md](CONTRIBUTING.md) has the full contribution process, including the CLA.

## Project Structure & Module Organization

InboxJoy is a pnpm TypeScript monorepo. `apps/web` contains the Next.js UI, `apps/api` the Fastify API, and `apps/worker` queued delivery jobs. Reusable database, domain, queue, email, integration, configuration, and UI code lives in `packages/`. Tests sit beside modules or in workspace `test/` directories. Assets are in `apps/web/public`; documentation is under `docs/`.

## Setup

Requires Node 22+, pnpm 11 and Docker.

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Set `DATABASE_URL` in `.env` to the Compose database (`postgresql://inboxjoy:inboxjoy_dev_password@localhost:5432/inboxjoy?sslmode=disable`) and `AUTH_SECRET` to a random string of 32 or more characters. Leave provider and AI settings empty for local work. Details are in `docs/development.md`.

## Build, Test, and Development Commands

- `pnpm install` installs workspace dependencies.
- `pnpm db:migrate` applies database migrations.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` run full validation.
- `pnpm --filter @inboxjoy/api test` tests one workspace.
- `pnpm dev` runs web, API and worker together.

Pull requests run the same install, migrate, typecheck, test and build steps on GitHub Actions; they must be green to merge.

## Safe Changes

Read `architecture.md` and `docs/regression-guardrails.md` before touching authentication, billing or entitlements, send gating, or anything campaigns depend on; they list the regression classes that have already shipped and the guardrail for each. Read `docs/campaign-regression-matrix.md` before changing campaign dependencies. Preserve audience eligibility, automatic list enrollment, sequence versions, sender pinning, lifecycle, reply stopping and send idempotency.

Run database suites against an isolated test database with migrations applied; skipped database suites are not a regression pass. Run focused checks first, then `pnpm typecheck`, `pnpm test`, and `pnpm build`. For documentation-only changes, verify links and source references. Report any visual or provider smoke checks you did not perform.

Before building or changing any UI, read `DESIGN.md`: it is the design system of record (tokens, sidebar rail, pill tabs, cards, tables, modals, voice, responsive rules). Reuse its tokens and patterns instead of inventing new ones; if you add a pattern, document it there in the same change.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and double quotes. Use `camelCase` for variables and functions, `PascalCase` for components and types, and kebab-case filenames such as `send-message.ts`. Prefer named exports and explicit boundary types. No formatter or linter is configured; follow nearby code and run `pnpm typecheck`.

## Testing Guidelines

Vitest is the test runner. Name unit tests `*.test.ts` and service or database tests `*.integration.test.ts`. Add regression coverage for fixes, especially tenant isolation, sending safety, and failure paths. Run the affected workspace first, then `pnpm test`.

## Commit & Pull Request Guidelines

Use short, imperative prefixes such as `feat:`, `fix:`, `polish:`, `copy:`, `a11y:`, `docs:`, and `chore:`. Pull requests should explain user impact, list validation, link issues, and include UI screenshots. Flag migrations, environment changes, and rollout risks. Keep each pull request to one logical change.

## Security & Configuration

Never commit credentials; keep provider and AI keys server-side. Review generated SQL and never edit shipped migrations; add the next numbered file instead. Report vulnerabilities privately as described in `SECURITY.md`, never in a public issue.

## Trademark

The InboxJoy name and logo are trademarks and are not covered by the AGPL. See `TRADEMARK.md` before you publish a fork.
