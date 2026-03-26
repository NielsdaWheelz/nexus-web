# Background Jobs Refactor - Postgres Queue Spec + PR Plan

## Goal

Refactor durable background work from Celery + Redis + beat to an app-owned Postgres queue with one small worker loop.

Final desired topology:

- one API
- one Postgres database
- one worker
- no Celery
- no beat
- no Redis

This is a low-scale personal app. The target architecture should therefore optimize for:

- clarity over abstraction
- explicit state over framework magic
- easy debugging over cleverness
- small operational surface area over horizontal scalability

## Why This Refactor Exists

The current background-job stack is heavier than the app needs:

- Celery introduces a broker, worker process model, task decorators, routing, and beat scheduling.
- Redis is used as both broker and result backend, even though the repo does not meaningfully consume Celery results.
- Beat exists only to schedule a small number of periodic jobs.
- Queue transport concerns leak into domain code through direct `apply_async()` calls.
- The app pays operational complexity for infrastructure whose only job is to move work between Python processes.

For a personal app with modest traffic and modest row counts, this is the wrong tradeoff.

The replacement should be boring:

- write job rows into Postgres in the same transaction as domain state
- have one worker claim and run due jobs
- persist explicit retry, lease, and failure state in Postgres
- schedule periodic jobs with one tiny loop in the worker

## Scope

This refactor covers all durable background work currently routed through Celery:

- `ingest_web_article`
- `ingest_epub`
- `ingest_pdf`
- `ingest_youtube_video`
- `enrich_metadata`
- `podcast_sync_subscription_job`
- `podcast_transcribe_episode_job`
- `podcast_reindex_semantic_job`
- `podcast_active_subscription_poll_job`
- `reconcile_stale_ingest_media_job`
- `backfill_default_library_closure_job`

This refactor also covers:

- removal of Celery worker/beat infrastructure
- replacement of periodic scheduling currently handled by beat
- deploy/dev/docs/test updates
- final removal of Redis-backed stream/rate-limit support so the app truly runs on one DB

## Non-Goals

- do not redesign EPUB/PDF/web/podcast business logic
- do not introduce `pgmq`
- do not introduce `pg_cron` in the initial refactor
- do not add multi-worker orchestration features unless they are required for correctness
- do not do a big-bang rewrite of unrelated ingestion logic
- do not keep compatibility layers for Celery, beat, or Redis once the cutover lands

## Final Product Posture

The end state should feel like this:

1. API request writes domain state.
2. API request writes one or more job rows in the same DB transaction.
3. Worker polls Postgres, claims one due job, runs a plain Python handler, and writes final state back to Postgres.
4. Worker also runs a tiny scheduler loop for periodic jobs.
5. There is no broker, no beat, no result backend, and no hidden retry logic outside Postgres rows.

## Non-Negotiable Invariants

- Durable jobs must be stored in Postgres.
- Enqueue must be transactional with domain writes when correctness depends on both succeeding together.
- Job state must be explicit and queryable from SQL.
- Every job handler must be idempotent or guarded by domain state so retries are safe.
- Worker crash must not silently lose jobs.
- Long-running jobs must be reclaimable after lease expiry.
- Periodic jobs must not require a separate beat process.
- Once the Postgres queue is live, no production path may dual-write to Celery or fall back to Celery.
- The merged end state must not keep deprecated transport compatibility code.
- Do not scatter raw queue SQL across the codebase. All enqueue/claim/complete/fail behavior must go through one queue service.
- Do not let transport concerns rewrite domain logic. Existing service functions should remain the source of truth.

## Architecture

### Components

The new system has four parts:

1. `background_jobs` table
   - the durable source of truth for queued/running/completed work

2. Queue service
   - central helpers for enqueue, claim, heartbeat, complete, fail, retry

3. Job registry
   - single source of truth for supported job kinds, retry policy, lease policy, and periodic schedule metadata

4. Worker process
   - one small loop that polls Postgres for due jobs and executes handlers
   - one small scheduler loop that enqueues periodic jobs

### Background Job Table

Create one durable table named `background_jobs`.

Minimum schema:

- `id uuid primary key`
- `kind text not null`
- `payload jsonb not null default '{}'::jsonb`
- `status text not null`
  - allowed values: `pending`, `running`, `succeeded`, `failed`, `dead`
- `priority integer not null default 100`
- `attempts integer not null default 0`
- `max_attempts integer not null default 3`
- `available_at timestamptz not null default now()`
- `lease_expires_at timestamptz null`
- `claimed_by text null`
- `dedupe_key text null`
- `error_code text null`
- `last_error text null`
- `result jsonb null`
- `started_at timestamptz null`
- `finished_at timestamptz null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Required indexes:

- index on `(status, available_at, priority, created_at)`
- index on `(kind, status, available_at)`
- unique index on `dedupe_key` where `dedupe_key is not null`
- index on `lease_expires_at` for stale-running reclaim

Table semantics:

- `pending`: job is eligible to be claimed when `available_at <= now()`
- `running`: worker has claimed it and must renew the lease while executing
- `succeeded`: terminal success
- `failed`: retryable failure parked between attempts
- `dead`: terminal failure after max attempts

### Queue Service Contract

Add one central queue module. Suggested location:

- `python/nexus/jobs/queue.py`

This module owns:

- `enqueue_job(...)`
- `enqueue_unique_job(...)`
- `claim_next_job(...)`
- `heartbeat_job(...)`
- `complete_job(...)`
- `fail_job(...)`
- `requeue_job(...)`

Rules:

- no call site should write directly to `background_jobs`
- `enqueue_job(...)` should accept an existing DB session and must not force its own commit by default
- if a job must be inserted in the same transaction as a media state transition, the caller must use the same DB session and commit once

### Job Registry

Add one central registry module. Suggested location:

- `python/nexus/jobs/registry.py`

This module replaces the role currently played by `python/nexus/celery_contract.py`.

Each registered job kind should declare:

- `kind`
- handler function
- default `max_attempts`
- retry delays
- lease duration
- whether it is periodic
- periodic interval if applicable

No backward compatibility is required. Even so, avoid gratuitous renames during the transport swap. Rename job kinds only when the rename materially improves clarity.

### Worker Loop

Add one worker module. Suggested location:

- `python/nexus/jobs/worker.py`

Worker behavior:

1. poll Postgres for one claimable job
2. atomically mark it `running`
3. start a small lease-renewer thread
4. execute the plain Python handler
5. mark the job `succeeded` or `failed`/`dead`
6. stop the lease-renewer
7. repeat

Use concurrency `1` by default.

That is enough for this app.

Do not add a thread pool or process pool in the initial refactor.

### Claim Semantics

Claiming must be explicit and SQL-driven.

Use one `WITH ... FOR UPDATE SKIP LOCKED` claim query so only one worker can claim a job row at a time.

The claim query must allow two categories:

- due `pending` jobs
- stale `running` jobs whose `lease_expires_at < now()`

Suggested ordering:

- lowest `priority`
- earliest `available_at`
- earliest `created_at`

Suggested claim update behavior:

- set `status='running'`
- increment `attempts`
- set `claimed_by`
- set `started_at = coalesce(started_at, now())`
- set `lease_expires_at = now() + lease_duration`
- set `updated_at = now()`

### Lease and Heartbeat

Use leases because some jobs are long-running and the worker may crash.

Rules:

- every running job has a lease expiry
- the worker renews the lease on a fixed interval while the handler runs
- if the worker dies, the lease expires and the job becomes reclaimable

Keep this simple:

- default lease duration: 5 minutes
- renew every 60 seconds
- allow job definitions to override lease duration for obviously longer jobs

Use a generic lease-renewer owned by the worker. Do not make each handler remember to heartbeat manually.

### Retry Semantics

Retries must be explicit.

Each job definition should include:

- `max_attempts`
- `retry_delays`

On handler failure:

- if `attempts < max_attempts`
  - set `status='failed'`
  - set `available_at = now() + retry_delay`
  - clear `lease_expires_at`
- else
  - set `status='dead'`
  - set `finished_at`

Do not hide retries in the worker loop.
Do not rely on exception decorators.
Do not rely on broker visibility timeout semantics.

### Periodic Jobs

The worker should also run a scheduler loop.

Do not add `pg_cron` in the first refactor.
Do not keep beat.

The scheduler loop should run every 30 seconds and call one function such as:

- `maybe_enqueue_periodic_jobs(db)`

Periodic jobs in scope:

- `podcast_active_subscription_poll_job`
- `reconcile_stale_ingest_media_job`

To avoid duplicate periodic rows across restarts, enqueue with deterministic dedupe keys:

- `periodic:podcast_active_subscription_poll_job:<slot_start>`
- `periodic:reconcile_stale_ingest_media_job:<slot_start>`

Where `slot_start` is the schedule bucket start timestamp.

This is simple, durable, and easy to reason about.

### Polling Strategy

Use plain polling first.

Suggested defaults:

- job poll interval when idle: 2 seconds
- scheduler loop interval: 30 seconds

For this app, plain polling is acceptable and easier to debug than `LISTEN/NOTIFY`.

If later job latency becomes a problem, `LISTEN/NOTIFY` can be added as an optimization. It is not required for correctness and should not be in the first implementation.

## Job Kind Mapping

Use this mapping in the registry.

| Current Celery task | New job kind | Payload |
|---|---|---|
| `ingest_web_article` | `ingest_web_article` | `media_id`, `actor_user_id`, `request_id` |
| `ingest_epub` | `ingest_epub` | `media_id`, `request_id` |
| `ingest_pdf` | `ingest_pdf` | `media_id`, `request_id`, `embedding_only` |
| `ingest_youtube_video` | `ingest_youtube_video` | `media_id`, `actor_user_id`, `request_id` |
| `enrich_metadata` | `enrich_metadata` | `media_id`, `request_id` |
| `podcast_sync_subscription_job` | `podcast_sync_subscription_job` | `user_id`, `podcast_id`, `request_id` |
| `podcast_transcribe_episode_job` | `podcast_transcribe_episode_job` | `media_id`, `requested_by_user_id`, `request_id` |
| `podcast_reindex_semantic_job` | `podcast_reindex_semantic_job` | `media_id`, `requested_by_user_id`, `request_reason`, `request_id` |
| `podcast_active_subscription_poll_job` | `podcast_active_subscription_poll_job` | `request_id` |
| `reconcile_stale_ingest_media_job` | `reconcile_stale_ingest_media_job` | `request_id` |
| `backfill_default_library_closure_job` | `backfill_default_library_closure_job` | `default_library_id`, `source_library_id`, `user_id`, `request_id` |

## Best Practices

### Keep Domain Logic Where It Already Lives

Do not rewrite ingest/transcription/backfill business logic just because the transport changes.

Preferred pattern:

1. extract or keep a plain Python function that performs the real work
2. make the new worker call that function
3. delete Celery decoration only after the handler is wired through the new queue

### Centralize Policy

Retry policy, lease policy, and periodic schedule metadata belong in one registry.

Do not spread these across:

- route files
- service files
- worker entrypoints
- test-only constants

### Cut Over Cleanly

This is a full cutover, not a compatibility migration.

Rules:

- do not dual-write to Celery and Postgres
- do not dual-read from Celery and Postgres
- do not keep deprecated env vars or fallback branches after cutover
- if an internal API or payload shape changes, update the frontend and backend atomically in the same PR
- prefer a clean end state over a transitional shim

### Prefer Small, Explicit Functions

The junior implementing this should not build a framework.

Good:

- one queue service
- one registry
- one worker loop
- one scheduler loop

Bad:

- generic plugin system
- metaclass-based handlers
- abstract base class hierarchy for every job kind
- hidden retry decorators

### Use SQLAlchemy for Sessions, Not Queue Semantics

The queue should be explicit even if SQLAlchemy is used underneath.

That means:

- write obvious SQL for claim/update paths
- use service helpers to wrap it
- keep transaction boundaries easy to see

### Make Jobs Observable

Every job row should answer:

- what kind of job is this
- what payload did it run with
- how many attempts happened
- who claimed it
- what error happened
- whether it is still retryable

This replaces Celery's broker/result visibility with simple SQL.

## PR Roadmap

Do not ship this as one giant PR.

The implementation may land in multiple PRs, but production runtime should not run a dual queue stack. Foundation code may land first, but the cutover itself should be one-way.

### PR-01: Queue Foundation

Goal:

- add the Postgres queue foundation without changing job behavior

Deliverables:

- migration for `background_jobs`
- `python/nexus/jobs/queue.py`
- `python/nexus/jobs/registry.py`
- `python/nexus/jobs/worker.py`
- queue unit tests
- worker claim/retry tests
- basic `apps/worker/main.py` entrypoint that can run the custom worker loop

Acceptance:

- jobs can be enqueued and claimed from Postgres
- stale-running reclaim works
- lease renewal works
- retry/dead-letter transitions work
- no production runtime path uses the new queue yet

### PR-02: Migrate Core Media Jobs

Goal:

- move the core ingest path off Celery

Scope:

- `ingest_web_article`
- `ingest_epub`
- `ingest_pdf`
- `ingest_youtube_video`
- `enrich_metadata`
- `backfill_default_library_closure_job`

Deliverables:

- replace `apply_async()` call sites in:
  - `python/nexus/services/media.py`
  - `python/nexus/services/epub_lifecycle.py`
  - `python/nexus/services/pdf_lifecycle.py`
  - `python/nexus/services/default_library_closure.py`
- convert current task modules into plain handlers or thin wrappers around plain handlers
- update worker registry

Acceptance:

- core media ingest and retry paths run end-to-end through the Postgres worker
- follow-up metadata enrichment runs through the Postgres queue
- no core media flow still depends on Celery
- no Celery fallback path exists for migrated media jobs

### PR-03: Migrate Periodic and Podcast Jobs

Goal:

- remove beat and move the remaining scheduled work to the worker scheduler loop

Scope:

- `podcast_sync_subscription_job`
- `podcast_transcribe_episode_job`
- `podcast_reindex_semantic_job`
- `podcast_active_subscription_poll_job`
- `reconcile_stale_ingest_media_job`

Deliverables:

- replace `apply_async()` in podcast and ingest-recovery services
- add periodic scheduler loop in worker
- remove beat-specific scheduling logic from the runtime path

Acceptance:

- periodic jobs are enqueued by the worker scheduler loop
- periodic dedupe works across restarts
- podcast flows no longer depend on Celery or beat
- no beat compatibility code remains in the runtime path

### PR-04: Cut Over and Remove Celery

Goal:

- delete Celery infrastructure

Deliverables:

- remove `python/nexus/celery.py`
- remove `python/nexus/celery_contract.py`
- remove `python/scripts/verify_celery_contract.py`
- remove Celery dependency from `python/pyproject.toml`
- update `docker/Dockerfile.worker`
- update `docker/docker-compose.worker.yml`
- remove beat docs and commands from `README.md` and `apps/worker/README.md`
- remove obsolete env vars:
  - `CELERY_BROKER_URL`
  - `CELERY_RESULT_BACKEND`

Acceptance:

- the app has one worker process, not Celery worker + beat
- no code path imports Celery
- docs and local dev commands match reality
- no deprecated queue transport code remains in the merged runtime

### PR-05: Remove Remaining Redis and Reach One DB

Goal:

- make the app literally one API + one DB + one worker

Scope:

- stream token replay protection
- stream liveness tracking
- rate limit/token budget storage

Deliverables:

- replace Redis-backed replay protection in `python/nexus/auth/stream_token.py`
- replace Redis-backed liveness in `python/nexus/services/stream_liveness.py`
- replace Redis-backed rate limiter in `python/nexus/services/rate_limit.py`
- remove Redis startup from `python/nexus/app.py`
- remove `REDIS_URL` dependency once the replacement lands

Recommended simplification for this personal app:

- store stream token JTIs in Postgres
- store stream heartbeat in Postgres
- keep rate limiting simple and explicit, even if it means a few extra DB writes

Acceptance:

- API startup does not initialize Redis
- the runtime topology is truly one API + one DB + one worker
- Redis is removed from docs, env, and deploy config

## File-by-File Deliverables

### New Files

- `python/nexus/jobs/queue.py`
  - queue persistence helpers
- `python/nexus/jobs/registry.py`
  - canonical job definitions and schedule metadata
- `python/nexus/jobs/worker.py`
  - worker and scheduler loops
- `python/tests/test_job_queue.py`
  - queue persistence and claim semantics
- `python/tests/test_job_worker.py`
  - lease, retry, scheduler, and crash-reclaim behavior
- new Alembic migration for `background_jobs`

### Existing Files to Refactor

- `apps/worker/main.py`
  - custom worker entrypoint instead of Celery
- `python/nexus/services/media.py`
  - enqueue core media jobs via queue service
- `python/nexus/services/epub_lifecycle.py`
  - enqueue EPUB jobs via queue service
- `python/nexus/services/pdf_lifecycle.py`
  - enqueue PDF jobs via queue service
- `python/nexus/services/podcasts.py`
  - enqueue podcast jobs via queue service
- `python/nexus/services/ingest_recovery.py`
  - enqueue reconcile job via queue service
- `python/nexus/services/default_library_closure.py`
  - enqueue backfill job via queue service
- current task modules under `python/nexus/tasks/`
  - remove Celery decorators
  - expose plain handler functions or thin job handlers

### Existing Files to Delete in Cutover

- `python/nexus/celery.py`
- `python/nexus/celery_contract.py`
- `python/scripts/verify_celery_contract.py`

## Acceptance Criteria

The refactor is complete only when all of the following are true:

- All durable background work is stored in `background_jobs`.
- No production path calls `apply_async()`.
- No production path imports Celery.
- No beat process exists.
- The worker can reclaim a stale running job after lease expiry.
- The worker can run scheduled jobs without beat.
- Frontend and backend have been updated together where internal contracts changed.
- Existing domain invariants for PDF/EPUB/web/podcast flows remain intact.
- Redis is fully removed from runtime topology.
- Local development and deployment docs describe one API, one Postgres DB, and one worker.

## Test Plan

### New Test Coverage

- queue insert and unique dedupe behavior
- claim ordering behavior
- `FOR UPDATE SKIP LOCKED` claim correctness
- lease renewal
- stale-running reclaim
- retry scheduling and dead-letter transitions
- periodic scheduler dedupe behavior

### Existing Test Areas That Must Stay Green

- `python/tests/test_upload.py`
- `python/tests/test_media.py`
- `python/tests/test_pdf_ingest.py`
- `python/tests/test_epub_ingest.py`
- `python/tests/test_podcasts.py`
- `python/tests/test_reconcile_stale_ingest_media.py`
- `python/tests/test_ingest_recovery_ops.py`
- `python/tests/test_ingest_youtube_video.py`

### Verification Checklist

Run at minimum:

```bash
make test-back
make test-migrations
```

Manual smoke checks:

- upload a PDF and confirm it reaches `ready_for_reading`
- upload an EPUB and confirm it reaches `ready_for_reading`
- call `/media/from_url` and confirm web ingest runs
- stop the worker mid-job, restart it, and confirm the stale lease is reclaimed
- leave the worker idle and confirm periodic jobs still appear on schedule

## Explicit Do / Do Not Guidance For A Junior

Do:

- add the queue foundation first
- migrate one family of jobs at a time
- keep handlers thin and explicit
- keep job payloads small and explicit
- preserve current logs where possible
- remove dead transport code quickly once cutover is complete

Do not:

- delete Celery before all job kinds are migrated
- rename half the files while changing behavior
- spread queue SQL through route files
- build a generic job engine
- ship dual-write or fallback code
- keep deprecated compatibility shims after cutover
- mix queue refactor with unrelated business logic cleanup

## Final Recommendation

The simplest correct design for this app is:

- one `background_jobs` table
- one queue service
- one registry
- one worker loop
- one scheduler loop

Anything more complex is unnecessary for the scale and shape of this project.
