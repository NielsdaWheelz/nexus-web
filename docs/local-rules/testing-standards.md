# verification

this is the authoritative repository-local verification contract. it overrides
conflicting test requirements in shared rules, older cutover plans, and module
docs. the 2026-09-17 reset removes every automated test and its supporting
fixtures, harnesses, dependencies, and test-only production seams. there is no
survivor suite or obligation to reconstruct one. synthetic deployment auth
smoke and capacity canaries are removed too; runtime health, readiness,
identity, resource limits, and migration backup checks remain deployment
invariants.

## automated checks

`./scripts/test` is the sole automated verification command. it takes no
arguments and runs from any directory in the checkout. its name is retained,
but it runs static checks only:

1. `actionlint` over tracked workflows and `shellcheck` over tracked shell;
2. ruff formatting and linting over python owners;
3. pyright over the whole `nexus` package and explicit runtime entrypoints;
4. css-token lint, eslint, and typescript checking for the web app; and
5. a structural alembic check requiring exactly one canonical head.

keep this a fixed, explicit shell sequence. checks must be deterministic,
unprivileged, network-independent after locked dependency installation, and
cheap enough to target two minutes on the self-hosted devbox. do not add
selectors, orchestration, receipts, coverage targets, or a second gate.

`.github/workflows/ci.yml` installs locked dependencies and runs this command
for pull requests on the self-hosted linux x64 devbox. it has read-only
repository permission, a five-minute timeout, and cancels obsolete runs. it
uses no secrets, application services, browsers, devices, or production systems.

passing establishes static consistency, not working user journeys or migration
safety. production migration safety remains owned by the deployment controller:
ancestry preflight, stopped writers, a verified backup or explicit durable
operator waiver when migration is pending, and exact-head verification.

## manual verification

manually check affected behavior when the change warrants it. choose checks
from the concrete failure risk and recovery cost; pay particular attention to
durable data, destructive operations, authorization, and cross-process behavior.
record what was actually observed and any material limits. a documentation or
test-deletion change does not require replaying unrelated product journeys.

## future tests

new automated tests require a concrete justification: what failure matters,
why ordinary use or static checking would miss it, and why maintaining the test
costs less than finding and repairing that failure. keep any justified test and
its setup at the smallest useful boundary. there is no coverage quota, default
regression-test obligation, or mandate to rebuild the deleted infrastructure.

historical test commands and proof checklists describe their original change;
they do not revive retired work. actual product defects and unresolved manual
verification concerns remain tracked in `docs/tickets/`.
