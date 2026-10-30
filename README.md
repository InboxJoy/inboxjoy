# InboxJoy

Modern email sequencing for connected Gmail and Outlook mailboxes.

## Local setup

Requirements: Node.js 22+, pnpm 11+, and PostgreSQL 16+.

```bash
cp .env.example .env
pnpm install
createdb inboxjoy
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. The API runs on http://localhost:4000 and the worker health endpoint on http://localhost:4001.

If PostgreSQL is not installed locally, use `docker compose up -d postgres`.

## Self-hosting

Run your own InboxJoy on any 2 GB Linux server with Docker, with HTTPS, backups
and one-command upgrades:

```bash
curl -fsSL https://raw.githubusercontent.com/inboxjoy/inboxjoy/main/deploy/install.sh | sudo sh
```

See [the self-hosting guide](docs/self-hosting/README.md).

## Commands

```bash
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm db:generate
pnpm db:migrate
```

## Documentation

- [Documentation index](docs/README.md)
- [Current architecture](architecture.md)
- [Regression guardrails](docs/regression-guardrails.md)
- [Campaign regression matrix](docs/campaign-regression-matrix.md)
- [Safe feature plan (proposed)](docs/feature-plan.md)

- [API reference](docs/api.md)
- [Data model](docs/data-model.md)
- [Developer guide](docs/development.md)

Architecture and guardrails track verified behavior. The original specification
is historical; the feature plan and backlog describe proposed work. Known gaps
are called out explicitly instead of being presented as shipped features.
