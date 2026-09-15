# Nexus Testing Standards

This file is the authoritative repository-local testing contract. Shared
standards in `docs/rules/` still apply where they do not conflict with this
deliberately smaller Nexus contract.

## One command

`./scripts/test` is the only supported test and verification command. It takes
no arguments. Run it from any directory in the checkout. A zero exit status is
the complete local and pull-request verdict.

Do not add modes, selectors, planners, registries, policies, receipts, replay,
fault injection, sensitivity runs, service orchestration, browser orchestration,
scheduled suites, optional suites, or release suites. Do not invoke individual
test tools as a substitute verdict.

The command must remain explicit shell with a fixed sequence. A check belongs
there only when it is deterministic, unprivileged, network-independent after
locked dependency installation, and cheap enough for the complete command to
target two minutes on the self-hosted devbox.

## Fixed check

The command runs, in order:

1. `actionlint` over tracked workflows and `shellcheck` over tracked shell;
2. Ruff formatting and linting over Python owners;
3. Pyright over the configured backend and explicit runtime entrypoints;
4. CSS-token lint, ESLint, and TypeScript checking for the web app;
5. fast deterministic Python kernel tests that require no privileged host
   mutation;
6. fast deterministic Node-environment Vitest and ingest parser unit tests; and
7. a structural Alembic check that requires exactly one canonical head.

The migration check proves graph shape only. Production migration safety remains
owned by the deployment controller: ancestry preflight, stopped writers, a
verified backup when migration is pending, and exact-head verification.

## Pull requests

`.github/workflows/ci.yml` is the sole pull-request workflow. It installs locked
Python, web, and ingest dependencies, then runs `./scripts/test` on the self-hosted Linux
x64 devbox. The job has a hard five-minute timeout and cancels an obsolete run
when the same pull request receives a newer commit.

The workflow has read-only repository permission. It must not use secrets,
hosted providers, Docker, databases, browsers, emulators, physical devices,
production systems, deployment credentials, or mutable shared test services.

## Test shape

Prefer pure functions and narrow public contracts. Tests may use small explicit
fakes for process and provider boundaries. They must not depend on order,
randomness, wall-clock timing, the external network, ambient credentials, or
state left by another test.

Keep fixtures local and legible. A regression test should name the behavior it
protects and fail for the defect it accompanies. Do not add meta-tests that test
the test suite, workflow policy, or repository policy.

## Deliberate exclusions

Browser/component automation, end-to-end journeys, real-service integration,
hosted canaries, randomized/property audits, Android device automation, and
release certification are not part of this repository's automated portfolio.
Do not retain test sources, fixtures, dependencies, or commands for those
excluded tiers. Validate their boundaries manually when a change materially
touches them.

This is a conscious confidence tradeoff for a one-user prototype: PR feedback is
fast and bounded, while cross-process, browser, provider, and device regressions
can escape the automated check. Do not obscure that tradeoff by recreating a
second gate under another name.
