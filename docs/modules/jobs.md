# Background Jobs

## Scope

This module owns the durable background-job substrate: the Postgres queue
(`background_jobs`), the registry of job kinds, the two worker lanes, the claim
fence and liveness lease, the Heavy capacity lease, the bounded background child,
and the settlement that runs each kind's hooks. The channel wiring is described in
[architecture.md §7.3](../architecture.md#73-background-jobs--the-worker).

Backend owners: `python/nexus/jobs/` (`registry.py`, `queue.py`,
`process_executor.py`, `worker.py`, `dead_letters.py`), `apps/worker/main.py` and
`apps/worker/health.py`. Handlers and hooks live in their owning services. The
generation job envelope (`run_generation_job`) is owned by [llms.md](llms.md).

## Three facts

The queue is a ledger of attempts; every rule below follows from three facts.

1. **An attempt is its `execution_id`.** A claim mints it; only a reclaim
   replaces it. Every write on behalf of an attempt locks the row and requires
   `id = ? AND status = 'running' AND execution_id = ?` (`queue._OWNED`, the one
   fence text): `finish_job`, `fail_job`, `reschedule_running_job`,
   `update_running_job_payload` update through it, and an owner's effect
   transaction calls `lock_running_job_claim(db, context=...)` (returns the row, or
   `None` once the job was reclaimed). A late but unreclaimed attempt still writes;
   a reclaimed one writes nothing. `media_unit_build`'s head update carries the same
   predicate inline.
2. **A kind is one row of one table.** `registry()` maps each kind to a frozen
   `JobDefinition`: lane, `handler` (`module:fn`), `max_attempts`, `retry_delays`,
   `heavy`, `periodic_seconds`/`periodic_priority`, `keep_succeeded`/`keep_dead`,
   `parser_temp_key`, and the hook paths `on_failure`, `on_dead`, `on_history`.
   `enqueue_job` takes the budget from it (callers never pass one), `fail_job` the
   retry delay, the prune its retention, each lane its kinds.
3. **Hooks run where transitions commit.** A dead-letter or history reaction
   commits in the transition's transaction and never commits itself, so the
   queue transition invokes it. On the background lane that process is the lean
   supervisor sharing the 448 MiB cgroup with its child: a background kind's hook
   lives in an import-light module, and the worker refuses to start if the
   supervisor imported `boto3`, `httpx` or `lxml`.

## Kinds and lanes

| lane | kinds |
|---|---|
| interactive (in process) | `chat_run`, `dossier_build`, `enrich_metadata`, `oracle_reading_generate`, `podcast_sync_subscription_job` |
| background (one child per job) | `ingest_media_source`, `media_content_reindex_job` (both Heavy), `note_reindex_job`, `media_unit_build`, `connection_discovery_scan`, `suggestion_shortlist_refresh`, `podcast_backfill_subscription`, `media_teardown`, and the periodic `podcast_refresh_due_job`, `atlas_project_job`, `storage_orphan_sweep`, `empty_resource_cleanup` (weekly, resumable in 100-resource batches), `prune_background_jobs_job`, `purge_expired_auth_handoff_codes` |

A handler is `fn(*, payload, context) -> JobResult` in its owner:
`JobResult = Mapping | RescheduleRequested(at, payload?) | TerminalJobFailure | None`.
A mapping (or `None`) completes the job; `RescheduleRequested` returns it to
`pending` at `at` with the attempt refunded (and an optional new payload);
`TerminalJobFailure` makes it dead at once with its code and result. A raised
exception is a failed attempt: `process_executor.failure_of` classifies it once for
both lanes, an `ApiError` keeping its code (a `ResourceLimitError` its dimension),
anything else `E_WORKER_HANDLER_FAILED` with `"<Type>: <message>"`. An owner names
its expected failures as `ApiError`s: indexing raises
`E_EMBEDDING_PROVIDER_UNAVAILABLE` for an embedding provider that stayed
unavailable through its retries (`content_chunking.plan_chunks`), so the attempt
retries as a provider failure, not a defect.

`finish_job(db, context=..., result=...)` commits nothing. an owner whose
published facts require a terminal outcome calls it inside its publication
transaction: facts, outcome, released capacity and reactions become visible
together. mappings/none succeed; `TerminalJobFailure` makes the job dead. retry,
reschedule, reclaim and expiry reactions run at their queue transitions. payload
updates run no reaction. successful completion has no history reaction. the
worker retains failure normalization but owns no transition callbacks.

Hooks (by path in the registry):

- `on_failure(db, job) -> Mapping | None` runs under the claim before a failed
  attempt settles; a result means the owner's work already finished and the job
  completes with it. Source ingest's
  (`source_publication.on_failure`): a committed success of this job's
  latest attempt completes `{"kind": "SourceProjectionSucceeded"}`; an attempt that
  is not this job's or not the media's latest completes `{"status": "superseded"}`.
- `on_dead(db, job)` runs in the transaction that makes the job dead:
  `chat.worker.on_dead_letter` (ends the run `interrupted`, or `cancelled` when a
  stop was asked), `generation.ledger.on_dead_letter` (closes the open generation;
  dossier, metadata, oracle, connection scans),
  `podcasts.sync.dead_letter` (settles the sync Failed),
  `source_publication.on_dead_letter` (a resource-limited or podcast
  transcript attempt publishes its terminal failure), and the four statements in
  `jobs/dead_letters.py` whose owners are heavy (note index `failed` with the job's
  code, a dead `media_teardown`'s exact intent voided while its media lives, backfill
  failed at its step, and a media unit's open
  generation closed with the exact head it was building, by id and fingerprint,
  `failed` with the job's code: no reader ever sees a unit "suspended").
- `on_history(db, job, execution_id)` runs after each retry, dead, reclaim and
  reschedule: `import_history.on_source_job_outcome` and `on_index_job_outcome`.
  History is total (`queue_failure_code`), skips an attempt its owner already
  settled, and records nothing for deleted media.
  `suggestion_changes.on_suggestion_job_history` publishes an import-light wakeup for the
  [suggestions observer](suggestions.md); durable queue state remains truth.

Dead rows of `keep_dead` kinds are never pruned; the source import and the
search index repair theirs with `requeue_dead_job` (same row, fresh budget).

## The lease and the Heavy lease

The lease is liveness only: `LEASE_SECONDS = 30`, renewed every 5 s by the
worker's heartbeat thread (`renew_running_job_claim`), which also publishes lane
health. An expired lease lets any worker of the lane reclaim the row (spending an
attempt, stamping `E_WORKER_INTERRUPTED`) or, with the budget spent,
dead-letter it. A killed worker's job is therefore picked up about 30 s after its
last renewal; an idle worker's wait wakes at that instant. A heartbeat that finds
its claim no longer running stops renewal and sets `lost`, stopping the bounded
child. settlement first accepts a terminal row with the exact execution id, even
when the executor reports `Lost`; it never repeats reactions. a terminal row from
that execution also suppresses the reclaimed-claim warning.

Heavy kinds hold the one row `background_job_capacity_leases('Heavy')` (its
`job_id` and expiry) while running, so at most one Heavy attempt runs cluster-wide.
Lock order everywhere is the job row, then the capacity row; every transition out
of `running` frees it.

## The background child

`ChildExecutor.open` proves at start that the process's cgroup v2 has the memory
controller, `memory.max` exactly 448 MiB and `memory.oom.group = 0`. Each job runs
`python -m nexus.jobs.process_executor` in a new session with a request file, a
result file and a liveness pipe. The child arms `PR_SET_PDEATHSIG` (rechecking
`getppid`), kills its own group when the pipe closes, raises its `oom_score_adj`
to at least 750, configures logging (its lines reach the container log), runs the
handler and writes one result. The supervisor waits for it, its wall clock
(`BACKGROUND_PROCESS_WALL_TIMEOUT_SECONDS`), shutdown or a lost claim; TERMs and
then KILLs the group; and classifies: `Lost`, `Released` (shutdown: rescheduled
now, attempt refunded), `Failed(E_RESOURCE_LIMIT, Time)`, an `oom_kill` delta as
`Failed(E_RESOURCE_LIMIT, Memory)`, a crash or an empty or oversized result as
`Failed(E_WORKER_INTERRUPTED)`, else the decoded result. A resource failure is dead
at once with result `{"kind": "ResourceFailure", "dimension"}`. After an ingest
child the supervisor removes its `PARSER_TEMP_ROOT/<attempt_id>`; at start it
prunes roots no unfinished job owns, in a child with a 60 s wall.

## The worker

`apps/worker/main.py` runs one lane (`WORKER_LANE=interactive|background`):
SIGINT/SIGTERM set `stop`; it opens the executor (background), imports the lane's
hooks, refuses a heavy supervisor, waits until the database is at its image's
revision (readiness is proven once), then loops: enqueue each periodic kind's
current UTC slot (`periodic:<kind>:<slot start>`, `available_at` = slot start,
unique across workers), dead-letter one expired spent job or claim one due job
(`FOR UPDATE SKIP LOCKED`, order priority, due instant, `created_at`, `id`), run
it, and settle it with its hooks in one transaction. An idle worker LISTENs on
`nexus_background_jobs` and wakes for its own kinds, its next due row, or 5 s. A
database failure is logged and retried every 5 s; health goes stale meanwhile.

`apps/worker/health.py` (stdlib only) is the container healthcheck:
`python -S -m apps.worker.health --lane <lane>` exits 0 with
`{"status": "ready", "lane", "source_sha", "expected_database_revision"}` while the
lane's live process published a database-backed cycle in the last 20 s, else 1
with `{"status": "unavailable", "reason"}`. the heartbeat lives in the process's
temporary directory. a host lane and its health command share `TMPDIR`; the
disposable runtime assigns its host interactive lane a private directory.

The interactive lane does not observe SIGTERM inside a running handler
([ticket](../issues/interactive-worker-ignores-sigterm-mid-job.md)).

The oracle corpus seed (`python -m nexus.services.oracle.corpus seed`) only enqueues
ordinary ingest and reindex work for the background lane; it runs no jobs itself.

The Project Gutenberg catalog sync is not a job: an operator runs
`nexus sync-gutenberg-catalog` ([deployment.md](../../deployment.md#gutenberg-catalog-sync)).

There is no `contributor_reconciliation` job (or any other author-dedupe job):
author identity is resolved inline, synchronously, inside the ingest/enrichment
lane's own fresh SERIALIZABLE-retried transaction (`nexus.services.contributors`)
at the moment credits are written, not proposed to a queue and reconciled
later.

## Podcast Live Sync And Backfill

`podcast_sync_subscription_job` is the current-window live path (payload
`{subscription_id}`, no dedupe key). The subscription row is its
state: subscribe inserts it Pending with one job, and manual refresh and the due
sweep flip only terminal rows to Pending and enqueue one job per flipped row
under the row lock, joining live ones. The queue's single claim runs it; there is
no epoch, generation or attempt fence. The handler claims the row, fetches
provider/RSS facts outside any transaction, then commits ingest, auto-queue and
the settled status in one transaction that locks the row while it is still
Running (an overlapping stale run finds it settled and writes nothing). Provider
and feed failures settle Failed with backoff; unexpected defects use ordinary
queue retries, and exhausted retries invoke its `on_dead` hook (`sync.dead_letter`).
Results: `{status, inserted, skipped}` or `{status: Failed, error_code}` or
`{status: Stale}`.

`podcast_refresh_due_job` is a 15-minute background schedule that admits a
bounded oldest-due set. it is not a maintenance-only operation.

manual `POST /podcasts/refresh` returns 202 `{data:{requestedCount}}` after
admission commits. the count is selected subscriptions, including ones already
syncing, rather than newly created jobs or completed syncs. Podcast scope
requires the viewer's subscription; Library requires membership and selects its
placed shows, with Default selecting all the viewer's subscriptions. an empty
valid scope returns zero. there is no refresh-run ledger or per-request
progress/completion protocol. the browser [refresh owner](panes-tabs.md#refresh)
requests admission and reloads its own view; existing subscription lifecycle
streams observe later sync/backfill settlement independently.

`podcast_backfill_subscription` is a separate durable history traversal seeded
once by Subscribe. Each payload carries `backfillId` and `expectedStepNo`
(deduped per step). The handler fetches its page outside the DB transaction,
then locks the backfill row at the expected, non-terminal step, commits one
bounded batch, advances counters/cursor, and enqueues at most one successor in
that transaction. Removed subscriptions and already-applied steps terminate
without writes (`Stale`). A page that cannot be fetched or parsed raises, so
exhausted retries reach its `on_dead` reaction (`jobs/dead_letters.podcast_backfill`); the idempotent Retry
command replaces only a Failed backfill and starts one new step-zero chain.

Live and backlog failure are independent. Both persist episode identities,
metadata, chapters, playback URLs, and RSS transcript references only; neither
downloads enclosures or materializes transcripts.

## Transaction retries (`db/retries.py`)

`retry_serializable(db, label, op, *, retries=3)` and `retry_read_committed`
own every bounded transaction retry. Each attempt selects its isolation before
its transaction opens, runs `op`, and rolls back on any `Exception`. A
serialization failure or deadlock (40001, 40P01), a `TransactionRestart`, or a
violation of a name in `RETRYABLE_UNIQUE_CONSTRAINTS` (a first-sight race) runs
`op` again; the last such failure raises `DatabaseRetryExhaustedError`, which
the edge answers 500. Anything else propagates after the rollback. `op` must
reload its working rows and commit on each call. explicit row locks in note/page mutations and dossier
publication coordinate with read-committed retention cleanup; serializable
isolation alone does not serialize those writers with the collector. the retry
owner is used by bootstrap, identity writes, notes and dossier head/build
mutations.

## The generation envelope inside the worker

Every generation-capable job runs its body inside the shared `run_generation_job`
envelope (`services/generation/runtime.py`, [llms.md](llms.md)): one DB session,
one fresh event loop, one http client, and the tool, catalog and provider runtime
built on it. The queue contract stays the worker's: claim, lease, heartbeat and
settlement.

Every generation is one `generate` call: it writes one `llm_calls` row carrying
the job id, watches the owner's stop, the job claim and the operation deadline,
and returns a terminal value. Nothing is journaled in the job payload and nothing
replays: each attempt runs inside `run_generation_job`, which first closes its
job's open rows `interrupted` (only a dead attempt leaves one), so a retry after
a dead worker generates again from scratch (repaying the call). The `on_dead`
hook `generation.ledger.on_dead_letter` closes a dead job's open row
(`enrich_metadata`, `media_unit_build`, `oracle_reading_generate`,
`connection_discovery_scan`, `dossier_build`), and `revoke_jobs_by_dedupe_keys`
closes a revoked job's. The domain row of a dead background job is not touched by
that hook, except a media unit's (`dead_letters.media_unit_build` fails its head)
([ticket](../issues/dead-background-jobs-leave-domain-rows-pending.md)). A
background generation that never reached its model (a refused selection, a
Codex session that did not open, a turn Codex did not submit) raises
`RouteUnavailable` (`E_GENERATION_RUNTIME_UNAVAILABLE`) while its job has
attempts left, so the kind's retry backoff absorbs a Codex restart; the last
attempt settles the domain row `runtime_unavailable`.

Each task supplies only its operation, its owner, the intent it built, and a
decode that accepts or rejects the output. Model, effort, timeout and input bound
come from `services/generation/policy.py`.

metadata research uses an explicit requester and the generation owner's admitted
codex authority. its research prompt requests four read/search tools. see
[media metadata](media-metadata.md) for domain acceptance, date ownership and
source-only maintenance.

`dossier_build` is one generic kind for Media, Conversation, Library, Podcast,
Contributor, Page, Note, and internal Idea subjects; its payload is the build id.
One attempt (`services/dossier/run.py`) reads the active build, fails it
`InputsChanged` if the requester can no longer see the subject, then ensures
media intelligence (Media and the aggregates reschedule every 5 s while a
projection is pending), collects inputs (the Idea gathers research and
reschedules while a page ingests, at most 10 minutes per page), synthesizes, and
publishes or fails. A build that is no longer active makes the attempt a no-op. A
document that fails HTML acceptance or citation grounding is a modeled build
failure (the generation's decode rejection) the user regenerates from.

The synthesis outcome is `Published | Failed | Stopped`. A cancel or purge stops
the running generation through its stop poll. Stopped fails the build
`RuntimeUnavailable` unless a cancel or purge settled it first, so no active
build outlives its job. Idea research keeps its one billed call, the three web
searches, as `payload.web_picks`, so the build's reschedules never search again;
a crash before the picks are kept searches again. Nexus search reruns per
attempt and page acceptance is idempotent by key. Dead `dossier_build` rows are
never pruned.

`chat_run` runs its run's one generation and the final publication. An attempt
that finds its run's generation already started knows an earlier attempt died:
it fails the run `interrupted` (or `cancelled` when a stop was asked) and never
reruns it. A dead chat job ends its run the same way through its `on_dead` hook
(`chat.worker.on_dead_letter`); a cancel that finds the dead job ends the run
`cancelled`. That attempt starts about 30 s after a dead worker's last lease
renewal.
Dead chat jobs are retained; conversation teardown deletes the row.
