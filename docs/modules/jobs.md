# Background Jobs

## Scope

This module owns the durable background-job substrate: the Postgres-backed queue,
each worker process's claim/lease/heartbeat envelope, the registry of job kinds
and their policies, dead-lettering, and the production lane topology. The queue
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
with a terminal/retry transition. A Heavy heartbeat locks the exact job before
its capacity holder and renews both to one expiry in a queue-owned transaction;
every terminal or retry transition follows that same job-before-capacity order.
Claim is atomic (`FOR UPDATE SKIP LOCKED`), so
the worker is horizontally scalable even though one instance is
single-concurrency. The claim UPDATE also allocates the row's `execution_id`, a
non-resetting UUID that identifies exactly one attempt at running this job. It
is persisted on `background_jobs`, carried in `JobExecutionContext` and the
bounded-child protocol, and named by every history payload and source
publication fence, so a repaired or requeued job never reuses an execution
identity. Rows last claimed before migration 0227 have none, and history that
would name such an execution says so with an Absent value. The interactive and
background lane processes are the sole local execution-capacity owners. The
worker installs the process-global request rate and token-budget service at
startup (see [llms.md](llms.md)); there is no second anonymous per-user
in-flight counter.

The interactive lane dispatches in-process. The background lane instead runs every
handler in a fresh bounded child through `jobs/process_executor.py`
(`docs/cutovers/document-import-reliability-hard-cutover.md` §7): the supervisor keeps
the claim, heartbeat, Heavy-capacity lease, wall timeout, and terminal transition, and
never imports a parser, provider, or storage client.
For a `SourceAttemptMedia` resource terminal it preserves the queue/lease fence,
then delegates domain publication to the lightweight
`services/source_attempt_failures.py` owner. The supervisor does not mutate
source, Media, Podcast, transcript, quota, or collection tables itself.

Child lifetime is bound to supervisor lifetime three ways, so an abrupt supervisor
death cannot leave an orphan holding a live claim: a liveness pipe whose write end only
the supervisor holds (the portable mechanism, and the one that works on darwin dev),
`PR_SET_PDEATHSIG` armed in the child's own bootstrap on Linux with a `getppid` recheck
for the fork/exec window, and PID-namespace teardown in the deployed container, where
`worker-background` runs with `init: true`.

Shutdown is cooperative. One `threading.Event` per worker is set by SIGINT/SIGTERM
(`apps/worker/main.py:register_shutdown_signal_handlers`); the loop observes it between
jobs and `BackgroundProcessExecutor.execute` observes it while a child is running. On
shutdown the child gets the ordinary TERM-grace-then-KILL sequence and the job is
released straight back to `pending` without consuming a retry attempt, because the
interruption is explained by the operator and not by the job. The heartbeat thread sets
a second interrupt when it observes that the claim is gone; that child is terminated
too, and the job is deliberately not settled, because the worker no longer owns it.
`stop_grace_period: 30s` on the deployed service gives that sequence room.

## The registry (`jobs/registry.py`)

The registry is the source of truth mapping job kind → handler + policy. Each
kind is a frozen `JobDefinition`:

- `handler_path` — a thin `jobs/registry.py` adapter that hands the job's owned
  values to a `tasks/` wrapper. Simple carrier fields are parsed at this raw
  payload boundary; checkpoint-bearing tasks own their structured payload.
- `max_attempts`, `retry_delays_seconds`, `lease_seconds` — the per-kind retry
  and lease policy.
- `periodic_interval_seconds` — set only for scheduler-driven background or
  maintenance kinds.
- `periodic_priority` — routine scheduler rows use priority 200 so newly
  accepted ordinary work at priority 100 wins before the older periodic slot
  timestamp can break a tie. The stale-ingest reconciler is the sole urgent
  periodic exception at priority -1000. The priority is stamped when a slot is
  enqueued, so a change applies to newly scheduled slots only.
- `failed_result_statuses` — see the gotcha below.
- `dead_letter_projection` — a member of the closed `DeadLetterProjection` union
  applied once retries are exhausted; a projection may finalize domain state,
  project suspension, or only record safe diagnostics according to that kind's
  contract.
- `history_projection` — a member of the closed
  `"None" | "SourceAttempt" | "ContentIndex"` set naming which import-history
  rows a queue-envelope outcome records. `jobs/history_projections.py` applies
  it inside the same transaction that commits the queue transition, so an
  automatic retry, a dead-letter, a reclaimed expired lease, or a reschedule is
  recorded with the transition it documents. It is not part of the
  task-contract digest, and it never aborts a queue transition: its failure-code
  input is total.

`get_task_contract_digest()` is a stable SHA-256 fingerprint over the registry's
kind/attempts/delays/lease policy. API `/version` and each worker heartbeat expose
it for exact release proof. It changes only when that contract changes.

`oracle_reading_generate` has one canonical producer and one exact payload:
`{"reading_id": "<canonical-lowercase-uuid>"}`. Its registry adapter passes a
typed `UUID` to the Oracle task, which does not decode the durable carrier again.

### Lease policy by kind

The generation kinds use these exact renewable registry leases:
`enrich_metadata` and `synapse_scan`,
300s; `oracle_reading_generate` and `media_unit_build`, 450s;
`dossier_build`, 900s; and `chat_run`, 1,200s. The worker
renews its exact running claim before dispatch and throughout execution;
publication requires a live claim. These leases are not attempt deadlines.
A Codex MCP bearer expires at the earliest of the lease expiry observed when
it was issued, the admitted transport deadline, and the maximum grant lifetime.
Later queue heartbeats do not extend that bearer ([llms.md](llms.md)).

### Dead-lettering

Exhausted retries dead-letter the row. `jobs/dead_letter_projections.py` is the
single owner that applies a kind's repair inside the same transaction as the
terminal `dead` transition — that transition fires exactly once and has no
redrive, so the repair cannot be split across a process or transaction boundary.
The module imports only SQLAlchemy and `nexus.errors` at module scope, which is
what keeps the background supervisor free of parser, provider, and storage graphs
(`docs/cutovers/document-import-reliability-hard-cutover.md` §4.2.1). The three
background-lane projections are pure SQL in that module; the three interactive-lane
projections keep their existing owners and are imported inside their own branch,
which the background lane never reaches.

Five kinds declare a projection:

- `ChatRun` (`chat_run`) leaves the run, assistant message, and event stream
  nonterminal and records safe suspension diagnostics. It requeues only when
  cancellation was already requested, so the worker can publish the ordinary
  cancelled fold.
- `NoteContentIndex` (`note_reindex_job`) marks the note's content index `failed`
  so a stranded reindex is observable instead of stuck `pending`.
- `MediaTeardownIntent` (`media_teardown`) voids only the exact still-current
  teardown intent so a newer lifecycle cannot be overwritten.
- `PodcastBackfill` (`podcast_backfill_subscription`) stamps the current backfill
  fence Failed only when the dead job still names its exact backfill ID, step, and
  cursor digest; dead rows remain operator-visible.
- `PodcastSubscriptionSync` (`podcast_sync_subscription_job`) exact-matches
  subscription epoch, generation, job, and attempt before marking the subscription
  and every joined refresh item Failed.

Every other kind declares `"None"`; its failure is recorded on its own domain row.

### The `failed_result_statuses` gotcha

A handler that *returns* `{"status": "failed"}` still marks the **queue** row
succeeded unless its kind declares that status in `failed_result_statuses`.
`media_unit_build` declares it. For other ingest kinds the
failure is recorded on the domain row (e.g. `media`), and recovery relies on the
stale reconciler plus manual API retry, not queue-level retries. This is
deliberate: a handler that completed its work and recorded a domain failure has
not crashed, so re-running it would be wasteful.

Chat hard-cuts this generic convention at its task boundary:
`execute_chat_run` returns a closed `Published | Degraded | Failed | Cancelled |
Skipped` outcome, and `tasks/chat_run.py` is its sole plain-object serializer.
A handled `Failed` outcome completes the queue job because the domain run is
already terminal. Queue retry is reserved for an exception escaping that
boundary. The worker logs `worker_job_completed` with the serialized result
kind; queue completion is not a claim that the answer published.

## Worker lanes

`python/nexus/job_topology.py` declares one complete topology without importing
the application runtime graph:

- `INTERACTIVE_WORKER_JOB_KINDS`: chat, Dossier, metadata enrichment,
  subscription live sync, and Oracle generation;
- `BACKGROUND_WORKER_JOB_KINDS`: source ingest, content indexing, derived units,
  semantic indexing, subscription backfill, Podcast due admission and run
  retention, ambient generation, teardown, storage cleanup, reconciliation,
  queue pruning, and expired auth-handoff purge;
- `MAINTENANCE_JOB_KINDS`: Gutenberg catalog sync.

The two production lanes are non-empty, disjoint, and together equal
`PRODUCTION_ENABLED_JOB_KINDS`. Production plus the maintenance kinds equals the
complete registry. The worker entrypoint defects on drift.
Only the background lane can claim or schedule production periodic work.
Production deploys exactly `worker-interactive` and `worker-background`; there
is no undifferentiated `worker` service.

Every registry definition owns one closed `Light | Heavy` resource class, and
that class is part of the task-contract digest. `ingest_media_source` and
`media_content_reindex_job` are Heavy; all other kinds are Light. Queue-owned
capacity admission permits one Heavy running attempt
globally while leaving eligible Light work claimable. Domain handlers never
touch capacity state.

Metadata enrichment uses the interactive worker's live MCP registry and
listener, alongside Chat and Dossier. Its remote generation and scoped reads
do not occupy the parser capacity slot. It shares the interactive process's
memory boundary and serial job execution: an admitted metadata run can delay
Chat for its 300-second generation budget plus bounded setup and drain.

Normal workers require `WORKER_LANE=interactive|background`; they never accept
a raw allowlist. A bounded maintenance process requires
`WORKER_LANE=maintenance`, `NEXUS_ALLOW_WORKER_MAINTENANCE=1`, and an exact
non-empty `WORKER_ALLOWED_JOB_KINDS` subset of the maintenance declaration.
There is no deployed maintenance service.

Oracle reconcile is a bounded shared-image invocation, not a third lane. Its
`ORACLE_RECONCILE_JOB_KINDS` contract contains exactly `ingest_media_source` and
`media_content_reindex_job`. The operator reconciler claims only the job IDs it
created or resolved; it never scans or drains unrelated work.

There is no `contributor_reconciliation` job (or any other author-dedupe job):
author identity is resolved inline, synchronously, inside the ingest/enrichment
lane's own fresh SERIALIZABLE-retried transaction (`nexus.services.contributors`)
at the moment credits are written, not proposed to a queue and reconciled
later.

## Podcast Live Sync And Backfill

`podcast_sync_subscription_job` is the current-window live path. Subscribe,
OPML, scheduled due admission, and manual refresh use one generation-admission
primitive and the same per-subscription job. Its payload names subscription
epoch, viewer, Podcast, and generation; the handler also requires the exact
queue job/attempt lease. It fetches RSS once, persists a fenced ingest
checkpoint, and finishes auto-queue, subscription state, all joined refresh
items, parent aggregates, and collection revisions in a fresh SERIALIZABLE
transaction. Modeled failures are terminal domain results; unexpected defects
use ordinary queue retries, and exhausted retries invoke the exact dead-letter
finalizer.

`podcast_refresh_due_job` is a 15-minute background schedule that admits a
bounded oldest-due set and creates one refresh run per affected viewer. It is
not a maintenance-only operation.

`podcast_backfill_subscription` is a separate durable history traversal seeded
once by Subscribe. Each payload carries `backfillId` and `expectedStepNo`. The
handler fetches outside the DB transaction, renews the exact queue claim, locks
and revalidates the backfill/subscription fence, commits one bounded metadata
batch, advances counters/cursor, and enqueues at most one successor in that
transaction. Stale claims, removed subscriptions, and already-applied steps
terminate without writes. Future steps fail closed. Exhausted retries use the
dead-letter finalizer above; the explicit idempotent Retry command replaces only a current Failed
backfill and starts one new step-zero chain.

Live and backlog failure are independent. Both persist episode identities,
metadata, chapters, playback URLs, and RSS transcript references only; neither
downloads enclosures, queues historical episodes, or materializes transcripts.

## SERIALIZABLE retries (`db/retries.py`)

`retry_serializable(db, label, op, *, retries=3)` is the one owner of the
SERIALIZABLE-retry loop. It runs `op` under SERIALIZABLE isolation, rolls back
and retries on a serialization failure up to `retries` attempts, and re-raises
any other `OperationalError` immediately. `op` must reload its working rows and
commit on each call. There is no explicit row locking on top of SERIALIZABLE
(per [concurrency.md](../rules/concurrency.md)). It is adopted at every
SERIALIZABLE site, including the worker's scheduler loop, bootstrap, identity
writes, notes, and Dossier head/build/revision mutations.

## The Codex generation harness inside the worker

Every generation-capable job runs its body inside the shared `run_llm_task`
envelope ([llms.md](llms.md)), not a hand-rolled event loop. The envelope owns
only one DB session, one fresh event loop, and construction of the production
`CodexGenerationClient`. The queue contract stays inside the existing
claim/lease/heartbeat/dead-letter machinery.

Every generation goes through
`services/llm_execution.py:execute_generation`. That boundary preflights host
identity before dispatch is armed; stages the `llm_calls` start beside the
durable `Uncertain` checkpoint; streams one v2 generation; and stages the
terminal beside `Completed`. It owns capacity wait/reschedule, accepted-loss
uncertainty, replay, and the normalized failure boundary. This is the only
generation execution boundary, and jobs have no local retry policy.

Each task supplies only its stable operation identity, bounded intent, durable
owner/step identity, lease-fenced row-validation callback, and semantic result
decoder. Model, effort, capability, timeouts, and stream bounds come from
`generation_policy.py`. `enrich_metadata` now uses this same command, client,
journal, and `llm_calls` path.

metadata research uses the scoped `MetadataRead` plan and an explicit requester;
see [media metadata](media-metadata.md) for date ownership and maintenance.

`dossier_build` is one generic kind for Media, Conversation, Library, Podcast,
Contributor, Page, Note, and internal Idea subjects. Its immutable registration
selects one inseparable subject-policy and binding pair for collection, prompt,
operation, coverage, freshness, identity, and authorization. The Idea binding
receives one frozen HostTable operation whose sole grant is `web.search`; it
never inherits Chat's MCP catalog. Research tools remain domain-owned journal
steps and never become Codex built-ins; synthesis uses the fixed `Synthesis`
capability. Stored binding metadata owns its `BilledOnce` replay policy, so an
uncertain public-Web search is never automatically redispatched. Synthesis and
document repair remain suspended after an unresolved dispatch; a sealed
provider successor continuation permits safe resumption. Direct Nexus-search
and page accept/readiness/read observations are `ReDispatchable`, and pages
awaiting ingest yield the worker. The artifact head is the database
serialization point; the build is the replay identity. Build success, modeled
failure, and cancellation are terminal children, while exhausted or
unresolved execution remains a visible suspended build requiring incident repair.
Dead `dossier_build` rows are never pruned.

`services/durable_step_journal.py` owns the shared strict replay-state codec,
stable step identity, lease-fenced queue-payload checkpoint, and durable
execution-phase projection. `services/artifacts/generation_step.py` owns the
Dossier-specific generation request fingerprint, strict accepted/invalid result
envelope, and exact `Prepared | Uncertain | Completed` application for both
`synthesis` and `document-repair`. `services/artifacts/coordination.py` owns the
Dossier runtime capability and bounded research-yield behavior. The engine owns
the distinct streaming/cancellation and unary-repair transports; it does not
reimplement their journal protocol. Each binding materializes one fully compiled
`PublishableDossier`; `_DossierDocumentAcceptance` owns the single primary/repair
acceptance phase and its document-versus-citation failure precedence, so
`run_build` composes that phase instead of duplicating compilation branches.
`services/artifacts/registry.py` is the sole eight-scheme composition owner; it
constructs one cached immutable registration after module initialization, with
no mutable policy mirror, package re-export, or lazy fallback lookup.

`chat_run` uses that kernel for preparation, every generation/MCP tool turn,
and final publication. Dead chat jobs are retained because their payload is the in-flight
recovery record. Code defects retry without terminalizing `ChatRun`; exhausted
attempts project `Suspended`. Operator repair requeues the same row with a fresh
attempt budget while preserving its prior `error_code`; that queue history makes
both the repaired pending row and its first new claim project `Recovering`.
Cancellation uses the same requeue only to fold the requested terminal outcome,
conversation teardown deletes the row, and terminal folds clear coordination
before the worker returns.
