# Documentation map

Current-code review: 2026-10-03, `main` at `5a2b589`.

## Before changing the app

1. [Architecture](../architecture.md) — implemented runtime, delivery pipeline, lifecycle and extension boundaries.
2. [Regression guardrails](regression-guardrails.md) — failure classes and contracts to preserve.
3. [Campaign regression matrix](campaign-regression-matrix.md) — select checks for the behavior being changed.
4. [Safe feature plan](feature-plan.md) — proposed delivery-advisor stages and later feature order.
   [Delivery advisor implementation plan](delivery-advisor-plan.md) defines the
   proposed first-release scope, read contract, implementation order and gates.
5. [Design system](../DESIGN.md) — required before UI changes.

## Supporting references

- [API](api.md) — public routes and supported contracts.
- [Data model](data-model.md) — schema, relationships and campaign state.
- [Self-hosting](self-hosting/README.md) — install, configure, upgrade and back up the open-source edition.
- [Workspace export and import](workspace-transfer.md) — the portable workspace file and moving between Cloud and self-hosted.
- [Development](development.md) — VM/test workflow and scripts.

## Evidence and maintenance

Check code and migrations before treating a design proposal's scope or exclusions as implemented behavior. An architecture snapshot is verified only at its recorded commit; new changes must update affected contracts and linked tests in the same PR.

Keep one guardrails document. Add new regression classes to the existing file and connect them to real coverage in the matrix. Plans and future acceptance tests must remain labelled as proposed until implemented.
