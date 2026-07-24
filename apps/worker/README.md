# Nexus Worker

Postgres-backed workers for Nexus.

## Scope

Each single-process lane runs two loops:

- Job loop: claim one due row from `background_jobs`, execute handler, persist state.
- Scheduler loop: enqueue explicitly enabled periodic jobs with deterministic dedupe keys.

`WORKER_LANE=interactive|background` selects one fixed allowlist declared in
`nexus.config`. The five-kind interactive lane owns user-waiting work. The
twelve-kind background lane owns retrieval, repair, teardown, and production
periodic schedules. The lanes are disjoint and together cover the complete
production-enabled job set.

## Run

From repo root:

```bash
make worker-interactive
make worker-background
```

Manual run:

```bash
cd python
PYTHONPATH=$PWD:$PWD/.. \
  DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54320/postgres \
  DATABASE_STATEMENT_TIMEOUT_MS=300000 \
  WORKER_LANE=interactive \
  uv run python -m apps.worker.main
```

Run the same command with `WORKER_LANE=background` for the background lane.

## Docker

```bash
docker build -f docker/Dockerfile.worker -t nexus-worker .
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml \
  up -d worker-interactive worker-background
```

## Environment

- `DATABASE_URL` (required)
- `WORKER_LANE` (required by the worker entrypoint)
- `WORKER_POLL_INTERVAL_SECONDS`
- `WORKER_IDLE_BACKOFF_MAX_SECONDS`
- `WORKER_SCHEDULER_INTERVAL_SECONDS`
- `WORKER_HEARTBEAT_INTERVAL_SECONDS`
- `WORKER_LEASE_SECONDS`
- `WORKER_DB_FAILURE_BACKOFF_SECONDS`
- `WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS`
- `PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS`
- `INGEST_RECONCILE_SCHEDULE_SECONDS`
- `SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS`
- `BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS`

See root `.env.example` for example values and related ingest controls.

Maintenance is a one-off process, never a deployed service:

```bash
WORKER_LANE=maintenance \
NEXUS_ALLOW_WORKER_MAINTENANCE=1 \
WORKER_ALLOWED_JOB_KINDS=prune_background_jobs_job \
BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS=3600 \
uv run python -m apps.worker.main
```

The raw allowlist must be a non-empty subset of the four
`MAINTENANCE_JOB_KINDS`. Normal lanes reject it. Stop the process when the
bounded maintenance operation is complete.

## Contract

`python/nexus/jobs/registry.py` owns job policy. `python/nexus/config.py` owns
the production and maintenance topology. Only the background lane schedules
production periodic jobs.
