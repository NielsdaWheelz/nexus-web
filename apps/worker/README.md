# Nexus Worker

Postgres-backed background worker for Nexus.

## Scope

The worker runs two loops:

- Job loop: claim one due row from `background_jobs`, execute handler, persist state.
- Scheduler loop: enqueue periodic jobs with deterministic dedupe keys.

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
- `WORKER_POLL_INTERVAL_SECONDS`
- `WORKER_SCHEDULER_INTERVAL_SECONDS`
- `WORKER_HEARTBEAT_INTERVAL_SECONDS`
- `WORKER_LEASE_SECONDS`

See root `.env.example` for defaults and related ingest controls.

## Contract

`python/nexus/jobs/registry.py` is the source of truth for job kinds, retry policy, lease policy, and schedule policy.
