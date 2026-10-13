# Nexus Worker

One process per lane. Each loop cycle enqueues the lane's due periodic slots
(once cluster-wide), dead-letters or claims one due job, runs it, and settles it;
an idle worker waits for a notify on its kinds, its next due row, or 5 s.

`WORKER_LANE=interactive` owns the five user-waiting kinds and runs handlers
in-process. `WORKER_LANE=background` owns the fourteen retrieval, repair,
teardown and periodic kinds and runs every handler in a fresh child bounded by
the lane's 448 MiB cgroup. Each kind's lane is its registry row
(`python/nexus/jobs/registry.py`).

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

The background lane runs only in a container: it proves its cgroup v2 memory
bound (exactly 448 MiB, `memory.oom.group` 0) when it starts.

## Docker

```bash
make local-runtime-identity
export NEXUS_LOCAL_SOURCE_SHA="$(git rev-parse HEAD)"
export NEXUS_LOCAL_RUNTIME_IDENTITY_FILE="$PWD/.nexus-local/runtime-identity.json"
export UNIVERSAL_MEMORY_DEPLOY_KEY_FILE=/absolute/path/to/read-only-deploy-key
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml \
  up -d worker-interactive worker-background
```

both image builds need that private dependency key, including the background
image without runtime memory access. compose mounts it only as the required
BuildKit secret; an unset path or missing file fails the build. it never enters
image layers, build arguments or runtime configuration. the optional interactive
`NEXUS_MEMORY_CLIENT_CONFIG_FILE` is a separate runtime declaration.

metadata research additionally needs `OPENAI_API_KEY` for document embeddings,
`BRAVE_SEARCH_API_KEY` for public search and the local native host. compose passes
only those declared worker settings; neither key enters the native host. blank
keys count as unavailable. without them, unrelated jobs continue and metadata
research fails visibly before model submission.

the optional `codex` profile supplies the pinned host and its allowlisted egress
proxy. ordinary worker startup does not depend on its account directory or health.
follow [local enrollment](../../docs/runbooks/codex-personal-agent-host.md#local-enrollment)
to prepare the directory, enroll, start the host and await its health before
starting research workers. api and web stay host-native for importing, admission
and metadata reads; this setup does not qualify local chat/model-catalog parity.

Each container's healthcheck runs `python -S -m apps.worker.health --lane <lane>`,
which fails unless the lane's live process published a database-backed cycle in
the last 20 seconds. A worker publishes nothing until the database is at its
image's revision, which it proves once, at start.
worker heartbeat health, native catalog health and a successful four-tool research
operation are separate evidence; a healthy queue worker does not prove research.

## Environment

`DATABASE_URL`, `NEXUS_RUNTIME_IDENTITY_FILE` (local only; production uses the
baked `/app/runtime-identity.json`), `WORKER_LANE`, `PARSER_TEMP_ROOT`,
`BACKGROUND_PROCESS_*`, `BACKGROUND_JOB_PRUNE_*`, and the schedule knobs
`PODCAST_REFRESH_DUE_SCHEDULE_SECONDS`, `INGEST_RECONCILE_SCHEDULE_SECONDS`,
`ATLAS_PROJECT_SCHEDULE_SECONDS`, `STORAGE_ORPHAN_SWEEP_INTERVAL_SECONDS`. Leases
(30 s), heartbeats (5 s) and the idle wait are fixed by the runtime.

## Gutenberg catalog

The Project Gutenberg catalog sync is operator-triggered, not a job:

```bash
cd python && uv run nexus sync-gutenberg-catalog
```

In production it runs in a one-off `migration` container ([`deployment.md`](../../deployment.md#gutenberg-catalog-sync)).

## Contract

`python/nexus/jobs/registry.py` owns per-kind policy; `docs/modules/jobs.md`
states the queue's invariants.
