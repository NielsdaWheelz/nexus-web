# Nexus Worker

One process per lane, each running two loops against `background_jobs`:

- Job loop: claim one due row, execute its handler, settle the row.
- Scheduler loop: enqueue each due periodic slot once, cluster-wide.

`WORKER_LANE=interactive` owns the five user-waiting kinds and keeps handlers
in-process alongside the agent-tools MCP listener. `WORKER_LANE=background`
owns the fifteen retrieval, repair, teardown and periodic kinds and runs every
handler in a fresh cgroup-limited child. The lanes are disjoint and together
cover the production-enabled job set (`python/nexus/job_topology.py`).

## Run

```bash
make worker-interactive
make worker-background
```

Manual run:

```bash
make local-runtime-identity
cd python
PYTHONPATH=$PWD:$PWD/.. \
  DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54320/postgres \
  NEXUS_RUNTIME_IDENTITY_FILE=$PWD/../.nexus-local/runtime-identity.json \
  DATABASE_STATEMENT_TIMEOUT_MS=300000 \
  WORKER_LANE=interactive \
  uv run python -m apps.worker.main
```

## Docker

```bash
make local-runtime-identity
export NEXUS_LOCAL_SOURCE_SHA="$(git rev-parse HEAD)"
export NEXUS_LOCAL_RUNTIME_IDENTITY_FILE="$PWD/.nexus-local/runtime-identity.json"
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml \
  up -d worker-interactive worker-background
```

Each container's healthcheck runs `python -S -m apps.worker.health --lane <lane>`,
which fails unless the process published a database-backed cycle in the last 20
seconds under the running image's identity.

## Environment

`DATABASE_URL`, `NEXUS_RUNTIME_IDENTITY_FILE` (local only; production uses the
baked `/app/runtime-identity.json`), `WORKER_LANE`, `WORKER_POLL_INTERVAL_SECONDS`,
`WORKER_IDLE_BACKOFF_MAX_SECONDS`, `WORKER_SCHEDULER_INTERVAL_SECONDS`,
`WORKER_HEARTBEAT_INTERVAL_SECONDS`, `WORKER_LEASE_SECONDS`,
`WORKER_DB_FAILURE_BACKOFF_SECONDS`, `WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS`,
`PARSER_TEMP_ROOT`, `BACKGROUND_PROCESS_*`, `BACKGROUND_JOB_PRUNE_*`, and the
schedule knobs `PODCAST_REFRESH_DUE_SCHEDULE_SECONDS`,
`INGEST_RECONCILE_SCHEDULE_SECONDS`, `ATLAS_PROJECT_SCHEDULE_SECONDS`,
`STORAGE_ORPHAN_SWEEP_INTERVAL_SECONDS`, `SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS`.
See root `.env.example` for values.

## Maintenance

A one-off process, never a deployed service. The raw allowlist must be a
non-empty subset of `MAINTENANCE_JOB_KINDS`; the normal lanes reject it. Stop
the process when the bounded operation is complete.

```bash
WORKER_LANE=maintenance \
NEXUS_ALLOW_WORKER_MAINTENANCE=1 \
WORKER_ALLOWED_JOB_KINDS=sync_gutenberg_catalog_job \
SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS=86400 \
uv run python -m apps.worker.main
```

## Contract

`python/nexus/jobs/registry.py` owns per-kind policy; `docs/modules/jobs.md`
states the queue's invariants.
