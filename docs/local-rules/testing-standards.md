# Nexus Testing Standards

This is the permanent, authoritative, repository-local testing contract for
Nexus. It applies to every new or modified test, fixture, helper, test
dependency, CI gate, evaluation, synthetic, and release check.

This document is intentionally Nexus-specific and self-contained. It belongs in
`docs/local-rules/`; it MUST NOT be moved into or replaced by the shared
`docs/rules/` subtree. Shared testing doctrine may complement this document, but
this document owns Nexus commands, fixtures, runtimes, risk priorities, current
exceptions, and migration policy. If generic doctrine conflicts with a
Nexus-specific rule here, this document controls Nexus.

Existing tests are legacy evidence, not precedent. Existing harness behavior is
authoritative only where this document explicitly records it as the current
executable contract.

**MUST** and **MUST NOT** are requirements. **SHOULD** and **SHOULD NOT** require
a concrete reason to override.

## 1. Definitions

- A **proof** is executable or static evidence for a named risk, invariant,
  regression, or production contract.
- A **scenario** is one executable proof of one coherent risk or invariant,
  regardless of how many assertions, parameters, or generated examples it has.
- An **oracle** is the independent source that decides what correct behavior is.
- **Sensitivity** means the proof has been observed failing when the claimed
  fault is present.
- A **kernel proof** exercises pure or tightly bounded semantic behavior.
- A **service/component proof** exercises multiple real owned collaborators
  through a public boundary. It may run in one process.
- A **journey** exercises production-shaped wiring across browser, process, auth,
  database, worker, or storage boundaries.
- A **fake** is an owned working implementation of an external boundary.
- A **stub** supplies a narrow predetermined response.
- A **mock** verifies interactions such as calls, arguments, count, or order.
- **Priority-risk proof** protects data integrity, privacy/auth, money,
  destructive effects, recovery, provenance, or durable-work correctness.
- **Real-stack** means the applicable production implementation runs with real
  Nexus processes and real local infrastructure. It does not imply hosted
  providers, deployment, a physical device, or production.

## 2. Objective and philosophy

Optimize for confidence per developer minute, machine GB-minute, and maintenance
hour. Never optimize for test count, coverage percentage, snapshot volume,
assertion count, or the appearance of exhaustiveness.

For each material failure mode, use the smallest deterministic proof whose
boundary and oracle can genuinely observe it. Add broader proof only where a
narrower proof cannot preserve the database, browser, process, provider,
deployment, recovery, or production behavior at risk.

Nexus is outcome-heavy, not E2E-heavy:

1. comprehensive static and preventive proof;
2. a small kernel of pure, property, and state-machine proof;
3. a dominant middle of service and browser-component proof using real Nexus
   code, real PostgreSQL, and real Chromium semantics;
4. very few complete journeys;
5. scheduled provider, device, recovery, fuzz, and semantic evaluation;
6. explicit deployment and production verification.

“Dominant middle” describes confidence and maintenance investment, not a
test-count quota. Pyramid, trophy, and honeycomb diagrams are heuristics, not
required ratios.

Prefer eliminating failure modes architecturally:

- types and exhaustive state handling;
- generated and validated boundary schemas;
- explicit state machines;
- idempotent operations;
- transactional ownership and durable checkpoints;
- narrow provider boundaries;
- reconciliation and observable invariants;
- backup, restore, and rollback.

Test what remains uncertain.

## 3. Agent-authored proof and falsifiability

Tests are part of the reward function for coding agents. A suite that can be made
green by weakening assertions, mocking the implementation, skipping work,
sleeping longer, copying current output, or deleting inconvenient proof rewards
incorrect behavior.

An agent MUST optimize for the product contract, not for a green command.

### Oracle independence

- Expected behavior MUST come from product requirements, architecture,
  user-visible behavior, independently reviewed fixtures, mathematical
  properties, protocol specifications, or known production facts.
- Do not derive expected output by running the current implementation and
  snapshotting or copying what it returns.
- The same implementation path MUST NOT serve as both producer and oracle.
- Generated-content evaluation MUST use a stored independently reviewed
  baseline or rubric, not self-comparison.
- When the same agent writes implementation and proof, sensitivity evidence is
  required at the level defined below.

### Sensitivity requirements

| Change | Required evidence |
|---|---|
| Defect fix | The regression proof fails against the unfixed defect, reverted fix, or equivalent injected fault, then passes with the fix |
| Replacement for priority-risk legacy proof | The replacement fails under a representative known or injected fault before the legacy proof may be deleted or made non-blocking |
| New critical behavior | Observe red before implementation when practical; otherwise demonstrate failure under a controlled wrong result or fault |
| Ordinary new behavior | Use an independent oracle and demonstrate sensitivity when the proof could plausibly pass vacuously |
| Critical pure kernel | Targeted changed-code mutation MAY audit oracle strength |

A test passing on its first authored run is not evidence of sensitivity.

Sensitivity evidence MAY be a captured pre-fix run, a run against the parent
revision, a temporary local fault that is removed before commit, a deterministic
fault injector, or a targeted mutant. Do not commit deliberate production
defects merely to preserve the demonstration.

The final work report for a defect or replacement MUST state how sensitivity was
demonstrated. “Test passes” is insufficient.

### Reward-hacking prohibitions

An implementation task does not authorize an agent to:

- delete, skip, quarantine, weaken, or rewrite existing proof merely to become
  green;
- replace behavioral assertions with existence, status-only, or call-count
  assertions;
- mock the code responsible for the behavior under test;
- widen timeouts or add retries without proving a timing contract;
- update snapshots or golden artifacts without independently reviewing the
  semantic change;
- change fixtures so the failing case no longer occurs;
- claim a higher evidence level than was actually run.

Changing or deleting proof is allowed when the supported product contract
changes or replacement proof is stronger. The change MUST say which contract
changed or which demonstrated-sensitive proof supersedes it.

## 4. Nexus risk priorities

Nexus is a one-user product. Brief UI downtime is less consequential than
irreversible harm. Protect these first:

- data loss, corruption, and unverified recovery;
- privacy, authorization, token, share, credential, or secret leakage;
- destructive cleanup and irreversible side effects;
- migration failure and schema/data incompatibility;
- duplicate billing, provider dispatch, or other costly effects;
- lost or incorrectly persisted reading progress;
- broken citations, provenance, locators, or source identity;
- durable-job loss, duplication, stuck work, retry, cancellation, or replay
  failure;
- PostgreSQL/object-store divergence;
- tool-bearing LLM prompt injection or unauthorized side effects;
- signed native release and authentication handoff.

Every proof MUST name a current risk, invariant, regression, or production
contract. The mapping must be obvious from its name/module or one concise
adjacent comment. “Increases coverage” is not a reason.

For a changed behavior, assess:

- consequence: 0–4;
- runtime/provider/device boundaries crossed: 0–3;
- concurrency, replay, or irreversibility: 0–3;
- change frequency and escape history: 0–2.

Interpretation:

- **9–12, critical:** closest-seam proof, applicable real dependency,
  demonstrated fault sensitivity, enclosing journey where cross-boundary
  behavior matters, and release/production evidence;
- **6–8, high:** kernel/contract proof plus real database, process, or browser
  behavior;
- **3–5, medium:** service/component proof;
- **0–2, low:** static or pure proof.

Auth, secrets, money, destructive mutation, anonymous sharing, migration,
recovery, and signed releases are critical regardless of arithmetic.

## 5. Choose the proof boundary

| Behavior or failure | Primary proof |
|---|---|
| Type, import, registry, schema, config, or architecture rule | Type checker, linter, AST/schema check, or build |
| Pure deterministic rule | Focused example; property test when a general law exists |
| Retry, replay, cancellation, navigation, or lifecycle sequence | State-machine/model proof |
| Several in-process modules | Sociable component/service proof |
| SQL, transaction, lock, storage-shape constraint, migration, pgvector, query plan, or notification | Real PostgreSQL integration |
| Durable-job idempotency, claim, lease, or replay | Real PostgreSQL plus the real worker boundary; pure model proof may supplement |
| PostgreSQL/object-store ordering | Real PostgreSQL plus MinIO |
| UI layout, selection, focus, accessibility, PDF, editor, audio, browser storage, or SSE rendering | Real Chromium component proof |
| Independently released consumer/provider | Contract/conformance proof |
| Browser/server/auth/configuration/process wiring | Thin real-stack journey |
| Untrusted parser or grammar | Property proof and, where justified, fuzzing |
| Hosted credential, quota, routing, signing, or wire compatibility | Scheduled hosted canary |
| Generated-content quality | Versioned evaluation set and explicit rubric |
| Production configuration/dependency reality | Post-deploy synthetic and telemetry |

A broader proof MUST NOT repeat edge cases already proved at a narrower reliable
boundary. Journeys prove wiring and cross-boundary behavior; they do not
enumerate business logic.

## 6. Authoring rules

### Test behavior, not implementation

- Assert returned behavior, persisted state, durable work, emitted protocol, or
  user-visible output.
- Do not assert private methods, internal call choreography, CSS classes, hook
  implementation, or incidental framework structure.
- A behavior-preserving refactor SHOULD NOT require rewriting its proof.
- Prefer static proof to runtime tests when the property is mechanically
  decidable.
- Do not test language, framework, ORM, React, browser, or third-party-library
  behavior unless Nexus deliberately depends on an undocumented behavior being
  characterized.
- Remove completed-cutover source greps instead of preserving tombstone tests.

### Database rules

Use database constraints only for storage-owned shape:

- nullability;
- primary-key identity;
- foreign-key reachability;
- true schema-owned uniqueness;
- the narrow append-only event-type exception owned by
  `docs/rules/database.md`.

Business, permission, lifecycle, tagged-union, conditional-nullability, and
cross-column invariants remain in application code plus executable defects. Do
not introduce `CHECK`, exclusion, trigger, or other database business-invariant
machinery contrary to `docs/rules/database.md`.

Use real production PostgreSQL and required extensions for transactions,
isolation, locks, constraints, raw SQL, pgvector, migrations, query plans,
`LISTEN/NOTIFY`, and commit-time behavior. SQLite, mocked SQLAlchemy sessions,
and emulated dialect behavior are not substitutes.

Test-data factories SHOULD construct ORM-backed application records or call the
owning service. Raw SQL is reserved for migration/schema proof, harness
baselines, raw-SQL-owned tables, or deliberately unreachable states.

### Test doubles

The policy is **no casual interaction mocks**, not “zero doubles.”

Use this preference order:

1. the real, fast, deterministic implementation;
2. an owner-maintained fake checked by the same conformance cases as the real
   adapter;
3. a narrow stub for an uncontrollable external response or failure;
4. an interaction mock only when call count, order, or absence is itself the
   product contract.

Do not mock:

- fast Nexus collaborators merely to isolate a class;
- SQLAlchemy sessions or PostgreSQL behavior;
- React hooks, state stores, route modules, or service modules into an imitation
  of Nexus;
- the exact implementation path whose behavior is being asserted.

Controlled clocks, randomness, UUIDs, network faults, provider responses, and
process failures are allowed when they make consequential behavior reproducible.

### Browser components, the BFF, and SSE

A Vitest browser-component proof MAY stub the Nexus BFF at the `fetch`/HTTP
boundary when the declared system under test is the UI. This is a protocol stub,
not permission to mock owned UI behavior.

Requirements:

- Stub `fetch` or the network boundary, not an imported hook, store, route,
  service client, or component collaborator.
- Use schema-valid shared response fixtures with status, headers, and error
  shape where relevant.
- Assert UI behavior and resulting user-visible state, not fetch call count,
  unless duplicate/absent dispatch is the product contract.
- Prove the real endpoint independently through FastAPI/BFF service or process
  proof.
- Keep at least one real-stack journey for critical BFF/auth/configuration
  wiring.

For SSE component behavior, use real `ReadableStream`/decoder/event protocol
fixtures covering frames, disconnect, replay, malformed events, and terminal
state. Do not mock the consuming hook. At least one journey must prove the real
browser → BFF/direct-SSE → FastAPI → worker path where the product uses it.

`apps/web/src/__tests__/helpers/fetch.ts` is the current shared fetch-boundary
helper. It is not blanket approval of every existing helper or test. New
clean-sheet browser helpers MUST converge on a small owned testkit rather than
copying legacy local mocks.

### Isolation and fixture shape

- Reuse service processes; never reuse writable test state.
- Proof MUST NOT depend on execution order or mutations left by another test.
- Isolate users, libraries, object prefixes, files, ports, queues, and browser
  state wherever writes can escape.
- Use small named fixtures and readable scenario data. Prefer DAMP setup over a
  helper DSL or giant mutable seed that hides behavior.
- Direct database construction is allowed for an immutable baseline or otherwise
  unreachable state; independently verify the builder against owner behavior.
- Randomize order periodically and repeat concurrency-sensitive proof under
  controlled scheduling where useful.
- Never use unbounded sleeps. Wait for an observable condition with a bounded
  deadline.
- A scenario may assert multiple steps of one invariant. Do not fragment a
  coherent workflow to increase test count.

### Names and assertion diagnostics

- Name the trigger, observable behavior, and material condition. Reject
  `test_works`, `handles_error`, numbered acceptance criteria without behavior,
  and names that merely repeat a function name.
- Parameter IDs MUST make a failing case identifiable.
- Keep the meaningful setup, action, and expected outcome visible in the test.
- Shared helpers may remove plumbing; they MUST NOT contain the scenario’s
  decision logic or oracle.
- For indirect service, worker, migration, browser, and journey failures,
  assertion output MUST include the relevant resource identity, input/case,
  expected state, actual or last observed state, and boundary being proved.
- A message that merely restates `expected true` is not diagnostic.

### Flakes

- A pass on retry is flaky, not green.
- Retry at most once to classify and collect richer artifacts.
- Never use silent retry, indefinite skip, or timeout inflation.
- Fix, replace, or delete a flake according to its unique risk signal.
- Temporary quarantine requires a reason, expiry, and replacement proof for any
  priority risk. Solo ownership is implicit.

## 7. Portfolio and budgets

Static proof is comprehensive. The majority of authored behavioral confidence
and maintenance belongs to real service and Chromium component proof. The
kernel remains small and semantically dense. Complete journeys remain capped at
approximately 10–15. Native-shell proof remains approximately 5 focused
scenarios unless the supported native surface expands.

There is no kernel/service test-count quota. Scenario count is not a quality
metric.

| Workflow | Target |
|---|---:|
| Focused changed proof | under 10 seconds |
| Local confidence | under 60–90 seconds |
| Pre-push | under 3–5 minutes |
| First actionable CI failure | under 2 minutes |
| Deterministic CI result, p95 | under 10–12 minutes |
| Nightly/promotion/recovery | under 30–60 minutes, except an explicitly budgeted restore |

Worker counts come from measured memory, not CPU count. On the standard
development machine:

- use no more than two Python workers;
- run at most one Next production build, browser suite, or Gradle operation at a
  time;
- do not overlap unrelated heavy verification;
- report peak memory for heavy lanes when changing their orchestration.

Build the production artifact once per verification workflow and reuse it.
Start local infrastructure once per workflow or development session. Install
browser/system dependencies once per reusable environment.

## 8. Repository contract today

Runner configuration is authoritative where a filename convention has an
explicit exception. Public Make targets are supported workflow entry points;
underscored targets are implementation details.

### Static, build, security, and performance

| Proof | Command | Evidence |
|---|---|---|
| Python lint/format | `make check-back` | Ruff over Python |
| Python types | `make type-back` | Current Pyright boundary |
| Web lint/types/tokens | `make check-front` | ESLint, TypeScript, CSS-token policy |
| GitHub workflow lint/security | `make check-workflows` | actionlint and zizmor |
| Standard static aggregate | `make check` | Backend, types, frontend, workflows |
| Android lint | `make check-android` | Android debug lint |
| Production web build | `make build` | Next production compilation |
| First Load JS budget | `make check-bundle` | Production build plus authenticated bundle budget |
| Dependency audit | `make audit` | Python, web, E2E, and ingest dependency audits |
| Android build | `make build-android` | Debug and instrumentation APKs |
| Signed Android build proof | `make verify-android-release` | Release lint/build plus expected signer verification |

`check-bundle` is the current automated frontend performance-regression gate.
Do not create a generic load/soak suite for a one-user system without a measured
latency, memory, ingest, query, or worker risk and an explicit budget.

### Automated behavior

| Proof | Location/classification | Command |
|---|---|---|
| Python kernel | `python/tests/test_*.py`, `unit` | `make test-back-unit` |
| Python PostgreSQL/API | `python/tests/test_*.py`, `integration` | `make test-back-integration` |
| Python + frontend kernel aggregate | existing unit projects | `make test-unit` |
| Frontend pure | `src/**/*.test.ts` except configured browser path | `make test-front-unit` |
| Frontend Chromium component | `src/**/*.test.tsx` and `src/lib/highlights/**/*.test.ts` | `make test-front-browser` |
| Alembic migrations | current migration module | `make test-migrations` |
| Local Supabase Auth | `supabase` marker | `make test-supabase` |
| E2E environment resolver | Node contract test | `make test-e2e-env` |
| Deterministic real media | `real_media` marker/project | `make test-real-media` |
| Default Chromium journeys | `e2e/tests/*.spec.ts`, excluding configured projects | `make test-e2e` |
| Strict CSP journeys | `e2e/tests/*.csp.spec.ts` | `make test-csp` |
| Android instrumentation | `apps/android/app/src/androidTest` | `make test-android` |
| Non-E2E aggregate | unit, DB/API, migrations, browser components | `make test` |

The `network` pytest marker has no dedicated public target. Some deterministic
real-media cases carry both `network` and `real_media` and are selected through
`make test-real-media` with local provider fixtures. Do not infer that
`make test-live-providers` selects `network`, and do not add a new
network-only case without first creating an explicit owner lane.

### Provider and release reality

| Proof | Command | Evidence |
|---|---|---|
| Pinned shared provider runtime | `make test-provider-runtime` | Pin match, lint, types, deterministic runtime suite |
| Hosted provider canaries | `make test-live-providers` | `live_provider` cases; may soft-skip without credentials |
| Paid LLM promotion certification | `make certify-llm-providers` | Unfiltered provider matrix; fails closed without required credentials/assertion |
| Current standard verification | `make verify` | `check`, web build, and `make test` |
| Current broad verification | `make verify-full` | `verify`, real media, live providers, default E2E |
| Production auth smoke | `make smoke` | Deployed production auth smoke only |
| Production auth redirects | `make smoke-auth-redirects` | Read-only deployed redirect/allowlist proof |

`make verify-full` does not prove:

- that soft-skipped hosted-provider checks ran;
- strict CSP;
- provider-runtime certification;
- Android device or signed-release behavior;
- backup restoration;
- deployment or production health beyond separately run smoke targets.

Report each proof separately.

### Focused changed-proof commands

Focused commands are sanctioned. They are the required inner loop; broad Make
targets are not the first debugging tool.

Python kernel:

```sh
cd python
NEXUS_ENV=test uv run pytest -v --tb=short \
  -m "unit and not integration" \
  tests/path/to/test_module.py::test_behavior
```

Python PostgreSQL/API, using the persistent development services:

```sh
make dev
set -a
. ./.dev-ports
set +a
make migrate-test
cd python
NEXUS_ENV=test uv run pytest -v --tb=short \
  -m "integration and not unit and not supabase and not network and not slow" \
  tests/path/to/test_module.py::test_behavior
```

Frontend pure:

```sh
cd apps/web
bunx vitest run --project unit src/path/to/file.test.ts
```

Frontend Chromium component:

```sh
cd apps/web
bunx vitest run --project browser src/path/to/file.test.tsx
```

One Playwright file or title:

```sh
make test-e2e \
  PLAYWRIGHT_ARGS="tests/path.spec.ts --project=chromium --grep 'behavior'"
```

Strict CSP:

```sh
make test-csp \
  PLAYWRIGHT_ARGS="tests/path.csp.spec.ts"
```

Interactive Playwright:

```sh
make test-e2e-ui
```

After focused proof, run the smallest owning public lane before claiming that
lane. Do not invoke underscored Make targets directly.

## 9. Current fixture and corpus contract

### Python database and application fixtures

- `engine`: one SQLAlchemy engine shared for the pytest session.
- `verify_schema_exists`: fails fast when migrations have not prepared the test
  database.
- `db_session`: savepoint isolation and rollback; default for service work.
- `authenticated_client`: authenticated HTTP paired with `db_session`.
- `bootstrapped_user`: user/default library inside the rollback session.
- `direct_db`: committed multi-connection behavior with explicitly registered
  cleanup; use only for races, recovery, pooling, and commit-visible behavior.
- `auth_client`: no savepoint isolation; pair with `direct_db` cleanup.
- `client`: app with auth middleware intentionally absent; use only for public
  or intentionally unauthenticated behavior.
- `test_verifier`: controlled Supabase-token-verification seam, not permission
  to bypass application authorization.
- `reset_settings_cache`: clears process-global settings state after each test.

Do not add a global fixture when a small local builder or existing fixture is
enough. Do not use `direct_db` for convenience. Register cleanup in reverse
dependency order for committed rows.

Rollback proof does not cover deferred constraints, after-commit work,
multi-connection visibility, worker claims, or connection-pool behavior. Those
require `direct_db` or the future disposable-database lane.

### Frontend helpers

Current shared helpers live under `apps/web/src/__tests__/helpers/`, including
fetch-boundary, render-environment, authenticated-pane, audio, overflow, and
pane-return support.

These helpers are candidates for the clean testkit, not automatic precedents:

- retain helpers that expose product-shaped inputs and results;
- remove helpers that reproduce owner logic, hide assertions, or primarily
  manufacture mocks;
- add new shared helpers only when at least two clean-sheet proofs need the same
  stable plumbing;
- keep scenario-specific setup next to its proof.

### Canonical corpus

Representative reader, HTML, EPUB, PDF, transcript, and real-media artifacts
live under `python/tests/fixtures/`. Reuse them across Python and browser proof
instead of creating divergent copies.

New captured or binary fixtures require:

- clear provenance and permission to retain;
- no secrets, tokens, or personal production data;
- the smallest useful artifact;
- a manifest or README entry naming the behavior represented;
- a stable checksum where identity matters;
- deliberate semantic review before replacing a golden artifact.

Fixture-manifest validation is a required paved-road enforcement item.

## 10. Specialized proof

### Durable jobs and multi-system operations

Durable-work proof names both state machines when they differ: the queue state
and the domain state.

Cover, according to risk:

- SERIALIZABLE retry;
- atomic enqueue/notify;
- claim and lease ownership;
- heartbeat and expiry;
- worker death after committed checkpoints;
- duplicate delivery and notification;
- cancellation races;
- dead-letter and finalizer behavior;
- domain failure represented as queue success where designed;
- storage success followed by database failure and the inverse;
- reconciliation convergence;
- SSE disconnect, replay, and terminal behavior.

Use real PostgreSQL and the real worker process boundary for idempotency,
visibility, and replay. A pure state-machine model supplements this; it does not
replace database/process proof.

### Migrations and deployment

Migration proof uses production PostgreSQL and extensions and covers:

- empty baseline → head;
- each explicitly supported production snapshot → head;
- the new migration’s semantic and data-loss behavior;
- raw-SQL-owned tables, constraints, indexes, and triggers;
- backup and restore before irreversible work.

Do not preserve every historical migration permutation. Once all live databases
cross an agreed cutoff, create a new baseline and delete superseded migration
proof.

Nexus does not require rolling zero-downtime compatibility by default. For an
incompatible Vercel/Hetzner/schema cut, prefer an explicit maintenance window,
readiness check, migration, immutable artifact deployment, smoke, and rollback.
Test cross-version compatibility only when an owning product decision requires
zero downtime.

Downgrades are unsupported unless an owning architecture document explicitly
requires them. Prove forward recovery and application-artifact rollback instead.

### External providers

Ordinary PR proof makes no third-party calls. Use deterministic protocol
fixtures, `respx`, or a local boundary server for success, malformed payload,
timeout, rate limit, disconnection, and uncertain-dispatch behavior.

Run the same conformance cases against an owned fake and real adapter where drift
would be consequential. Scheduled/promotion canaries prove hosted credentials,
schemas, quotas, signing, redirects, webhooks, CORS/range/lifecycle, and
model/tool availability.

A missing secret is **not run**, never passing evidence. A promotion gate
designated fail-closed MUST fail when its required proof cannot execute.

### LLM evaluation and tool safety

Test deterministic orchestration, schemas, provenance, citations, accounting,
cancellation, retries, tool authorization, and side effects conventionally.

Semantic evaluation requires:

- a versioned, independently reviewed dataset;
- a stored baseline and explicit human-readable rubric;
- pinned model/provider/runtime versions in recorded evidence;
- deterministic graders where possible;
- repetitions and statistical thresholds only where variance matters;
- a declared per-run cost ceiling;
- preserved failing cases;
- explicit prompt-injection, untrusted-content, tool-escalation, and data-leakage
  cases for tool-bearing flows.

Never snapshot exact prose. Never let a model grade itself without independent
criteria and calibration.

### Browser behavior, accessibility, and visual quality

Browser proof uses user-visible roles, labels, text, keyboard actions, focus,
selection, and product identifiers. Avoid implementation selectors.

For relevant components and journeys:

- use semantic queries;
- exercise keyboard operation and visible focus;
- assert focus return after dialogs, sheets, previews, and navigation;
- automate basic accessibility checks where the harness supports them;
- conduct deliberate manual assistive-technology review for consequential
  interaction changes.

Broad pixel-by-pixel visual regression is out of scope. Use selected screenshots
or manual review for contracts that are genuinely visual—layout breakpoints,
overflow, PDF geometry, mobile chrome, and dense interaction states—and retain
only stable, reviewed baselines.

### Performance

`make check-bundle` owns the current First Load JS budget.

Add a performance proof only with:

- a named user-visible or operational risk;
- representative data/workload;
- a stable measurement environment;
- an explicit percentile/budget and regression policy;
- evidence that functional proof cannot catch the failure.

Generic enterprise load and soak testing is out of scope. Targeted ingestion,
query-plan, memory, worker-throughput, or browser-startup proof is allowed when
the one-user workload or developer machine has a measured problem.

### Android and extension

Chromium and Android WebView are the default supported matrix. Other browsers
are not implied by Chromium success.

Android instrumentation covers native ownership: App Links, auth handoff,
Credential Manager, WebView bridge, cookies, file chooser, share intents, Media
Session, background audio, offline behavior, and signing. Do not duplicate web
behavior.

Extension proof covers MV3 runtime, permissions, bearer scope, content capture,
and handoff boundaries. Reuse the canonical content corpus.

## 11. Recovery and production proof

For Nexus’s data-loss-intolerant profile, recovery is a first-class test lane,
not a noun in a release checklist.

### Recovery objectives

Until an owning operations decision sets stricter values:

- PostgreSQL recovery-point objective: no more than 15 minutes of committed data
  loss;
- recovery-time objective: service restored within 2 hours;
- object-store recovery must preserve every durable object still referenced by
  PostgreSQL or prove deterministic reconstruction.

### Required recovery evidence

- Continuously monitor backup/PITR freshness.
- At least monthly, restore the latest recoverable production backup into an
  isolated environment.
- Run an additional restore before an irreversible migration, destructive
  storage change, or backup-system cutover.
- Verify recorded migration head, critical table identities/counts, ownership
  and reachability invariants, representative referenced objects, application
  reads, and durable-job consistency.
- Record backup identity/time, requested recovery point, restored schema head,
  application SHA, duration, invariant results, object checks, and verdict.
- A backup file existing or a backup command returning zero is not restore
  evidence.

The target public lane is `make test-restore` or the future
`nexus-test release`. Neither exists today; recovery proof MUST be reported as
unavailable until an actual restore is run. Do not claim `make verify-full`
includes recovery.

### Deployment and production

Use:

- a production-equivalent preview of the immutable release artifact;
- maintenance mode for incompatible hard cuts;
- safe post-deploy smoke;
- event-level data/job invariants;
- build-SHA-tagged logs, traces, and errors;
- known-good application rollback;
- forward database recovery.

Percentage canaries have little statistical value for one user. Use a dedicated
synthetic identity/tenant or read-only probes. Production writes must be
isolated, reversible, and explicitly authorized.

Sparse traffic makes aggregate error-rate dashboards insufficient. Monitor
critical events, stuck durable work, invariant violations, backup freshness, and
user-visible paths.

## 12. Mechanical enforcement and current exceptions

Normative rules apply now even where mechanical enforcement is pending. The
table states what the repository actually enforces and what the paved road must
add; it does not imply unavailable machinery exists.

### Enforcement map

| Rule | Today | Required enforcement |
|---|---|---|
| Registered pytest markers | `--strict-markers` | Keep |
| Python warnings | selected warnings fail | Expand only from evidence |
| No internal mocks | AST guard limited to real-media/live-provider surfaces | Test-glob static guard for owned Python and TypeScript targets |
| No external network in ordinary proof | marker selection and convention | Default-deny sockets/requests with explicit local-host and hosted-lane allowlists |
| No sleeps in proof | Review only | Test-scoped Python/ESLint restriction with narrow harness allowlist |
| E2E best practices | Playwright runner only | ESLint plus `eslint-plugin-playwright` or equivalent over `e2e/` |
| Flaky retry remains visible | Playwright classifies retry | At most one retry plus CI failure/report on flaky |
| Resource cap | None for Python unit target | Explicit maximum two local workers and one heavy process |
| Documented command/marker accuracy | Review only | Check documented public targets/marker selection against Make/config |
| Broken normative references | Review only | Link/path check for local rule owners |
| Fixture provenance | README/manifests on selected corpora | Manifest/checksum validation for canonical binary/captured fixtures |
| Falsifiability | Review evidence | Required demonstrated-red/sensitivity field in agent/PR workflow |
| Quarantine expiry | Convention | Small checked exception file; no custom service |

Do not mechanize semantic judgment merely to make the table green. Smallest
boundary, oracle independence, unique risk, and assertion quality remain review
responsibilities.

### Temporary legacy constraints

| Area | Available today | Required target |
|---|---|---|
| Python concurrency | unit target uses `pytest -n auto` | measured cap; maximum two locally |
| Services | fresh stacks per top-level workflow | persistent health-checked local stack |
| Database | shared migrated DB plus rollback/manual cleanup | immutable migrated template cloned per run |
| Browser state | shared authenticated seed user; one worker | scenario-local identities and writable state |
| Browser retries | two in CI | zero; at most one visibly flaky diagnostic retry |
| Next/browser setup | repeated builds and browser installs | one artifact and cached install |
| Selection | broad fixed targets | focused/affected loop plus scheduled full audit |
| Network | markers and convention | default-deny enforcement |
| Recovery | no public restore lane | scheduled and pre-destructive actual restore |

Until replaced:

- use the public commands in this document;
- do not copy or deepen their legacy internals;
- do not add shared mutable state, retries, unbounded parallelism, redundant
  stack startup, application builds, or browser installation;
- report unavailable higher-level proof honestly.

## 13. Adding or changing proof

Before adding or changing a proof, answer:

1. What risk, invariant, regression, or production contract does it prove?
2. What independent artifact supplies the oracle?
3. How was or will sensitivity be demonstrated?
4. What is the smallest boundary that can observe the failure?
5. Is the behavior already proved elsewhere or statically?
6. Which real dependency is essential?
7. What nondeterminism and writable state are controlled?
8. Will failure identify the input, state, identity, and responsible boundary?
9. Which focused command and public lane own it?
10. When can it be retired?

Reject proof that:

- lacks an independent oracle or named risk;
- has not met its required sensitivity level;
- asserts owned implementation choreography;
- mocks controllable Nexus behavior;
- duplicates existing proof without crossing a new boundary;
- relies on shared mutation or execution order;
- sleeps rather than observing state;
- silently contacts a provider;
- places a narrow edge case in a journey;
- adds material time or memory without an appropriate cadence;
- exists only for coverage or test-count growth.

When fixing a defect, add proof at the narrowest boundary that would have caught
it. Add broader proof only when wiring, configuration, deployment, or a
cross-boundary interaction caused the escape.

## 14. Legacy replacement and deletion

All new proof follows this policy immediately. When touching legacy proof, do
not expand its mocks, shared state, duplication, runtime, or fixture complexity.
Prefer clean replacement and deletion.

Priority-risk legacy proof remains blocking until its replacement:

1. names the same risk;
2. uses an independent oracle;
3. demonstrates sensitivity to a representative fault;
4. passes at the intended real boundary;
5. is faster or materially more diagnostic;
6. has run successfully in its intended gate.

Only redundant or low-priority legacy proof may move to non-blocking shadow
before replacement completes. Shadow is a comparison phase, not permission to
remove coverage.

Delete proof when:

- its risk no longer exists;
- stronger cheaper proof subsumes it;
- its supported compatibility window closes;
- a cutover is complete;
- its unique signal no longer justifies its resource/maintenance cost.

Do not preserve tests as historical documentation. Durable product and
architecture contracts belong in owner documentation.

The replacement order is:

1. cap resource use and stop repeated setup/build waste;
2. define critical risks and approximately ten product-existence journeys;
3. establish persistent services, per-run state, and the shared corpus;
4. build the compact kernel/service/component portfolio without translating old
   tests one-for-one;
5. replay known regressions and inject representative faults;
6. compare remaining legacy proof without weakening priority-risk gates;
7. delete mock-heavy, duplicate, source-grep, snapshot, historical migration,
   framework, and low-value flaky proof aggressively;
8. make affected proof the default and schedule full/provider/device/recovery
   work at its proper cadence.

Deleting 85–95% of legacy test count or source is plausible, not a quota.
Replacement is complete when current risks have stronger, sensitive, faster,
and more diagnosable proof.

## 15. The 80/20 paved road

Build these in order:

1. one repository-owned `changed`, `pr`, `full`, `nightly`, `release`, and
   `doctor` interface;
2. explicit memory caps, no `-n auto`, no overlapping heavy local gates;
3. one persistent Postgres/MinIO/Supabase stack;
4. one migrated seed database cloned per run;
5. one immutable canonical corpus plus per-run writable state;
6. default-deny network, owned-mock/sleep lint, E2E lint, and visible flakes;
7. one production build reused by browser projects;
8. demonstrated-sensitive replacement proof and aggressive legacy deletion;
9. actual restore and safe post-deploy proof.

Do not add Bazel, remote execution, per-test containers, Pact, ML selection, a
custom quarantine service, a large browser/device matrix, repository-wide
mutation testing, full distributed-system simulation, generic load/soak
infrastructure, broad pixel regression, or a commercial LLM-evaluation platform
without a measured problem that simpler tooling cannot solve.

Targeted property testing, fuzzing, changed-code mutation, deterministic job
simulation, and hosted conformance are allowed when a named risk justifies them.

## 16. Evidence, metrics, and maintenance

Failure artifacts include, as applicable:

- build SHA and exact command;
- input/case identity and property seed;
- service/runtime image or version;
- relevant redacted logs and traces;
- browser trace, screenshot, and last visible state;
- database identity and migration head;
- last observed job/storage state;
- sensitivity method and result.

Never capture secrets, auth tokens, provider credentials, or personal production
content.

Track only metrics that change decisions:

- p50/p95 first actionable failure and decisive result;
- peak memory and compute time for heavy lanes;
- first-attempt versus retry pass rate;
- escaped failures grouped by missing boundary/oracle;
- selector misses during scheduled full runs;
- restore freshness, success, RPO, and RTO;
- proof consuming maintenance without unique signal.

Do not use raw test count, line coverage, assertion count, or green retries as
quality indicators. Coverage is a searchlight for unvisited risk, not a
confidence score.

This document owns stable Nexus intent and the current executable routing table.
When Make targets, markers, fixtures, supported platforms, or paved-road
capabilities change, update this document in the same change. Agents MUST never
be instructed to use nonexistent infrastructure or to infer production proof
from a lower lane.

## Methodological basis

This policy follows the durable common ground in:

- Google’s guidance on test size, hermeticity, doubles, flakes, selective
  mutation, and the limits of large tests;
- Martin Fowler’s sociable tests and smallest-useful-boundary approach;
- Spotify’s service-level integration model;
- Playwright’s isolation and user-visible behavior guidance;
- property/state-machine testing for invariant-rich behavior;
- independent-oracle and demonstrated-sensitivity requirements for
  agent-authored proof;
- production recovery, monitoring, and rollback.

External methodology is evidence, not authority. Nexus architecture, supported
behavior, consequences, feedback budgets, and recoverability determine the
portfolio.
