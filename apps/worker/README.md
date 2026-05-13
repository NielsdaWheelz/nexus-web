# Nexus Worker

Postgres-backed background worker for Nexus.

## Scope

The worker runs two loops:

- Job loop: claim one due row from `background_jobs`, execute handler, persist state.
- Scheduler loop: enqueue explicitly enabled periodic jobs with deterministic dedupe keys.

Production defaults are safe for Supabase free/Nano: maintenance jobs are
excluded from the explicit allowlist, periodic schedules use `0` as disabled,
and the worker claims user/domain jobs only.

## Run

From repo root:

```bash
make worker
```

Manual run:

```bash
cd python
PYTHONPATH=$PWD:$PWD/.. DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/postgres uv run python -m apps.worker.main
```

## Docker

```bash
docker build -f docker/Dockerfile.worker -t nexus-worker .
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml up -d worker
```

## Environment

- `DATABASE_URL` (required)
- `WORKER_ALLOWED_JOB_KINDS`
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

Maintenance requires both steps: add the specific maintenance job kind to
`WORKER_ALLOWED_JOB_KINDS`, then set that job's schedule above `0` for the
bounded window.

## Contract

`python/nexus/jobs/registry.py` is the source of truth for job kinds, retry policy, lease policy, and schedule policy.
