# Background Jobs

## Scope

This module owns the durable background-job substrate: the Postgres-backed queue,
the single-process worker's claim/lease/heartbeat envelope, the registry of job
kinds and their policies, dead-lettering, and the production lane topology. The queue
mechanics and channel wiring are described in
[architecture.md §7.3](../architecture.md#73-background-jobs--the-worker); this
doc owns the registry contract, the lane invariant, and how the LLM
generation harness composes with the worker. It does not restate the queue
internals.

Backend owners: `python/nexus/jobs/` (`queue.py`, `worker.py`, `registry.py`),
the thin task wrappers under `python/nexus/tasks/`, and
`python/nexus/db/retries.py`. The LLM task envelope (`run_llm_task`) is owned by
[llms.md](llms.md); deploy-time allowlist operations live in
[deployment.md](../../deployment.md).

## The worker envelope

Each single-process worker lane (`apps/worker/main.py` → `jobs/worker.py`) runs
a job loop and a scheduler loop. Each claimed job is leased, dispatched to its
registered handler under a heartbeat thread that renews the lease, and committed
with a terminal/retry transition. Claim is atomic (`FOR UPDATE SKIP LOCKED`), so
the worker is horizontally scalable even though one instance is
single-concurrency. The worker installs the process-global rate limiter at
startup (see [llms.md](llms.md)) so the first job of any kind has a working
limiter.

## The registry (`jobs/registry.py`)

The registry is the source of truth mapping job kind → handler + policy. Each
kind is a frozen `JobDefinition`:

- `handler` — a thin `tasks/` wrapper that parses the payload and calls a
  service.
- `max_attempts`, `retry_delays_seconds`, `lease_seconds` — the per-kind retry
  and lease policy.
- `periodic_interval_seconds` — set only for scheduler-driven background or
  maintenance kinds.
- `failed_result_statuses` — see the gotcha below.
- `dead_letter_handler` — the finalizer run once retries are exhausted.

`get_task_contract_version()` is a stable SHA-256 fingerprint over the registry's
kind/attempts/delays/lease policy, surfaced on `/health` for deploy contract
checks. It changes only when a policy changes (e.g. the oracle lease bump).

### Lease policy by kind

Leases are sized to the worst-case wall-clock of one attempt. Notably
`oracle_reading_generate` carries a **300s** lease — wide enough for retrieval
plus the structured synthesis call plus the one bounded repair round
([llms.md](llms.md)); chat and `dossier_build` sit at 900s; the rest default to
300s.

### Dead-lettering

Exhausted retries dead-letter the row. Four kinds register a finalizer:

- `chat_run` (`_dead_letter_chat_run`) writes an errored assistant message so the
  user sees a terminal failure.
- `note_reindex_job` (`_dead_letter_note_reindex`) marks the note's content index
  `failed` so a stranded reindex is observable instead of stuck `pending`.
- `dossier_build` (`_dead_letter_dossier_build`) preserves the active build and
  projects it as suspended; it does not invent a modeled Dossier failure or
  unlock another Generate.
- `media_teardown` (`_dead_letter_media_teardown`) voids only the exact
  still-current teardown intent so a newer lifecycle cannot be overwritten.

Other kinds have no finalizer; their failure is recorded on their own domain row.

### The `failed_result_statuses` gotcha

A handler that *returns* `{"status": "failed"}` still marks the **queue** row
succeeded unless its kind declares that status in `failed_result_statuses`. Only
`enrich_metadata` and `media_unit_build` declare it. For other ingest kinds the
failure is recorded on the domain row (e.g. `media`), and recovery relies on the
stale reconciler plus manual API retry, not queue-level retries. This is
deliberate: a handler that completed its work and recorded a domain failure has
not crashed, so re-running it would be wasteful.

## Worker lanes

`config.py` declares one complete topology:

- `INTERACTIVE_WORKER_JOB_KINDS`: ingest, chat, Dossier, subscription sync, and
  Oracle generation;
- `BACKGROUND_WORKER_JOB_KINDS`: content indexing, enrichment, derived units,
  semantic indexing, ambient generation, teardown, storage cleanup, and
  reconciliation;
- `MAINTENANCE_JOB_KINDS`: podcast polling, Gutenberg catalog sync, queue
  pruning, and expired auth-handoff purge.

The two production lanes are non-empty, disjoint, and together equal the
17-kind `PRODUCTION_ENABLED_JOB_KINDS`. Production plus the four maintenance
kinds equals the complete registry. The worker entrypoint defects on drift.
Only the background lane can claim or schedule production periodic work.

Normal workers require `WORKER_LANE=interactive|background`; they never accept
a raw allowlist. A bounded maintenance process requires
`WORKER_LANE=maintenance`, `NEXUS_ALLOW_WORKER_MAINTENANCE=1`, and an exact
non-empty `WORKER_ALLOWED_JOB_KINDS` subset of the maintenance declaration.
There is no deployed maintenance service.

The Oracle corpus seed drainer is a bounded shared-image invocation, not a
third lane. Its `ORACLE_SEED_WORKER_JOB_KINDS` contract contains exactly
`ingest_media_source` and `media_content_reindex_job`, so source success cannot
strand the reindex successor before the readiness assertion.

There is no `contributor_reconciliation` job (or any other author-dedupe job):
author identity is resolved inline, synchronously, inside the ingest/enrichment
lane's own fresh SERIALIZABLE-retried transaction (`nexus.services.contributors`)
at the moment credits are written, not proposed to a queue and reconciled
later.

## SERIALIZABLE retries (`db/retries.py`)

`retry_serializable(db, label, op, *, retries=3)` is the one owner of the
SERIALIZABLE-retry loop. It runs `op` under SERIALIZABLE isolation, rolls back
and retries on a serialization failure up to `retries` attempts, and re-raises
any other `OperationalError` immediately. `op` must reload its working rows and
commit on each call. There is no explicit row locking on top of SERIALIZABLE
(per [concurrency.md](../rules/concurrency.md)). It is adopted at every
SERIALIZABLE site, including the worker's scheduler loop, bootstrap, identity
writes, notes, and Dossier head/build/revision mutations.

## The LLM generation harness inside the worker

Seven LLM generation kinds — `chat_run`, `oracle_reading_generate`,
`dossier_build`, `media_unit_build`, `enrich_metadata`, `synapse_scan`, and
`dawn_write` — run their bodies inside
the shared `run_llm_task` envelope ([llms.md](llms.md)), not a hand-rolled
per-task event loop. `run_llm_task` owns only the worker mechanics: one DB
session, one fresh event loop, one shared `httpx.AsyncClient`, and one
`ExecutionRuntime` construction (production or the real-media fixture, keyed
solely on `settings.real_media_provider_fixtures`). The queue contract is
unchanged: the harness runs inside the existing claim/lease/heartbeat/
dead-letter machinery.

Every provider call inside a job goes through
`services/llm_execution.py:execute_generation` — the sole caller of both the
`ExecutionRuntime` seam and the `llm_calls` ledger — and reaches exactly one
terminal ledger outcome: success, a classified provider/transport failure, a
planning/budget denial, or a defect. A worker-boundary exception still leaves
a ledger row (or, for a denial before any row exists, a typed `ApiError`) plus
`error_code`/`error_origin` on the run parent, so the operator can always
answer "what failed". See [llms.md](llms.md) for the full execution order and
the profile each kind resolves against (`fast` for Oracle/Synapse/media
summary/metadata enrichment; binding-owned policy selects `fast` or `balanced`
for the seven Dossier operations; `balanced` for Dawn Write; chat alone is
user-selected).

`dossier_build` is one generic kind for Media, Conversation, Library, Podcast,
Contributor, Page, and Note. Its binding registry selects collection, prompt,
operation/profile, coverage, and freshness policy. The artifact head is the
database serialization point; the build is the replay identity. Build success,
modeled failure, and cancellation are terminal children, while exhausted or
unreconciled execution remains a visible, operator-repairable suspended build.
Dead `dossier_build` rows are never pruned.
