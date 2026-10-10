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
the task handlers under `python/nexus/tasks/`, and
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
(`docs/cutovers/document-import-reliability-hard-cutover.md` §7 at `ebd648197`): the supervisor keeps
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

- `handler_path` — either a `tasks/` handler that already takes
  `(payload, context)` and owns its structured payload, or a `_run_*` adapter in
  `jobs/registry.py` that parses simple carrier fields at this raw payload
  boundary and calls the owning service (or task) directly.
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
- `never_prune_dead`, `never_prune_succeeded` — terminal retention policy.
  metadata retains both states so an older failure cannot become latest after
  ordinary success pruning; it uses existing jobs as its inspectable history.
- `dead_letter_projection` — a member of the closed `DeadLetterProjection` union
  applied once retries are exhausted; a projection may finalize domain state,
  project suspension, or only record safe diagnostics according to that kind's
  contract.
- `history_projection` — a member of the closed
  `"None" | "SourceAttempt" | "ContentIndex"` set naming which import-history
  rows a queue-envelope outcome records. `jobs/history_projections.py` applies
  it inside the same transaction that commits the queue transition, so an
  automatic retry, a dead-letter, a reclaimed expired lease, or a reschedule is
  recorded with the transition it documents. It never aborts a queue
  transition: its failure-code input is total.

`oracle_reading_generate` has one canonical producer and one exact payload:
`{"reading_id": "<canonical-lowercase-uuid>"}`. Its registry adapter passes a
typed `UUID` to `services/oracle/readings.run_reading_job`.

`connection_discovery_scan` has no `tasks/` wrapper: its adapter hands the payload
`{user_id, ref, reason}` to `services/connection_discovery.py:connection_discovery_scan_job`, which runs
the scan inside `run_llm_task` and returns `{status, error_code, ref}`. it
declares no `failed_result_statuses`; a terminal model failure is a succeeded
row whose result status is `terminal_failed` ([connections.md](connections.md)).

### Lease policy by kind

The generation kinds use these exact renewable registry leases:
`enrich_metadata` and `connection_discovery_scan`,
300s; `oracle_reading_generate` and `media_unit_build`, 450s;
`dossier_build`, 900s; and `chat_run`, 1,200s. The worker
renews its exact running claim before dispatch and throughout execution;
publication requires a live claim. These leases are not attempt deadlines.
Provider API tool positions remain bound to the running generation claim;
queue heartbeats do not widen their frozen authority ([llms.md](llms.md)).

### Dead-lettering

Exhausted retries dead-letter the row. `jobs/dead_letter_projections.py` is the
single owner that applies a kind's repair inside the same transaction as the
terminal `dead` transition — that transition fires exactly once and has no
redrive, so the repair cannot be split across a process or transaction boundary.
The module imports only SQLAlchemy and `nexus.errors` at module scope, which is
what keeps the background supervisor free of parser, provider, and storage graphs
(`docs/cutovers/document-import-reliability-hard-cutover.md` §4.2.1 at `ebd648197`). The three
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
  Failed.

every other kind declares `"None"`; its owner records the failure on its domain
row or in its retained job outcome.

### The `failed_result_statuses` gotcha

A handler that *returns* `{"status": "failed"}` still marks the **queue** row
succeeded unless its kind declares that status in `failed_result_statuses`.
`media_unit_build` declares it. For other ingest kinds the
failure is recorded on the domain row (e.g. `media`), and recovery relies on the
stale reconciler plus manual API retry, not queue-level retries. This is
deliberate: a handler that completed its work and recorded a domain failure has
not crashed, so re-running it would be wasteful.

metadata instead returns `TerminalJobFailure(result_payload, error_code,
error_message)` for a known unsuccessful result. the worker recognizes it before
mapping conversion, calls `fail_job(force_dead=True)` under the live claim and
runs the ordinary history/dead-letter hooks once. the bounded-child protocol
preserves the same result. no-findings, invalid output and terminal research
failures therefore settle `dead` without retrying a completed provider call.
accepted findings settle `succeeded`; known retryable pre-submission failures and
waits retain ordinary queue semantics. provider success is not domain success.
see [media-metadata.md](media-metadata.md).

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

Every registry definition owns one closed `Light | Heavy` resource class.
`ingest_media_source` and
`media_content_reindex_job` are Heavy; all other kinds are Light. Queue-owned
capacity admission permits one Heavy running attempt
globally while leaving eligible Light work claimable. Domain handlers never
touch capacity state.

Metadata enrichment runs in the interactive worker alongside Chat and Dossier.
its remote generation and generation-owner tools do not occupy the parser capacity slot
once an eligible route is approved. It shares the interactive process's
memory boundary and serial job execution: an admitted metadata run can delay
Chat for its 300-second generation budget plus bounded setup and drain.

Normal workers require `WORKER_LANE=interactive|background`; they never accept
a raw allowlist. A bounded maintenance process requires
`WORKER_LANE=maintenance`, `NEXUS_ALLOW_WORKER_MAINTENANCE=1`, and an exact
non-empty `WORKER_ALLOWED_JOB_KINDS` subset of the maintenance declaration.
There is no deployed maintenance service.

The oracle corpus seed (`python -m nexus.services.oracle.corpus seed`) only enqueues
ordinary ingest and reindex work for the background lane; it runs no jobs itself.

There is no `contributor_reconciliation` job (or any other author-dedupe job):
author identity is resolved inline, synchronously, inside the ingest/enrichment
lane's own fresh SERIALIZABLE-retried transaction (`nexus.services.contributors`)
at the moment credits are written, not proposed to a queue and reconciled
later.

## Podcast Live Sync And Backfill

`podcast_sync_subscription_job` is the current-window live path. subscribe,
scheduled due admission, and manual refresh use one generation-admission
primitive and the same per-subscription job. Its payload names subscription
epoch, viewer, Podcast, and generation; the handler also requires the exact
queue job/attempt lease. it fetches provider/RSS facts outside the database
transaction, then commits lease-fenced ingest, auto-queue, subscription state
and collection revisions together. modeled failures are terminal domain results;
unexpected defects
use ordinary queue retries, and exhausted retries invoke the exact dead-letter
finalizer.

`podcast_refresh_due_job` is a 15-minute background schedule that admits a
bounded oldest-due set. it is not a maintenance-only operation.

manual `POST /podcasts/refresh` returns 202 `{data:{requestedCount}}` after
queue/subscription admission commits. the count is selected subscriptions,
including active-generation joins, rather than newly created jobs or completed
syncs. Podcast scope requires the viewer's subscription; Library requires
membership and selects its placed shows, with Default selecting all the viewer's
subscriptions. an empty valid scope returns zero. admission joins/promotes an
active generation or opens one Pending generation with one deduped job.
there is no refresh-run ledger or per-request progress/completion protocol.
the browser [refresh owner](panes-tabs.md#refresh) requests admission and reloads
its own view; existing subscription lifecycle streams observe later sync/backfill
settlement independently.

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
writes, notes, and Dossier head/build mutations.

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

metadata research uses an explicit requester and the generation owner's admitted
codex authority. its research prompt requests four read/search tools; prompt
instructions do not narrow the current account-wide codex shell grant. see
[media metadata](media-metadata.md) for domain acceptance, date ownership and
source-only maintenance.

`dossier_build` is one generic kind for Media, Conversation, Library, Podcast,
Contributor, Page, Note, and internal Idea subjects; its payload is the build id.
One attempt (`services/dossier/run.py`) reads the active build, fails it
`InputsChanged` if the requester can no longer see the subject, then replays a
Completed `synthesis` step or runs: ensure media intelligence (Media and the
aggregates reschedule every 5 s while a projection is pending), collect inputs
(the Idea gathers research and reschedules while a page ingests, at most 10
minutes per page), synthesize, publish or fail. A build that is no longer
active makes the attempt a no-op. A document that fails HTML acceptance or
citation grounding is a modeled build failure the user regenerates from.

The `synthesis` step is the shared generation journal
(`services/durable_step_journal.py` codec, `llm_execution` admission and
execution); its Completed memo is the dossier's `Published | Failed | Stopped`
outcome. Stopped fails the build `RuntimeUnavailable` unless a cancel or purge
settled it first, so no active build outlives its job. An Uncertain step without the native host's recovery evidence is never
dispatched again: the attempt raises, the job dead-letters, and the build reads
Suspended until cancelled or purged. Idea research journals only `research/web`
(Uncertain, three searches, Completed with the picks), the one billed call;
Uncertain on entry is never searched again. Nexus search reruns per attempt and
page acceptance is idempotent by key. Dead `dossier_build` rows are never pruned.

`chat_run` uses that kernel for preparation, every generation and API tool turn,
and final publication. Dead chat jobs are retained because their payload is the in-flight
recovery record. Code defects retry without terminalizing `ChatRun`; exhausted
attempts project `Suspended`. Operator repair requeues the same row with a fresh
attempt budget while preserving its prior `error_code`; that queue history makes
both the repaired pending row and its first new claim project `Recovering`.
Cancellation uses the same requeue only to fold the requested terminal outcome,
conversation teardown deletes the row, and terminal folds clear coordination
before the worker returns.
