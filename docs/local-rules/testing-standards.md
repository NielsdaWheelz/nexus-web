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
<<<<<<< HEAD
4. css-token lint, freshness of the generated wire types and browser tool contract
   ([typed-wire.md](typed-wire.md)), eslint, and typescript checking for the
   web app; and
5. structural alembic checks: exactly one canonical head, and no migration
   importing the `nexus` application.
||||||| f658f2548
4. css-token lint, freshness of the generated wire types and browser tool contract
   ([typed-wire.md](typed-wire.md)), eslint, and typescript checking for the
   web app; and
5. a structural alembic check requiring exactly one canonical head.
=======
4. css-token lint, freshness of the generated wire types, browser tool contract
   ([typed-wire.md](typed-wire.md)) and shared citation-parser bundle, eslint, and
   typescript checking for the web app; and
5. a structural alembic check requiring exactly one canonical head.
>>>>>>> origin/main

keep this a fixed, explicit shell sequence. checks must be deterministic,
unprivileged, network-independent after locked dependency installation, and
cheap enough to target two minutes on the self-hosted devbox. do not add
selectors, orchestration, receipts, coverage targets, or a second gate.

`.github/workflows/ci.yml` installs locked dependencies and runs this command
for pull requests on the self-hosted linux x64 devbox. it has read-only
repository permission, a five-minute timeout, and cancels obsolete runs. public
source dependencies are fetched at their locked revisions without credentials.
the check step receives no secret and uses no application services, browsers,
devices or production systems.

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

## disposable verification

`./scripts/lab -- COMMAND [ARG ...]` creates a fresh real local application,
passes an absolute private `NEXUS_LAB_CONTEXT` json path to the driver, and removes
its owned services and data afterward. it requires a dedicated checkout with
installed locked dependencies and chromium; no dotenv files, ordinary web server,
static gate or application edits during an invocation. see `./scripts/lab --help`.
each invocation builds the canonical web production package once, including its
public assets, then serves its standalone entry without hot reload. build and
server use the same closed environment, exact loopback origin and source sha;
this adds one production build per run. readiness establishes service health and
identity; the driver owns assertions and deadlines. exit zero alone proves only
what that driver actually checked.

write temporary integration/live cases for the intended behavior, observe red,
implement at the owning layer, reach green, review adversarially, refactor and
rerun affected checks. keep cases until final qualification, then delete them.
commit composition, provisioning, seed, browser helpers and contracts; retain no
scenario suite, fixture corpus or test-only product seams. playwright cases live
in ignored `apps/web/.nexus-lab/cases/`. caller files survive runtime teardown;
the author deletes them. logs and failure artifacts remain private and local.

`--live-config FILE` explicitly supplies allowed provider settings to api/workers;
core inherits no ambient provider configuration. credential propagation does not
prove a successful model journey. temporary drivers run separately from the static
gate; CI starts no services or browsers.

## retained foundation

keep the reusable runtime and static gate. scenario cases and their fixtures are
temporary: delete them after final qualification. retain no regression suite,
coverage target or test-only application seam.

historical test commands and proof checklists describe their original change;
they do not revive retired work. actual product defects and unresolved manual
verification concerns remain tracked in `docs/issues/`.
