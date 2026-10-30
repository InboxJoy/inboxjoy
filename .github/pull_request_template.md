## What and why

<!-- User impact in a sentence or two. Link the issue: "Closes #123". -->

## How I validated it

<!-- Commands run and results, for example:
- pnpm --filter @inboxjoy/api test
- pnpm typecheck && pnpm test && pnpm build
Database suites run against an isolated, migrated test database (skipped suites are not a pass).
Add screenshots for UI changes. -->

## Risk

- [ ] No migration, or the migration is a new numbered file (shipped migrations are never edited)
- [ ] No new environment variables, or they are in `.env.example` and the docs
- [ ] Touches auth, billing/entitlements, send gating or campaign behavior, and I read
      `docs/regression-guardrails.md` and added regression tests
- [ ] UI change follows `DESIGN.md`

## Checklist

- [ ] I signed the CLA (the bot will comment if I have not)
- [ ] Commit messages use a prefix such as `feat:`, `fix:`, `docs:` or `chore:`
- [ ] No secrets, tokens or customer data in the diff, logs or screenshots
