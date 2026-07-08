# Background Jobs

## Scope

This module owns the durable background-job substrate: the Postgres-backed queue,
the single-process worker's claim/lease/heartbeat envelope, the registry of job
kinds and their policies, dead-lettering, and the production allowlist. The queue
mechanics and channel wiring are described in
[architecture.md §7.3](../architecture.md#73-background-jobs--the-worker); this
doc owns the registry contract, the allowlist invariant, and how the LLM
generation harness composes with the worker. It does not restate the queue
internals.

Backend owners: `python/nexus/jobs/` (`queue.py`, `worker.py`, `registry.py`),
the thin task wrappers under `python/nexus/tasks/`, and
`python/nexus/db/retries.py`. The LLM task envelope (`run_llm_task`) is owned by
[llms.md](llms.md); deploy-time allowlist operations live in
[deployment.md](../../deployment.md).

## The worker envelope

The single-process worker (`apps/worker/main.py` → `jobs/worker.py`) runs a job
loop and a scheduler loop. Each claimed job is leased, dispatched to its
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
- `periodic_interval_seconds` — set only for scheduler-driven maintenance kinds.
- `failed_result_statuses` — see the gotcha below.
- `dead_letter_handler` — the finalizer run once retries are exhausted.

`get_task_contract_version()` is a stable SHA-256 fingerprint over the registry's
kind/attempts/delays/lease policy, surfaced on `/health` for deploy contract
checks. It changes only when a policy changes (e.g. the oracle lease bump).

### Lease policy by kind

Leases are sized to the worst-case wall-clock of one attempt. Notably
`oracle_reading_generate` carries a **300s** lease — wide enough for retrieval
plus the structured synthesis call plus the one bounded repair round
([llms.md](llms.md)); chat and the LI generate sit at 900s; the rest default to
300s.

### Dead-lettering

Exhausted retries dead-letter the row. Two kinds register a finalizer:

- `chat_run` (`_dead_letter_chat_run`) writes an errored assistant message so the
  user sees a terminal failure.
- `note_reindex_job` (`_dead_letter_note_reindex`) marks the note's content index
  `failed` so a stranded reindex is observable instead of stuck `pending`.

Other kinds have no finalizer; their failure is recorded on their own domain row.

### The `failed_result_statuses` gotcha

A handler that *returns* `{"status": "failed"}` still marks the **queue** row
succeeded unless its kind declares that status in `failed_result_statuses`. Only
`enrich_metadata` and `media_unit_build` declare it. For other ingest kinds the
failure is recorded on the domain row (e.g. `media`), and recovery relies on the
stale reconciler plus manual API retry, not queue-level retries. This is
deliberate: a handler that completed its work and recorded a domain failure has
not crashed, so re-running it would be wasteful.

## The allowlist invariant (`note_reindex_job` incident class)

The production worker only claims kinds in `WORKER_ALLOWED_JOB_KINDS`. A kind
that is registered (with a dead-letter handler, even) but absent from the
allowlist strands every job of that kind forever — the bug that left prod
note edits unsearchable.

`USER_FACING_JOB_KINDS` (in `registry.py`) is the tuple of every non-periodic
kind whose work a user directly observes. Tests assert the default allowlist is a
subset of the runtime registry and that
`USER_FACING_JOB_KINDS ⊆ DEFAULT_WORKER_ALLOWED_JOB_KINDS`, so the class of bug
becomes unrepresentable: adding a user-facing kind without allowlisting it fails
CI, and a typo in the default allowlist fails before a worker can start. The
allowlist literal still lives in runtime/env owners (`config.py`,
`deploy/env/env-prod-worker*`, and `sync-env.sh`); tests read those owners rather
than copy the literal again.

`contributor_reconciliation` is user-facing because it materializes duplicate
author proposals the user can accept or reject in the author surface. Source
ingest, metadata enrichment, podcast identity writes, and podcast episode syncs
enqueue it after contributor-credit writes so the proposal table follows the
authority file instead of becoming a separate dedupe system.

## SERIALIZABLE retries (`db/retries.py`)

`retry_serializable(db, label, op, *, retries=3)` is the one owner of the
SERIALIZABLE-retry loop. It runs `op` under SERIALIZABLE isolation, rolls back
and retries on a serialization failure up to `retries` attempts, and re-raises
any other `OperationalError` immediately. `op` must reload its working rows and
commit on each call. There is no explicit row locking on top of SERIALIZABLE
(per [concurrency.md](../rules/concurrency.md)). It is adopted at every
SERIALIZABLE site, including the worker's scheduler loop, bootstrap, identity
writes, notes, and the LI generate/promote transactions.

## The LLM generation harness inside the worker

The six LLM generation kinds (`chat_run`, `oracle_reading_generate`,
`library_intelligence_artifact_generate`, `media_unit_build`, `enrich_metadata`,
`synapse_scan`)
run their bodies inside the shared `run_llm_task` envelope ([llms.md](llms.md)),
not a hand-rolled per-task event loop. The queue contract is unchanged: the
harness runs inside the existing claim/lease/heartbeat/dead-letter machinery and
owns only the LLM mechanics (session, loop, client, router, ledger). Every
provider call inside a job leaves an `llm_calls` row; a worker-boundary exception
still leaves a row plus an `error_detail` on the run parent
([llms.md](llms.md)), so the operator can always answer "what failed".
