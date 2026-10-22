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

both targets start linux containers from the shared compose definitions. the
background lane proves its cgroup v2 memory bound (exactly 448 mib,
`memory.oom.group` 0) when it starts; there is no host-lane substitute.

## docker

install the locked dependencies and start stores/auth with `make dev`, then
`make migrate`. worker builds fetch the public git dependency at its locked
revision over https without credentials:

```sh
make worker-interactive
make worker-background
```

ordinary stop/start preserves local data.
worker source mounts execute the checkout, including the codex-agent source.
the image contains dependencies only; without these binds it cannot import
`nexus`, `apps.worker` or `apps.codex_agent`. rerun the same make target after
dependency/lock/dockerfile changes; it derives a new hash tag and builds only
when that tag is absent. api/web remain host-native.

`python/scripts/worker_checkout_image.py` owns the shared lab/make image cache.
its host flock covers acquisition, real worker container creation and removal
of old unreferenced `nexus-worker-checkout:*` tags. running and stopped containers
pin their full image ids, including references through other aliases. startup
uses the same composition with `--no-build`; the created containers pin the
image across lock release. manual overlay callers use this owner too, as in the
local enrollment instructions below.

core workers receive no native account, socket or memory config. the explicit
`docker/docker-compose.codex.yml` overlay supplies the native host, allowlisted
egress proxy and worker socket mounts; follow
[local enrollment](../../docs/runbooks/codex-personal-agent-host.md#local-enrollment).
`docker/docker-compose.memory.yml` independently adds only the interactive
memory-client bind and requires `NEXUS_MEMORY_CLIENT_CONFIG_FILE`.

metadata research needs nonblank `OPENAI_API_KEY`, `BRAVE_SEARCH_API_KEY` and the
native host. missing dependencies produce visible job failure; unrelated jobs
continue. queue health does not prove successful model research or local catalog
parity. the disposable core supports explicit provider configuration separately.

each healthcheck runs `python -S -m apps.worker.health --lane <lane>`, requiring
a live process and a database-backed cycle in the last 20 seconds. workers publish
nothing until the database matches their runtime identity's migration head.

## Environment

`DATABASE_URL`, `NEXUS_RUNTIME_IDENTITY_FILE` (local only; production uses the
baked `/app/runtime-identity.json`), `WORKER_LANE`, `PARSER_TEMP_ROOT`,
`BACKGROUND_PROCESS_*`, `BACKGROUND_JOB_PRUNE_*`, and the schedule knobs
`PODCAST_REFRESH_DUE_SCHEDULE_SECONDS` and `ATLAS_PROJECT_SCHEDULE_SECONDS`. Leases
(30 s), heartbeats (5 s), the idle wait and the storage orphan sweep's six hours are
fixed by the runtime.

## Gutenberg catalog

The Project Gutenberg catalog sync is operator-triggered, not a job:

```bash
cd python && uv run nexus sync-gutenberg-catalog
```

In production it runs in a one-off `migration` container ([`deployment.md`](../../deployment.md#gutenberg-catalog-sync)).

## Contract

`python/nexus/jobs/registry.py` owns per-kind policy; `docs/modules/jobs.md`
states the queue's invariants.
