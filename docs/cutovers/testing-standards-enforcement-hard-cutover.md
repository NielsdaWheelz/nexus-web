# Testing Standards Enforcement Hard Cutover

Status: IMPLEMENTED IN SOURCE — scoped static, kernel, and policy proof complete;
heavy real-stack, same-run sensitivity, and remote candidate-full proof pending

Type: hard cutover

Date: 2026-07-31

Governing contracts:

- `docs/local-rules/testing-standards.md`
- `docs/rules/{boundaries,cleanliness,codebase,correctness,database,overrides,retries,simplicity,timing}.md`

Production disaster recovery is a separate future operations project. This
cutover owns only test-infrastructure safety: it MUST prove that the harness
cannot connect to or mutate production and can clean up only its recorded local
test resources. Production backup, PITR, AWS recovery infrastructure, R2
recovery, RPO, and RTO are neither prerequisites nor acceptance criteria and
are not claimed by this cutover.

## Decision

Replace the current test suite and orchestration with one small test control
plane:

```text
developer / agent / CI / Agency
              |
        ./scripts/test
              |
  selection -> policy -> runtime -> runners -> evidence
                           |
      persistent Postgres + MinIO + Supabase Auth
      per-run database + bucket + users + app processes
```

Keep pytest, Vitest browser mode, Playwright, PostgreSQL, MinIO, Supabase-local,
Ruff, Pyright, ESLint, TypeScript, actionlint, and the existing canonical media.
Add only `pytest-socket`, Hypothesis, `eslint-plugin-playwright`, and the
repository-owned Python control plane. Hypothesis owns targeted Python
property/state-machine/fuzz proof; the control plane shuffles collected nodes
with a recorded seed for randomized-order proof. Add no daemon, test service,
DSL, coverage gate, remote executor, or second orchestration tool.

The public cut lands atomically. Time-boxed internal control-plane, runtime,
testkit, and replacement-proof foundations MAY land inert and self-tested
beforehand, but no merged state may expose two public command sets, CI routes,
or fallback portfolios. The final routing commit removes the legacy paths.

## Goals

- Enforce the local testing standard mechanically where syntax or runtime can
  decide it.
- Make focused proof the default; keep the static/kernel warm path under
  10 seconds and give slower affected proof an explicit cadence.
- Reuse service processes and one production build; isolate all writable state.
- Bound local concurrency by measured total owned memory; default to no more
  than two Python workers and one local heavy process.
- Refuse Node/browser/build/Gradle and other heavy launches below 2,048 MiB
  kernel `MemAvailable`; treat that value as a conservative host-safety
  admission floor, not a proof-performance acceptance limit, and adjust it only
  from recorded 8 GiB-host evidence.
- Replace legacy proof by risk, demonstrate sensitivity, then delete it.
- Leave approximately 10–15 product-existence journeys and a dominant
  real-service/real-Chromium middle.
- Produce truthful `pass | fail | not_run` evidence with red/green sensitivity,
  time, and total owned process/container memory.
- Run on an 8 GiB, four-core development machine without OOM.

## Scope

In scope:

- the public test API, selectors, policy checks, runtime lifecycle, evidence,
  CI cadence, test structure, testkits, corpus, and proof portfolio;
- PostgreSQL template cloning, per-run MinIO buckets, scenario-local Supabase
  users, app-process lifecycle, and one cached Next production artifact;
- deleting or replacing legacy tests and every old test-only path they own;
- adapting the current Android emulator, protected provider-certification,
  signed-Android, and deployed-auth-smoke owners without duplicating their
  responsibility; the unowned reader-profile fault proxy is deleted.

Non-goals:

- product behavior, production schema, or production service changes beyond
  deleting test-only seams and adapting build/test wiring; separately fix any
  real product defect this cutover exposes before the public cut;
- production backup, PITR, disaster recovery, retention, R2 replication,
  production restore, RPO/RTO, or a new deploy system; those belong to a
  separate future operations project;
- line coverage targets, universal mutation testing, load/soak infrastructure,
  browser/device farms, visual-diff platforms, Pact, Bazel, or ML selection;
- translating old tests one-for-one or retaining them as history;
- supporting old Make targets, markers, seed files, paths, or environment
  variables after cutover.

## Public capability contract

`./scripts/test` is the sole repository test entrypoint. Deploy-owned production
smokes remain deployment operations.

```text
./scripts/test changed [--base <git-ref>] [<path-or-node> ...] [--ui]
./scripts/test confidence [--base <git-ref>]
./scripts/test pr
./scripts/test full
./scripts/test nightly
./scripts/test release
./scripts/test prove --proof <node-id> \
  --against base:<git-ref>|fault:<fault-id>
./scripts/test diagnose --of <16-hex-failed-run-id>
./scripts/test doctor
./scripts/test clean
./scripts/test list --json
```

Rules:

- No command silently defaults to another command.
- Only `changed` accepts focus paths/node ids. `--ui` requires exactly one
  Playwright target.
- `prove` runs one current proof against an isolated unfixed/faulted state and
  the current state. It is the debugging interface for the sensitivity gate,
  not a second test runner.
- No arbitrary runner-argument passthrough. Add a semantic capability when a
  stable need exists.
- Direct pytest, Vitest, Playwright, and Gradle invocation is allowed for
  non-gate debugging. Final evidence and every confidence claim use
  `./scripts/test`. `pytest --lf`, Vitest watch mode, and Playwright
  `--headed`/`--debug` are explicitly sanctioned under the checked configs.
- `doctor` is read-only. `clean` removes only runtime resources whose recorded
  repo id and run id match this workspace.
- Exit zero means every required selected capability passed. Missing tools,
  secrets, device, or provider execution is `not_run`, never pass.
- Every gate fails when a required selected capability is `not_run`.
- Gates have zero automatic retries. `diagnose --of` MAY replay one failed v2
  workflow at the same clean committed `HEAD` and exact recorded invocation
  inputs for richer artifacts. It records separate linked evidence, retains
  top-level `fail`, exits nonzero, and is forbidden in CI and Agency gates.

| Workflow | Required composition |
|---|---|
| `changed` | changed-scoped policy/static checks plus directly affected kernel, service, component, migration, or journey proof |
| `confidence` | all policy self-tests and fast static/kernel proof plus affected real-service and Chromium-component proof; no production build or complete journey portfolio |
| `pr` | `confidence` plus current-migration, bundle, compact service/component proof, and 2–4 critical journeys; no hosted calls |
| `full` | `pr` plus all deterministic corpus, provider-runtime, LLM-evaluation, extension, Android-host, and all 10–15 journeys |
| `nightly` | `full` plus audit, randomized/property/fuzz lanes, budgeted hosted canaries, and the existing Android-emulator proof |
| `release` | `full` plus fail-closed provider certification, signed Android artifact, and release artifact checks |
| `doctor` | tools, locked dependencies, browser install, service health, ports, template fingerprint, and workflow credential readiness |

`changed` scans only changed policy/test source unless policy infrastructure
changed, in which case it promotes the complete policy capability. It selects
changed test files directly and maps typed-risk and lazy-loaded source routes,
including pane registry owners, through the proof contract. Unmapped
`apps/web/src/**` changes promote the compact complete component owner;
unmapped `python/nexus/**` changes promote the compact complete service owner.
It does not claim completeness. Test-infra, lockfile, migration, shared-schema,
or runner-config changes promote the owning complete capability. Do not build a
coverage database, Python import-graph framework, or hidden broad fallback.

## Control-plane architecture

Implement `python/nexus_test_control/` with cohesive owners:

- `model.py`: `Workflow`, `Capability`, `PriorityRiskId`, `Resource`,
  `RunStatus`, `Selection`, `Sensitivity`, and the one workflow/capability
  registry;
- `selection.py`: git diff and explicit-focus routing;
- `policy.py`: Python AST, repository-contract, exception, and corpus checks;
- `runtime.py`: validated runtime/ledger schemas, exact names, endpoints, and
  lifecycle locks;
- `services.py`: persistent local services and per-run database, bucket, user,
  and app-process lifecycle;
- `build.py`, `process.py`, and `memory.py`: fingerprinted build publication,
  interrupt-safe process groups, cross-process serialization, admission, and
  owned-memory measurement;
- `runner.py` and `sensitivity.py`: capability execution and same-run red/green
  proof;
- `evidence.py`: typed, redacted run summaries and artifacts;
- `cli.py` / `__main__.py`: parse, compose, stream the first failure, clean,
  and publish evidence.

Use frozen dataclasses and exhaustive enums. Capability functions accept one
typed context and return one typed result. Runners are internal functions, not
plugins. Commands remain explicit arrays passed without a shell. Secrets never
enter command text, logs, or evidence.

`scripts/test` is a thin `exec` launcher into this module.
`scripts/agency_verify.sh` remains only as the required Agency adapter and
executes `./scripts/test confidence`; it owns no policy. Agents use `changed`
while iterating and the risk-appropriate `pr` or higher gate before claiming
that broader proof ran.

Do not create YAML workflow definitions or a generic task graph. The typed
Python registry is the single machine source for CLI help, workflow
composition, CI assertions, and the command table in the local rule.

## Runtime and state

### Persistent infrastructure

Adapt `docker/docker-compose.test.yml` into one stable, volume-backed
PostgreSQL/MinIO stack per workspace. Keep one stable Supabase-local workdir per
workspace. Derive the runtime id from the canonical repo path; allocate ports
once; record them under ignored `.nexus-test/runtime.json`; health-check before
reuse. Local workflows leave healthy services running. CI tears them down at
job end.

The runtime record contains only `version`, `repo_id`, `compose_project`,
`supabase_workdir`, allocated `ports`, and owned `run_ids`; no secrets.

Extract the useful port, health, and cleanup behavior from the current shell
wrappers into the runtime/services owners, then delete the wrappers. Do not
share the product development database, bucket, or Supabase users.

### PostgreSQL

Fingerprint all migration sources, PostgreSQL image/version, extensions, and
immutable seed inputs. Build one disconnected database named
`nexus_tpl_<fingerprint>` from `template0`, migrate to head, seed only immutable
shared facts, close every connection, and mark it non-connectable. Clone
`nexus_run_<run_id>` from it for each workflow. Create a separate empty
`nexus_migration_<run_id>` for migration proof. Remove obsolete templates only
after no recorded run owns them.

Serialize build, finalize, clone, and drop under one per-fingerprint template
lifecycle lock. Build first as `nexus_tpl_build_<run_id>`; rename and mark it
non-connectable only after migration/seed verification succeeds. An interrupted
build remains identifiable as incomplete and is removed by `clean`; it can
never be cloned as a valid template.

Within a run:

- service proof uses savepoint rollback by default;
- committed/multi-connection proof uses registered reverse-order cleanup;
- browser journeys use unique users/libraries/resource identities;
- no test observes another test’s writes.

PostgreSQL requires the source template to have no connected sessions while
cloning; runtime locking and engine disposal must enforce that.

### Storage, auth, and processes

- Create one empty `nexus-run-<run_id>` MinIO bucket for run-owned writes and
  delete it after the run. Canonical corpus inputs remain manifest-owned files;
  add object preload only for a concrete proof that requires it.
- Create a unique Supabase user per journey, for example
  `nexus+<run_id>+<scenario>@example.invalid`; delete it in fixture teardown.
- Read the local Supabase service-role credential from the generated local
  runtime environment into the parent process only. Pass it directly to the
  admin fixture; never expose it to browser state, child command text, logs, or
  evidence.
- Give every Playwright test a new browser context and auth state. Delete global
  `storageState`, setup projects, shared seed users, and shared mutable JSON.
- Start API, web, and both worker lanes once per journey capability, after run
  state exists. Stop exact process groups on success, failure, signal, or
  `clean`; no unowned reader-profile fault proxy or global fail-next state
  remains.
- Persist run ownership before creating each resource so interrupted cleanup is
  deterministic.

### Build and resource control

Build Next once per workflow with strict production CSP and a portable
standalone output. Key the artifact by web sources, lockfile, build config, and
build-time environment; record the fingerprint beside it. Playwright starts the
already-built artifact and contains no build command. Remove
`E2E_DISABLE_CSP`; every journey uses the production CSP. Install Chromium
during dependency setup, not inside a test target.

Use cross-process locks for template lifecycle, `next-build`, `chromium`, and
`gradle`. On the standard local machine, kernel pytest uses one process;
database pytest, Vitest browser, Playwright, builds, and Gradle use one, with at
most one heavy operation active. Remove every `-n auto`, Playwright shard, and
automatic retry. Keep failure traces with `retain-on-failure`.

CI initially uses one bounded job per invoked workflow. Capabilities reuse the
same stack, database template, and fingerprinted standalone build within that
job. A sampler records recursive owned process-tree RSS and owned container
working set without double-counting. Split build/static/real-stack jobs only
after measured cold/warm evidence shows a material benefit; any future consumer
must download one producer artifact and must not rebuild it.

Budget semantics:

| Path | Budget treatment |
|---|---|
| warm `changed` static/kernel fast path | target under 10 seconds |
| warm `confidence` | target 60–90 seconds |
| cold `changed`/`confidence` | record separately; service/browser startup is not charged to the warm target |
| local `pr` and `full` | baseline first, then ratchet; no invented pre-implementation ceiling |
| CI decisive result | publish p50/p95 after enough comparable runs; ratchet from measured evidence |
| nightly/release | explicit capability duration and cost budgets; never traded against PR latency |

A target miss is optimization evidence, not permission to delete unique
priority proof, weaken assertions, or increase concurrency past the memory cap.

## Proof and test structure

```text
python/tests/
  conftest.py
  testkit/                 # records, storage, jobs, clocks; plumbing only
  kernel/                  # pure/property/state-machine proof
  service/                 # real PostgreSQL/API/worker proof
  contract/                # local protocol servers and provider fakes
  migrations/              # supported baselines -> head
  evals/                   # deterministic versioned LLM rubrics/cases
  audit/{property,fuzz,randomized}/
  hosted/                  # explicit hosted canaries only

apps/web/src/
  **/*.unit.test.ts
  **/*.browser.test.ts
  **/*.browser.test.tsx
  __tests__/helpers/       # fetch, render, SSE, canonical corpus only

apps/web/e2e/
  playwright.config.ts     # one config, strict CSP, retries 0, workers 1
  fixtures.ts              # per-scenario user/context/data lifecycle
  journeys/*.journey.spec.ts
  extension/*.extension.spec.ts

apps/android/app/src/{test,androidTest}/
testdata/manifest.json
testdata/proofs.json
testdata/faults/{manifest.json,...}
testdata/policy-exceptions.json
```

Classification comes from directories/suffixes and the typed capability
registry. Delete the `unit`, `integration`, `migration_ci_late`, `artifact`,
`slow`, `supabase`, `network`, `real_media`, and `live_provider` marker routing.
Keep only a marker if pytest itself must alter mechanics and no path or
capability can express it.

Move the separate `e2e` package into `apps/web/e2e`; use the web Bun lock and
one Playwright installation. Fold deterministic real-media and CSP cases into
the same service/component/journey owners. Delete the second package, three
Playwright configs, global setup, shared auth/seed output, giant seed scripts,
and route-specific helper stacks.

Keep only helpers used by at least two surviving proofs. Helpers expose
product-shaped inputs/results and never contain scenario decisions or oracles.
Consolidate `python/tests/{factories,fixtures,helpers,support,utils}` into the
small testkit. Preserve only the controlled external-token-verification seam as
`StaticTokenVerifier`, while deleting permission/owned-behavior mocks and broad
direct-SQL convenience layers. Raw SQL remains limited to migration proof and
one narrowly owned unreachable-state testkit.

### Priority proof contract

`PriorityRiskId` in the typed registry is the minimum in-scope product and test
infrastructure risk floor. Production disaster recovery remains separately
owned and is not represented as passing or `not_run` here. `testdata/proofs.json`
maps every exact required id to proof and source owners and inventories complete
journeys:

```text
test-environment-isolation
auth-privacy-secrets
destructive-side-effects
migration-compatibility
costly-effects
reading-progress
citation-provenance-identity
durable-job-replay
database-object-convergence
llm-tool-safety
native-release-auth-handoff
```

```json
{
  "version": 1,
  "priority_risks": [
    {
      "id": "stable-risk-id",
      "source_globs": ["owned/source/**"],
      "proofs": ["runner-qualified-node-id"],
      "capabilities": ["service"]
    }
  ],
  "journeys": [
    {
      "id": "auth-bootstrap",
      "proof": "apps/web/e2e/journeys/auth-bootstrap.journey.spec.ts",
      "source_globs": ["owned/auth-or-shell/source/**"],
      "risks": ["auth-privacy-secrets"]
    }
  ]
}
```

Do not inventory ordinary tests. Policy verifies ids, paths, source-owner globs,
unique ownership, the 10–15 journey cap, and at least one proof for every
required priority risk. A changed journey-owned source selects that exact
journey; this is the selection contract for lazy pane bodies that static import
analysis cannot discover.
Deleting or renaming a risk id requires an explicit user-approved amendment to
the governing rule and registry; editing `proofs.json` alone cannot lower the
floor. Critical source globs include dynamically registered/lazy-loaded pane
bodies because Vitest static-import selection cannot discover them.

The journey portfolio proves:

1. auth, first-login bootstrap, refresh, and logout;
2. capture/upload through durable ingest into Library and one representative
   Reader document; format variants remain service/component proof;
3. selection -> highlight/note -> reload with stable provenance;
4. progress/completion persistence, resume, and reset;
5. durable grounded chat -> SSE -> citation -> exact reader location;
6. sharing/public access and denial boundaries; grant variants remain service
   proof;
7. Nexus search/open through workspace/pane navigation and durable restore;
8. podcast subscribe/refresh/playback progress;
9. destructive delete disappearance from the UI; asynchronous
   PostgreSQL/object-store convergence remains service proof;
10. Quick Note -> Today -> reload with durable prose.

Worker interruption/replay and strict-CSP/BFF/direct-SSE wiring are service or
contract capabilities, not synthetic user journeys.

Combine coherent steps; do not create one journey per format, edge case, pane,
or acceptance criterion. Narrow proofs own variants.

### Corpus schema

`testdata/` already contains cross-language `consumption` and `pane-find`
fixtures. Preserve those stable import paths unless consolidation removes a
real duplicate. `testdata/manifest.json` becomes the sole captured/binary
fixture inventory across the existing tree and any new `corpus/` subtree:

```json
{
  "version": 1,
  "artifacts": [
    {
      "path": "relative/path",
      "sha256": "64 lowercase hex",
      "source": "URL or authored provenance",
      "license": "retention basis",
      "purpose": ["named behavior"]
    }
  ]
}
```

Move only genuinely cross-language or duplicated artifacts from
`python/tests/fixtures`; do not churn authored fixtures merely to satisfy a new
directory shape. Keep tiny language-specific authored text fixtures beside
their proof. Policy rejects unmanifested captured/binary files, checksum drift,
secrets, absolute paths, duplicate content, and missing provenance.

### Specialized capability ownership

- Deterministic LLM evaluation lives in `python/tests/evals/` and uses versioned
  prompts/cases, pinned provider-runtime behavior, independently reviewed
  baselines/rubrics, prompt-injection cases, and tool-authorization assertions.
  Hosted sampled evaluation lives under `hosted/`, pins the model, and declares
  maximum calls and estimated cost in the capability registry. The runtime
  stops before either ceiling and records actual usage/cost.
- MV3 extension proof lives under `apps/web/e2e/extension/` and is the sole
  exception to fresh ephemeral browser contexts: it uses
  `launchPersistentContext` with a new per-run user-data directory, then
  destroys it. It proves runtime loading, permissions, bearer scope, capture,
  and handoff through the shared corpus.
- Android instrumentation adapts the existing emulator runner in
  `.github/workflows/ci.yml`; it is not a hypothetical device lane. The final
  workflow assigns it one cadence and does not duplicate signed-release proof.
- Property, fuzz, and randomized-order proof lives only in the explicit audit
  directories and is scheduled by `nightly`; no `slow` or shard marker replaces
  that classification.
- Interactive component/journey proof owns accessible roles/names,
  keyboard-only operation, focus entry/return, and live-status behavior at the
  affected boundary. Do not add a broad visual-regression platform.

## Mechanical policy

`policy` is blocking in every workflow.

- Python AST rejects `unittest.mock`, owned `monkeypatch.setattr`, sleeps,
  skips/xfails, unregistered markers, raw-SQL setup outside the migration or
  explicit unreachable-state testkit owner, and network enablement outside
  `hosted/`.
- `pytest-socket` disables sockets in the pytest process. Deterministic lanes
  allow only Unix sockets and exact runtime endpoints: `127.0.0.1`, `::1`, and
  `127.0.1.1` only when actually allocated/resolved. Never allow a loopback
  subnet or arbitrary hostnames. `hosted/` is the only force-enabled pytest
  lane.
- Real spawned-worker proof uses host `Popen` process groups with the inherited
  testkit `sitecustomize` socket guard and exact runtime loopback allowlist.
  This closes the subprocess gap that in-process `pytest-socket` cannot cover.
  Hosted workers use a separate explicit egress-enabled capability.
- Web test ESLint rejects `vi/jest` mock/spy functions, owned-module mocks,
  sleep promises, and skipped/only tests. Whether a product seam exists only
  for tests is semantic review, not a pretend mechanical rule.
- Vitest browser setup guards `fetch`, `EventSource`, and `WebSocket` and
  rejects non-runtime origins. UI component proof installs an explicit
  schema-valid fetch/SSE boundary fixture when needed. This is API-boundary
  enforcement, not a claim of browser-transport isolation; static policy also
  rejects external resource origins in component fixtures.
- Playwright uses its recommended rules plus blocking
  `no-wait-for-timeout`, `no-slowed-test`, `no-skipped-test`,
  `no-raw-locators`, and web-first assertions.
- A Playwright harness route aborts every non-allowlisted origin; journey files
  cannot intercept or fulfill routes. Enforce the latter with test-glob
  `no-restricted-syntax`; the Playwright plugin does not own this repo-specific
  rule.
- Policy validates workflow/docs/Make/Agency/CI drift, fixture provenance,
  proof-contract paths and minimum risk ids, worker/retry caps, Python warning
  policy, normative links, and one Playwright package/config. Its negative
  self-tests are a required `pr` capability.

Temporary exceptions live only in `testdata/policy-exceptions.json`:

```json
{
  "version": 1,
  "exceptions": [
    {
      "rule": "quarantine",
      "path": "exact/path",
      "node": "exact node id",
      "reason": "current defect",
      "expires_on": "YYYY-MM-DD",
      "replacement": "proof node or not-applicable reason"
    }
  ]
}
```

The cutover lands with an empty exception list. Future exceptions are exact,
date-bounded, visible as `not_run`, and rejected after expiry. Source-level
`.skip`, `.slow`, `.only`, and `xfail` remain forbidden.

### Sensitivity gate

Sensitivity is enforced by the control plane, not by PR prose:

1. Git rename detection routes both old and new owners and excludes pure moves
   and deletions from sensitivity. An added or edited locally eligible proof is
   mechanically sensitivity-required when it owns a priority-risk node or
   declares a targeted fault. Ordinary independent-oracle proof remains review
   governed; file novelty alone does not justify fake mutation ceremony.
2. `pr` invokes `prove`; it owns the red/green pair and does not rerun the green
   proof elsewhere. The default `base:<ref>` mode creates an isolated base
   worktree and overlays only the current proof, proof-owned testkit, and corpus
   inputs—not production implementation changes.
3. When the base already has the intended behavior, the proof declares a
   targeted fault id from `testdata/faults/manifest.json`. The control plane
   applies that small checked patch to an isolated current worktree. Do not
   build a mutation framework or commit a production defect.
4. One PR sensitivity portfolio reuses one isolated worktree, one
   checkout-local locked Python environment, and persistent local services per
   revision group. The environment is materialized offline from the lock and
   is deleted with the worktree; it MUST NOT symlink, retarget, or reconcile the
   developer worktree's `.venv`. The portfolio applies and exactly reverses one
   fault at a time; every proof still receives disposable run state. Do not
   rebuild the stack, Python environment, or schema template once per proof.
5. Red is valid only when the named proof was collected/executed and failed at
   its expected behavioral assertion or property. Import, collection, build,
   service-readiness, and unrelated-test failures do not count.
6. The current proof must then pass at the intended real boundary. `pr` fails
   when any sensitivity-required changed proof lacks a valid same-run
   red/green sensitivity object.

Paid hosted and physical-device proofs never enter PR sensitivity because PR
must remain offline and device-independent. Their local parsers/executors have
fault-sensitive kernel proof; the protected hosted/device capability supplies
the boundary result at its own cadence.

`testdata/faults/manifest.json` contains only reproducible targeted exceptions
to base-mode sensitivity:

```json
{
  "version": 1,
  "faults": [{
    "id": "stable-fault-id",
    "patch": "relative.patch",
    "sha256": "64 lowercase hex",
    "proofs": ["runner-qualified-node-id"],
    "expected_failure": "stable assertion/property fingerprint"
  }]
}
```

Semantic oracle independence, smallest boundary, and assertion quality remain
review responsibilities. The PR/agent report summarizes machine evidence but
is never its source. Policy self-tests inject a minimal violation for every
mechanical guard and prove the guard itself fails.

## Evidence schema

Write ignored `test-results/runs/<run_id>/summary.json`:

```json
{
  "version": 2,
  "run_id": "16 lowercase hex",
  "workflow": "pr",
  "git_sha": "full sha",
  "base_sha": "full sha or null",
  "status": "pass|fail|not_run",
  "duration_ms": 0,
  "peak_owned_mib": {
    "process_tree_rss": 0,
    "container_working_set": 0,
    "total": 0,
    "measurement_complete": true
  },
  "invocation": {
    "ui": false,
    "input_fingerprint": "sha256"
  },
  "selection": [{
    "path": "path",
    "capability": "service",
    "reason": "rule",
    "proof": "runner-qualified-node-id-or-null",
    "sensitivity_required": true,
    "deferred_to": "full-or-null"
  }],
  "sensitivity": [
    {
      "proof": "runner-qualified-node-id",
      "changed_paths": ["path"],
      "proof_digest": "sha256",
      "method": "base|fault",
      "against": {"git_sha": "sha-or-null", "fault_id": "id-or-null"},
      "red": {
        "status": "fail",
        "phase": "assertion|property",
        "failure_fingerprint": "stable redacted fingerprint"
      },
      "green": {"status": "pass", "git_sha": "full sha"}
    }
  ],
  "capabilities": [
    {
      "id": "service",
      "status": "pass|fail|not_run",
      "duration_ms": 0,
      "peak_owned_mib": 0,
      "provider_calls": 0,
      "estimated_cost_usd": 0,
      "artifacts": ["relative/path"],
      "detail": "redacted decisive diagnostic"
    }
  ]
}
```

A formal diagnostic replay writes a separate summary; it never rewrites the
first run:

```json
{
  "version": 2,
  "command": "diagnose",
  "run_id": "new 16-hex id",
  "workflow": "pr",
  "git_sha": "same full sha",
  "status": "fail",
  "invocation": {
    "ui": false,
    "input_fingerprint": "same sha256"
  },
  "diagnostic_of": {
    "run_id": "failed 16-hex id",
    "status": "fail",
    "summary": "test-results/runs/<failed-id>/summary.json"
  },
  "diagnostic_result": {
    "status": "pass|fail|not_run",
    "duration_ms": 0,
    "peak_owned_mib": {},
    "capabilities": []
  }
}
```

Redact environment and command values. Stream the first decisive failure
immediately. Preserve pytest output, browser trace/screenshot, process logs,
database/template identity, last job state, red/green sensitivity, explicit
diagnostic-rerun linkage, and provider usage only when applicable. A summary
with a diagnostic pass remains failed when its first run failed. The run
fingerprint includes outcome-affecting non-secret inputs and only presence for
secret inputs. A diagnostic claim is durably `started` before execution and
becomes `terminal` only after its linked summary exists.

## Production-isolation boundary

The harness accepts only resources derived from its recorded local runtime:

- `NEXUS_ENV` is exactly `test` for every owned process;
- PostgreSQL, MinIO, and Supabase endpoints are exact loopback/runtime-record
  endpoints; public hosts, hosted Supabase, TLS object-storage endpoints, and
  caller-supplied arbitrary endpoints are rejected before any client opens;
- Docker and Supabase CLI processes are pinned to a controller-verified local
  Unix-domain Docker socket; caller-selected remote hosts/contexts are rejected;
- databases are limited to `nexus_tpl_*`, `nexus_tpl_build_*`,
  `nexus_run_*`, and `nexus_migration_*` on the owned test PostgreSQL server;
- buckets are limited to `nexus-run-<run_id>` on the owned MinIO server;
- users carry the exact run id in both their test-only email and admin metadata;
- processes are started only after the run ledger records their exact command,
  repo id, run id, and planned resource identity; the controller records the
  process-group id before readiness can succeed.

Every resource is first persisted as a planned owned resource, then created,
then marked created. `clean` reads only those run ledgers and the validated
workspace runtime record. It revalidates endpoint, repo id, run id, type, and
test-only identity; deletes exact run resources; then stops the exact recorded
Supabase project and Compose project, removes their test-only volumes, and
deletes that runtime state. It never discovers targets by port, process name,
prefix alone, environment default, or broad database/bucket/user listing.
Independent teardown owners are all attempted; any failure preserves the
ledger and exact recovery path, and ownership state is removed only after all
teardown succeeds.

Standing negative proof supplies production-shaped URLs, names, and
environments and verifies rejection before network or subprocess activity.
Interruption proof terminates local database and journey runs, invokes `clean`,
and proves unrelated local/dev sentinel resources remain byte-for-byte and
identity-equal.

No restore capability belongs to this cutover. Migration and PostgreSQL/object
consistency remain owned by their existing migration and convergence
capabilities; production recovery remains a separate future operations project.

## Required contract amendments

The final public-cut commit leaves
`docs/local-rules/testing-standards.md` self-contained and updates it
explicitly:

- §3 and §16: name `prove` and the machine sensitivity object above;
- §6 and §12: zero automatic retries; one separately recorded diagnostic rerun
  cannot change the verdict;
- §7: add `confidence`, distinguish warm/cold targets, and make CI
  time/memory budgets measured ratchets rather than invented gates;
- §8: replace every Make target/marker row with the live `./scripts/test`
  routing table and separately owned deploy smokes;
- §9: record the final per-run clone, bucket, scenario-user, fixture, browser,
  corpus, and helper contracts;
- §11: own local test-runtime safety and state explicitly that production
  backup and disaster recovery are separately owned operations, not
  test-workflow prerequisites;
- §12: describe the actual pytest, spawned-worker, component-browser, and
  Playwright network boundaries; retain Python-warning and broken-link checks;
- §15: add `confidence` to the paved road;
- §16: define total owned memory/provider-cost fields and remove the
  selector-miss metric unless a real cross-run producer exists.

Keep the local rule complete and Nexus-specific. Do not reduce it on behalf of
the shared subtree.

Also update:

- `docs/local-rules/index.md` to the hyphenated local rule path;
- `docs/local-rules/codebase.md` from top-level `e2e/` to `apps/web/e2e/`;
- active README/architecture/Agency command tables and deploy-owned smoke paths;
- stale underscore-path links by mechanical path replacement only; do not
  semantically rewrite historical cutover decisions.

`docs/rules/` is a subtree mirror and MUST NOT be hand-edited here. Re-import
the shared `testing.md` and its index from `engineering-docs` through the normal
subtree pull. Do not rewrite or reduce the Nexus-specific local rule to match
that generic doctrine: `docs/local-rules/testing-standards.md` remains the sole
authority when the two differ. Acceptance scans active normative and executable
surfaces, not unscoped historical prose.

If the subtree pull reports that the unchanged upstream commit is already
present after a later local deletion, restore the missing path from that exact
subtree commit and verify it is byte-identical to the upstream blob. This is an
exact import repair, not a local semantic edit.

## Hard-cut files

Create/adapt:

- `scripts/test`, `scripts/agency_verify.sh`;
- `python/nexus_test_control/**`, its focused kernel tests, and
  `python/{pyproject.toml,uv.lock}`;
- `docker/docker-compose.test.yml`, `.gitignore`;
- `apps/web/{package.json,bun.lock,vitest.config.ts,eslint.config.mjs,next.config.ts}`;
- `apps/web/e2e/**`, compact frontend/Python testkits;
- `testdata/{manifest.json,proofs.json,faults/**,policy-exceptions.json}`;
- `.github/actions/setup-test/action.yml`;
- `.github/workflows/{ci,nightly,release}.yml`;
- `Makefile`, `agency.json`, `README.md`, `python/README.md`,
  `docs/architecture.md`,
  `docs/local-rules/{index,codebase,testing-standards}.md`;
- deploy-owned Playwright smoke paths in
  `deploy/smoke/auth-redirect-construction-smoke.sh` and stale top-level-E2E
  exclusions in `deploy/hetzner/deploy.sh`.

Workflow ownership is singular:

- `ci.yml` owns deterministic PR/push proof and no paid certification;
- `nightly.yml` owns audit, hosted canaries/evaluation, and the adapted existing
  Android emulator runner;
- protected manual `release.yml` owns provider certification, signed Android
  artifact verification, and optional tag-matched Android publication;
- replace `android-release.yml` by moving its signing/tag/publishing mechanics
  into `release.yml`; install the signed APK on a dedicated emulator placed in
  airplane mode, prove manifest/package-manager App Link routing and native auth
  handoff without production contact, then optionally publish that exact
  artifact; do not leave a second release owner;
- deployed auth smoke remains deploy-owned but consumes the one web Playwright
  package/config through a deployment-smoke project.

Delete after extracting reusable behavior:

- the top-level `e2e/` package and all shared `.auth`/`.seed` state;
- `scripts/{with_test_services,with_supabase_services,test_env}.sh`;
- old Make test/verify targets and underscored raw targets;
- old CI matrices, shards, repeated dependency/browser installs, and repeated
  Next builds;
- marker-routing code for `unit`, `integration`, `migration_ci_late`,
  `artifact`, `slow`, `supabase`, `network`, `real_media`, and `live_provider`,
  plus `python/tests/real_media/test_no_internal_mocks.py`;
- E2E-only global seed scripts and shared-user assumptions;
- every mock-heavy, sleep-based, duplicate, source-grep, cutover-negative,
  snapshot, framework, historical-migration, skipped, or low-value flaky proof;
- every production seam and helper reachable only from deleted tests.

Before deleting a named script/helper, re-run reference search outside docs and
prove it has no non-test owner. Preserve unrelated user work.

Do not perform a blind 681-file rename. Delete unneeded proof first, then move
and suffix only survivors. Merge the two Bun packages with one lockfile update
that keeps Playwright and `@vitest/browser-playwright` compatible; run install
and configuration proof before deleting the old lock/config. Strict CSP
violations exposed by removing the escape are separately scoped product defects
to repair before the public cut, not reasons to restore the escape.

## Implementation order

1. Record cold/warm duration, first-failure time, complete owned
   process/container memory, process/build/browser-install counts, and the
   current priority-risk map. These observations seed budgets; they are not
   promises manufactured before measurement.
2. Land small inert foundation commits on main when useful: typed control-plane
   internals, runtime primitives, schemas, and blocking policy self-tests. Do
   not add `scripts/test`, new CI routing, a second public harness, or a fallback
   portfolio yet.
3. From the first foundation commit, all newly authored proof follows the local
   standard. A new-path proof may land only when the current runner discovers
   it natively; otherwise keep it on the cutover branch. Rebase that branch
   daily and port every relevant main-branch product/test change into the
   replacement risk map.
4. Build the new service/component testkits, deterministic eval/extension
   capabilities, and 10–15 journeys from product contracts rather than legacy
   structure. Keep the existing public gate blocking during replacement.
5. Run machine sensitivity for every priority-risk replacement and every
   changed proof with a declared fault. Replay known regressions. Priority
   legacy proof remains blocking until its replacement passes the intended new
   gate.
6. Run the exact final `full` command locally, then once in a remote candidate
   branch using the exact final runner image/actions/workflow. A PR or manual
   branch trigger is acceptable; the requirement is the real final gate, not a
   particular GitHub event. This time-boxed rehearsal/comparison is allowed by
   the governing replacement policy.
7. Only after step 6 succeeds, delete legacy proof and its test-only
   seams/helpers, rerun `full`, and make policy green with an empty exception
   list.
8. In one public-cut commit, add `scripts/test`; switch Make, Agency, docs, and
   CI; migrate deploy smoke/release ownership; and delete every old public
   route, marker, E2E package, config, and lockfile.
9. Run acceptance below on the final state. Merge only that state.

No long-lived shadow CI, dual blocking gates, aliases, deprecation warnings,
compatibility wrappers, old marker support, or fallback to the legacy suite.
Foundation and candidate-rehearsal phases are time-boxed migration mechanics,
not supported compatibility modes.

## Acceptance criteria

- **AC1 — one API:** scoped search over `Makefile`, scripts, `agency.json`,
  `.github/`, active README/architecture/local-rule docs, and deploy smoke
  scripts finds no executable or instructive legacy test route. CI invokes only
  `./scripts/test`; the Agency adapter is one `exec` with no policy. Historical
  cutover prose is not an unscoped acceptance target, but broken moved-rule
  links are repaired.
- **AC2 — guard and proof sensitivity:** injected internal mock, sleep, external
  network, skip, automatic retry, excessive worker count, expired exception,
  risk-id deletion, doc drift, and fixture checksum fault each fail a standing
  `pr` policy self-test. A sensitivity-required changed proof without a valid
  executed-assertion red and current green sensitivity object fails `pr`;
  collection/build failure is rejected as evidence.
- **AC3 — reuse:** two consecutive workflows retain identical infrastructure
  container ids and browser install; the second creates no service stack.
- **AC4 — isolation:** every run gets a distinct database/bucket; every journey
  gets a distinct user/context; extension proof gets a distinct persistent
  user-data directory; randomized order twice produces the same result; no
  shared writable auth/seed file exists.
- **AC5 — interruption:** terminate a DB and a journey run; `clean` removes only
  their recorded processes, incomplete template build, databases, buckets,
  users, and locks; product/dev state remains untouched. Concurrent
  template-build/clone/drop attempts serialize and never expose a connectable
  partial template.
- **AC6 — resources:** no `-n auto`, shard, or automatic retry remains. The
  warm static/kernel `changed` fast path targets under 10 seconds and warm
  `confidence` targets 60–90 seconds; slower selected boundaries report their
  own duration instead of gaming those targets. Acceptance records cold/warm
  baselines, total owned process/container memory, and the resulting local/CI
  caps. The 8 GiB reference machine completes without OOM. CI p95 becomes a
  downward-only ratchet only after at least 20 comparable successful runs; it
  is not an initial acceptance fiction.
- **AC7 — build/browser:** one Next build and one Chromium installation at most
  per verification workflow; Playwright journey, extension, and deployment-smoke
  capabilities consume the same fingerprinted standalone artifact, while
  Vitest browser components retain their Vite component boundary; all journeys
  use strict CSP and no disable escape.
- **AC8 — portfolio:** every risk id in the in-scope typed floor has an
  independent, sensitive proof;
  the typed minimum risk floor cannot be lowered through `proofs.json`;
  journeys number 10–15 and include Nexus search/open; broader proof does not enumerate
  narrow variants; deterministic/hosted eval, extension, audit, and Android
  proof have explicit owners; no test-count or coverage quota is introduced.
- **AC9 — truthful cadence:** PR performs no hosted call; missing nightly or
  release requirements are `not_run` and fail the invoked workflow; nightly is
  not scheduled until its required environment is provisioned; release remains
  manual. A diagnostic rerun is separate and cannot change a first-run failure.
- **AC10 — production isolation:** production-shaped environment names,
  PostgreSQL URLs, Supabase URLs, object-store endpoints, Docker hosts/contexts,
  database names, bucket names, and user identities are rejected before
  network/process activity. All created resources were pre-recorded under the
  exact repo/run;
  interrupted-run cleanup deletes only those resources and leaves unrelated
  local/dev sentinels unchanged. No test workflow reads production
  credentials.
- **AC11 — cleanliness:** the top-level E2E package, old wrappers/configs/seed
  state, obsolete test helpers, legacy marker algebra, CSP escape, duplicate
  Bun/Playwright ownership, and test-only production seams are absent.
- **AC12 — final proof:** `changed`, `confidence`, `pr`, `full`, `doctor`,
  `prove`, policy self-tests, candidate-branch CI, and interrupted-run cleanup
  pass. Report nightly, hosted, device, signed release, and separately owned
  authorized deployment-smoke proof separately if not run; never collapse
  `not_run` into pass.
- **AC13 — governance:** the local rule contains the enumerated amendments and
  both local indexes/structure docs resolve. The shared generic testing
  contract/index is byte-identical to the current imported subtree source with
  no local semantic edit; the self-contained local rule remains authoritative
  and unchanged by that import.
- **AC14 — singular workflow ownership:** paid provider certification exists
  only in protected manual `release.yml`; Android signing/publication has one
  owner there; emulator proof has one nightly owner; deployed auth smoke still
  works through the consolidated web Playwright package.
- **AC15 — network and costs:** ordinary pytest and spawned-worker proof cannot
  reach external hosts; component-browser guards reject external application
  API calls without claiming full transport parity; Playwright aborts
  non-allowlisted requests. Hosted/evaluation capabilities stop at their
  declared call and estimated-cost ceilings and report actual use.

## Key decisions

- A compact typed orchestrator is cheaper and safer than Make/CI/shell
  duplication; Make remains for product build/run operations.
- Persistent processes plus disposable state give reuse without coupling.
- PostgreSQL template cloning is the 80/20 database reset; per-test containers
  are unnecessary.
- Directory/suffix classification replaces marker algebra.
- One Bun package and one Playwright config remove duplicate installs/builds.
- Zero automatic retries makes flakes visible; one explicit diagnostic rerun
  remains evidence of a failed first attempt.
- Machine-generated red/green sensitivity is the agent-proof gate; prose only
  explains it.
- Static selectors accelerate the inner loop; only `pr` and above claim
  complete deterministic confidence.
- Local heavy work stays sequential; CI uses only measured bounded parallelism
  and one shared standalone build artifact.
- Semantic oracle quality stays a review responsibility; syntax, isolation,
  routing, and evidence shape are mechanical.
- Test runtime validation fails before contact with any production-shaped
  endpoint; the ownership ledger is the sole cleanup authority.

Implementation facts:

- [`pytest-socket`](https://pypi.org/project/pytest-socket/) supports
  default-deny sockets with host and Unix-socket allowlists.
- [Vitest `related`](https://vitest.dev/guide/cli) selects tests through static
  imports and does not see dynamic imports; it is an accelerator, not a gate.
- [Playwright isolation](https://playwright.dev/docs/best-practices) requires
  independent browser/storage state; its
  [ESLint plugin](https://github.com/playwright-community/eslint-plugin-playwright)
  supplies the core wait/skip/assertion rules.
- [PostgreSQL template cloning](https://www.postgresql.org/docs/current/sql-createdatabase.html)
  requires no active connection to the source database.
