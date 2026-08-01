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
  destructive effects, provenance, or durable-work correctness.
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
deployment, or production behavior at risk.

Nexus is outcome-heavy, not E2E-heavy:

1. comprehensive static and preventive proof;
2. a small kernel of pure, property, and state-machine proof;
3. a dominant middle of service and browser-component proof using real Nexus
   code, real PostgreSQL, and real Chromium semantics;
4. very few complete journeys;
5. scheduled provider, device, fuzz, and semantic evaluation;
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
- fail-closed local-resource ownership and cleanup;
- deploy rollback owned by the deployment system.

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

PR sensitivity MUST NOT dispatch paid hosted providers or require a physical
device. The local executor/parser proof is sensitivity-gated in PR; the hosted
or device boundary runs only in its named protected capability.

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

- data loss and corruption;
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

Auth, secrets, money, destructive mutation, anonymous sharing, migration, and
signed releases are critical regardless of arithmetic.

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

Use a dedicated local PostgreSQL server matching production's version and
required extensions for transactions, isolation, locks, constraints, raw SQL,
pgvector, migrations, query plans, `LISTEN/NOTIFY`, and commit-time behavior.
SQLite, mocked SQLAlchemy sessions, and emulated dialect behavior are not
substitutes. The production server itself is forbidden by §11.

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

No repository-wide fetch helper is a promised contract. Keep a minimal,
schema-valid fetch-boundary fixture beside its sole proof; once another proof
shares the same protocol contract, extract one small owned testkit helper.
Never copy a deleted legacy helper or generalize unrelated endpoint shapes.

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

- Automatic retries are forbidden in every blocking workflow. A diagnostic
  rerun is a separate, explicitly requested run and never changes the first
  verdict. Use `./scripts/test diagnose --of <16-hex-run-id>` only for a failed
  v1 workflow summary at the same clean committed `HEAD`; the controller allows
  one formal replay, links separate evidence, keeps top-level `status: fail`,
  and exits nonzero. CI and Agency gates MUST NOT invoke it.
- Never use silent retry, indefinite skip, quarantine-to-green, or timeout
  inflation.
- Fix, replace, or delete a flake according to its unique risk signal.
- Temporary quarantine requires a reason, expiry, and replacement proof for any
  priority risk. Solo ownership is implicit.

## 7. Portfolio and budgets

Static proof is comprehensive. The behavioral center of gravity is real
PostgreSQL service proof and real-Chromium component proof. The kernel is small
and semantically dense. The browser portfolio has ten named journeys; adding
one requires deleting or justifying overlap. Test count and line coverage are
not targets.

A red or `not_run` result is decisive. The controller records later
capabilities as blocked and launches no further heavy work.

| Workflow | Warm target | Cold behavior |
|---|---:|---|
| exact proof / `changed` | under 10 seconds when no heavy boundary is selected | dependency or first template/build cost is recorded, not hidden |
| `confidence` | 60–90 seconds | selected service/component setup may exceed the warm target |
| `pr` | 3–5 minutes locally | CI duration is measured before a p95 ratchet is adopted |
| `full` | measured; no fixed acceptance number | one build and one sequential heavy process |
| `nightly` / `release` | scheduled and cost-capped | hosted/device work remains fail-closed |

The controller records peak RSS for its process tree and the working set of
containers owned by the exact test compose project. CPU count never chooses
workers. Run one Next build, Chromium suite, or Gradle operation at a time; do
not overlap unrelated heavy lanes. Build one fingerprinted strict-CSP Next
artifact and reuse it.

Before launching Node/browser/build/Gradle or other heavy proof, the controller
requires at least 2,048 MiB of kernel-reported `MemAvailable`; otherwise the
capability is `not_run` before launch. This is a conservative host-safety
admission floor, not a proof-size or performance target. Change it only from
recorded memory evidence on the 8 GiB reference host.

## 8. Repository capability contract

`./scripts/test` is the sole public test and verification API. `scripts/test`
is a thin locked launcher; `scripts/agency_verify.sh` is a thin `confidence`
adapter. The Makefile deliberately has no test/check/verify aliases.

| Command | Required meaning |
|---|---|
| `./scripts/test changed [--base REF] [PATH_OR_NODE ...]` | changed static paths plus selected affected proof |
| `./scripts/test confidence` | complete policy/static/kernel plus affected service/component proof |
| `./scripts/test pr` | deterministic blocking PR portfolio plus same-run sensitivity |
| `./scripts/test full` | complete deterministic local portfolio |
| `./scripts/test nightly` | `full` plus randomized/property audit, one hosted canary, and Android device proof |
| `./scripts/test release` | `full` plus bounded provider certification, signed Android release proof, and exact staged artifacts |
| `./scripts/test doctor` | tool, dependency, browser, SDK, local-service, port, and template readiness |
| `./scripts/test prove --proof PROOF --against base:REF\|fault:FAULT_ID` | exact demonstrated-red then green sensitivity evidence |
| `./scripts/test diagnose --of RUN_ID` | one separately recorded replay of the exact failed workflow; never a new verdict |
| `./scripts/test clean` | delete exact ledger-owned runs, the recorded local workspace stack/volumes, and its runtime state |
| `./scripts/test list --json` | machine-readable registry from the same typed execution source |

When changed-file routing names a capability later than the invoked workflow,
the controller MUST retain it in evidence with its exact `deferred_to` owner and
MUST NOT dispatch it early or reject the current gate. Deferral MUST NOT clear
locally eligible changed-proof sensitivity: only paid hosted-provider and
physical-device boundaries are excluded. The owning `full`, `nightly`, or
`release` workflow remains fail-closed.

### Proof owners

| Boundary | Owner |
|---|---|
| Python kernel/control plane | `python/tests/kernel/` |
| Shared local-real testkit | `python/tests/testkit/` and `python/tests/conftest.py` |
| Real PostgreSQL/API/service | `python/tests/service/` |
| Migration graph and convergence | `python/tests/migrations/` |
| Deterministic LLM semantics | `python/tests/evals/` |
| Property/random-order audit | `python/tests/audit/` |
| Paid hosted proof | `python/tests/hosted/nightly/` and `python/tests/hosted/release/` |
| Web pure kernel | `apps/web/src/**/*.unit.test.{ts,tsx}` |
| Chromium component | `apps/web/src/**/*.browser.test.{ts,tsx}` |
| Journeys, deployment smoke, extension | `apps/web/e2e/` under the sole Playwright config |
| Android host/device | `apps/android/app/src/test/` and `apps/android/app/src/androidTest/` |
| Corpus / risk registry | `testdata/manifest.json` / `testdata/proofs.json` |

Pytest markers do not route work. Typed capabilities and final-owner filename
conventions do. Ordinary Python proof is socket-denied, including spawned
Python workers through `sitecustomize`; only `tests/hosted/` with the
controller's explicit socket flag may contact external providers. Browser
component globals guard `fetch`, `EventSource`, and `WebSocket`; Playwright
allows only controller-recorded loopback origins. No test may supply product or
production resource endpoints.

### Focused changed-proof commands

Use `./scripts/test changed <repository-relative path or exact
runner-qualified node>` for the supported inner loop. Direct pytest, Vitest,
Playwright, or Gradle invocation is allowed for exact debugging (`--lf`, watch,
`--headed`, `--debug`) only; checked-in configuration and network policy still
apply. A direct invocation is not a workflow verdict.

## 9. Current fixture and corpus contract

### Local runtime and ownership

The controller owns one persistent, health-checked, workspace-local
PostgreSQL/MinIO/Supabase-test stack recorded in `.nexus-test/runtime.json`.
Each workflow receives one run ID and disposable writable state:

- a fingerprinted, migrated, non-connectable PostgreSQL template built from
  `template0`, then a clone named `nexus_run_<run-id>`;
- an empty `nexus_migration_<run-id>` database only when migration proof is
  selected;
- a MinIO bucket named `nexus-run-<run-id>`;
- scenario-local Supabase users named from the run and scenario IDs;
- processes, profiles, and other resources recorded in the run ownership
  ledger before creation.

Before contacting a service, the controller MUST reject a non-test
`NEXUS_ENV`, caller-supplied resource configuration, public/non-loopback
endpoints, a repository mismatch, or a resource name outside the exact test
grammar. Cleanup walks the ledger in reverse dependency order and deletes only
resources both recorded there and still matching that grammar. Interrupted-run
proof uses synthetic test data and demonstrates that foreign or unrecorded
resources survive.

### Python database and application fixtures

- `engine`: session-scoped engine for the controller-owned run clone.
- `db_session`: savepoint isolation inside that clone; default for service
  work.
- `test_user`: unique user/default library inside the rollback transaction.
- `authenticated_client`: the real FastAPI app and authorization stack paired
  with `db_session`; only external token verification is a controlled fake.

Use ORM-backed factories or owner APIs so fixture shape follows production
models. Use a small local builder for unreachable states, and independently
verify it. Multi-connection visibility, worker claims, committed checkpoints,
pooling, and concurrency require an explicit process/service proof against the
disposable run database; do not add a convenience bypass fixture.

### Browser state and helpers

Chromium component proof uses the owner-local testkit and may stub only the
browser's external fetch/SSE boundary as defined in §6. Every Playwright
journey creates its own local Supabase user and writable state, uses strict CSP,
and runs in a fresh context. `storageState`, setup projects, shared seed users,
and shared mutable JSON are forbidden. The sole Playwright configuration uses
one worker and zero retries.

Each journey declares its product-source owner globs in `testdata/proofs.json`.
Changing a declared source selects that exact journey. Lazy pane registry/body
ownership MUST use this route because static-import related-test discovery
cannot see dynamically registered panes.

Add a shared helper only when at least two proofs need the same stable plumbing.
Helpers expose product-shaped inputs/results and MUST NOT reproduce owner logic,
hide assertions, or contain the scenario's oracle.

### Canonical corpus

`testdata/manifest.json` is the machine owner for reusable cross-language
artifacts, including existing pane-find and consumption corpora and the selected
reader/real-media fixtures under `python/tests/fixtures/`. Reuse them across
Python and browser proof instead of creating divergent copies.

New captured or binary fixtures require:

- clear provenance and permission to retain;
- no secrets, tokens, or personal production data;
- the smallest useful artifact;
- an exact manifest entry naming provenance and represented behavior;
- a stable checksum;
- deliberate semantic review before replacing a golden artifact.

The policy capability validates every declared path, checksum, provenance
field, and undeclared corpus-file violation.

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

Migration proof uses dedicated local PostgreSQL matching production's version
and extensions and covers:

- empty baseline → head;
- each explicitly supported production snapshot → head;
- the new migration’s semantic and data-loss behavior;
- raw-SQL-owned tables, constraints, indexes, and triggers;
- PostgreSQL/object consistency against synthetic local state where the
  migration crosses that boundary.

Do not preserve every historical migration permutation. Once all live databases
cross an agreed cutoff, create a new baseline and delete superseded migration
proof.

Nexus does not require rolling zero-downtime compatibility by default. For an
incompatible Vercel/Hetzner/schema cut, prefer an explicit maintenance window,
readiness check, migration, immutable artifact deployment, smoke, and rollback.
Test cross-version compatibility only when an owning product decision requires
zero downtime.

Downgrades are unsupported unless an owning architecture document explicitly
requires them. Prove forward migration and application-artifact rollback
instead.

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

The typed `bundle` capability owns the strict-CSP standalone build and its
current First Load JS budget.

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

## 11. Local test-runtime safety

This testing system may create and destroy only dedicated local test resources.
It MUST NOT contact, inspect, verify, mutate, restore, or clean up production
PostgreSQL, object storage, Supabase, or user data.

Before any resource contact or creation, the controller MUST:

- force `NEXUS_ENV=test` and reject any other product environment;
- reject caller-supplied database, storage, Supabase, or service resource
  configuration;
- pin Docker and Supabase CLI work to a verified local Unix-domain Docker
  socket; remote Docker hosts and contexts are forbidden;
- accept only controller-derived loopback endpoints and exact test-only names;
- persist the repository identity, run ID, resource kind, planned identity, and
  ownership state before creation.

Cleanup MUST read the run ledgers and validated workspace runtime record,
revalidate repository and resource-name ownership, delete exact run resources,
then stop and remove only the recorded local Supabase/Compose projects and
test-only volumes. It MUST preserve every foreign, unrecorded, public, or
ambiguously named resource. Synthetic interruption proof must cover crashes
between plan/create/record and idempotent repeated cleanup.

Independent teardown owners are all attempted even when one fails. Any failed
teardown keeps the runtime ledger and exact recovery path intact and returns a
failure; ownership evidence is deleted only after every exact teardown
succeeds.

A local synthetic restore scenario is allowed only when it proves a concrete
migration or PostgreSQL/object-consistency risk. It is not product disaster
recovery evidence.

Production backup, PITR, AWS recovery infrastructure, Cloudflare R2 recovery,
retention, RPO, RTO, and restore drills belong to a separate future operations
project. They are not a test workflow, release prerequisite, or acceptance
criterion in this repository contract.

### Deployment and production smoke

Use:

- a production-equivalent preview of the immutable release artifact;
- maintenance mode for incompatible hard cuts;
- safe post-deploy smoke;
- event-level data/job invariants;
- build-SHA-tagged logs, traces, and errors;
- known-good application rollback;
- explicit migration-forward handling where required.

Percentage canaries have little statistical value for one user. Use a dedicated
synthetic identity/tenant or read-only probes. Production writes must be
isolated, reversible, and explicitly authorized.

Sparse traffic makes aggregate error-rate dashboards insufficient. Monitor
critical events, stuck durable work, invariant violations, and user-visible
paths. Production smoke MUST remain read-only or use a dedicated reversible
synthetic identity and MUST NOT imply disaster-recovery proof.

## 12. Mechanical enforcement

The paved road enforces the mechanically decidable part of this contract:

| Contract | Enforcement owner |
|---|---|
| Sole command/routing/workflow/docs ownership | typed capability registry plus policy route-contract checks |
| Final-owner path and filename taxonomy | registry selection and policy AST/path checks |
| No owned-code mocks, sleeps, skips, or focused commits | Python AST policy plus test-scoped ESLint/Playwright policy |
| Ordinary Python network denial | in-process socket guard plus inherited `sitecustomize` worker guard |
| Browser network denial | component global guards and controller-recorded loopback Playwright allowlist |
| Local-resource isolation | pre-contact environment/endpoint/name validators and exact ownership ledger |
| Deterministic execution | zero automatic retries, one Playwright worker, fixed audit seeds, one heavy-process lock |
| Fixture provenance | `testdata/manifest.json` path, provenance, and SHA-256 validation |
| Priority-risk and journey routing | `testdata/proofs.json` schema, source owners, minimum risk IDs, exact journey selection, and sensitivity records |
| Falsifiability | `prove` red/green evidence plus PR policy for changed proof globs |
| Evidence integrity | versioned run summary schema, `pass|fail|not_run`, fail-on-`not_run`, bounded artifacts |
| Corpus/policy self-protection | policy capability runs in every blocking workflow and has adversarial kernel proof |

Warnings configured as errors and broken normative links remain policy-owned.
`testdata/policy-exceptions.json` is the only mechanical exception surface; an
entry requires exact scope, rationale, expiry, and replacement disposition.

Do not mechanize semantic judgment merely to satisfy this table. Smallest
boundary, oracle independence, unique risk, assertion quality, and whether a
visual or accessibility contract was truly observed remain review decisions.

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
8. make affected proof the default and schedule full/provider/device work at
   its proper cadence.

Deleting 85–95% of legacy test count or source is plausible, not a quota.
Replacement is complete when current risks have stronger, sensitive, faster,
and more diagnosable proof.

## 15. The 80/20 paved road

Build these in order:

1. one repository-owned `changed`, `pr`, `full`, `nightly`, `release`, and
   `doctor` interface;
2. an explicit memory-admission floor, measured ratchets, no `-n auto`, and no
   overlapping heavy local gates;
3. one persistent Postgres/MinIO/Supabase stack;
4. one migrated seed database cloned per run;
5. one immutable canonical corpus plus per-run writable state;
6. default-deny network, owned-mock/sleep lint, E2E lint, and visible flakes;
7. one production build reused by browser projects;
8. demonstrated-sensitive replacement proof and aggressive legacy deletion;
9. bounded release proof and safe post-deploy smoke.

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

Formal diagnostic evidence names `command: diagnose`, the original failed run
and summary, and a nested `diagnostic_result`. Its top-level status remains
`fail` regardless of the replay result. Direct runner debugging remains
unlinked, non-gate evidence.

Never capture secrets, auth tokens, provider credentials, or personal production
content.

Track only metrics that change decisions:

- p50/p95 first actionable failure and decisive result;
- peak memory and compute time for heavy lanes;
- escaped failures grouped by missing boundary/oracle;
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
- production monitoring and rollback.

External methodology is evidence, not authority. Nexus architecture, supported
behavior, consequences, feedback budgets, and recoverability determine the
portfolio.
