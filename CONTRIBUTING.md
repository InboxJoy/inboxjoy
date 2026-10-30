# Contributing to InboxJoy

Thanks for helping. InboxJoy sends real email for real people, so we are
careful about changes that touch sending, billing and tenant isolation. This
guide keeps that bar clear and the process short.

- Questions and ideas: use GitHub Discussions.
- Bugs and feature requests: open an issue using the templates.
- Security problems: do **not** open an issue. Follow [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

For anything larger than a small fix, open an issue first so we can agree on
the approach before you spend time on it.

## Set up your machine

You need Node.js 22 or newer, pnpm 11 and Docker (for PostgreSQL).

```bash
git clone https://github.com/inboxjoy/inboxjoy.git
cd inboxjoy
cp .env.example .env
pnpm install
docker compose up -d postgres
```

Edit `.env`:

- `DATABASE_URL=postgresql://inboxjoy:inboxjoy_dev_password@localhost:5432/inboxjoy?sslmode=disable`
  (the user and password come from `docker-compose.yml`).
- `AUTH_SECRET` and `BETTER_AUTH_SECRET`: any random string of 32 or more
  characters, for example the output of `openssl rand -hex 32`.

Then apply migrations and start everything:

```bash
pnpm db:migrate
pnpm dev
```

The web app is on http://localhost:3000, the API on http://localhost:4000 and
the worker health endpoint on http://localhost:4001. Leave the provider and AI
settings in `.env` empty for local work: connecting mailboxes, sending and AI
drafting stay disabled, which is safe. Never commit real credentials.

More detail is in [docs/development.md](docs/development.md).

## Run the checks

Use a separate database for tests so they never touch your dev data:

```bash
docker compose exec postgres createdb -U inboxjoy inboxjoy_test
export DATABASE_URL="postgresql://inboxjoy:inboxjoy_dev_password@localhost:5432/inboxjoy_test?sslmode=disable"
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm build
```

Run the focused tests for the package you changed first, for example
`pnpm --filter @inboxjoy/api test`, then the full set above before you open a
pull request. Database suites need `DATABASE_URL` pointing at an isolated,
migrated database. A skipped database suite is not a passing result. Never run
tests against a database that holds real data.

Pull requests run the same steps on GitHub Actions. They must be green to merge.

## Where things live

- `apps/web`: Next.js user interface
- `apps/api`: Fastify HTTP API
- `apps/worker`: queued jobs, scheduling and delivery safeguards
- `packages/`: database schema and migrations, domain rules, queue, email,
  SMTP, integrations, configuration and shared UI

Read these before you change the area they cover:

- [architecture.md](architecture.md) and
  [docs/regression-guardrails.md](docs/regression-guardrails.md): required
  before touching authentication, billing or entitlements, send gating, or
  anything campaigns depend on. They list the failures that have already
  shipped once and the guardrail for each.
- [docs/campaign-regression-matrix.md](docs/campaign-regression-matrix.md):
  which tests protect which campaign behavior.
- [DESIGN.md](DESIGN.md): required before any UI change. Reuse its tokens and
  patterns; if you add a pattern, document it there in the same pull request.

## Code style

- Strict TypeScript, two-space indentation, semicolons, double quotes.
- `camelCase` for variables and functions, `PascalCase` for components and
  types, kebab-case file names such as `send-message.ts`.
- Prefer named exports and explicit types at module boundaries.
- There is no formatter or linter. Follow the code around yours and make sure
  `pnpm typecheck` passes.
- Add tests next to the code. Name unit tests `*.test.ts` and database tests
  `*.integration.test.ts`. A bug fix needs a regression test, especially for
  tenant isolation, sending safety and failure paths.
- Never edit a migration that has shipped. Add the next numbered file under
  `packages/db/migrations/` and review generated SQL before applying it.
- Keep provider and AI keys server-side. Do not log secrets or message bodies.

## Commits and pull requests

Use a short, imperative message with one of these prefixes:

`feat:` `fix:` `polish:` `copy:` `a11y:` `docs:` `chore:` `refactor:` `test:`

Example: `fix: stop sending to contacts who replied from another address`.

In the pull request description:

- Explain the user impact in a sentence or two.
- List how you validated it (commands run, tests added, screenshots for UI
  changes).
- Link the issue it closes.
- Flag migrations, new environment variables and rollout risks.

Keep pull requests small and focused. One logical change per pull request is
much easier to review and to revert.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign the
[Contributor License Agreement](.github/CLA.md). It is a one-time step:

1. Open a pull request.
2. A bot comments with the agreement and a link.
3. Reply on the pull request with exactly:
   `I have read the CLA Document and I hereby sign the CLA`

The agreement lets you keep the copyright in your work while giving the
maintainers the right to distribute it under the AGPL-3.0 and, if the project
ever needs it, under other licences (for example a commercial licence for
organisations that cannot use the AGPL). If you contribute on behalf of an
employer, make sure you are allowed to.

## Licence of contributions

By contributing you agree that your contribution is licensed under the
[AGPL-3.0](LICENSE) and covered by the CLA above. The InboxJoy name and logo
are trademarks and are not licensed through contributions; see
[TRADEMARK.md](TRADEMARK.md).

## Using AI tools

You are welcome to use AI assistants. You remain responsible for the change:
read it, run it, and make sure it passes the checks. Do not paste secrets or
customer data into any tool, and say in the pull request if a large part was
generated.
