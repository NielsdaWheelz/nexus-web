# Nexus Worker

Postgres-backed worker loop for durable background jobs.

## Overview

The worker runs two small loops:
- **job loop**: claims one due row from `background_jobs`, executes a plain Python handler, writes explicit state transitions.
- **scheduler loop**: enqueues periodic jobs with deterministic dedupe keys for each schedule slot.

There is no Celery broker, no beat process, and no `apply_async` runtime path.

## Usage

### Local development

```bash
# from repo root
make worker

# manual
cd python
PYTHONPATH=$PWD:$PWD/.. \
  DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/postgres \
  uv run python -m apps.worker.main
```

### Docker

```bash
# build image
docker build -f docker/Dockerfile.worker -t nexus-worker .

# run worker service
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml up -d worker
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `WORKER_POLL_INTERVAL_SECONDS` | no | idle poll sleep in seconds (default: `2`) |
| `WORKER_SCHEDULER_INTERVAL_SECONDS` | no | scheduler loop cadence in seconds (default: `30`) |
| `WORKER_HEARTBEAT_INTERVAL_SECONDS` | no | lease heartbeat interval in seconds (default: `60`) |
| `WORKER_LEASE_SECONDS` | no | default lease during claim before kind-specific policy applies (default: `300`) |

## Notes

- Web/article/EPUB/PDF handlers still run Node/Python extraction code under `python/nexus/tasks`.
- Periodic jobs use dedupe keys shaped like `periodic:<kind>:<slot_start_iso8601>`.
- Retry/lease/schedule policy is centralized in `python/nexus/jobs/registry.py`.
