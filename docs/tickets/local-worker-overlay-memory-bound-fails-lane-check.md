# local worker overlay memory bound fails the background lane check

status: open; read from code, not run · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: local development / worker

`docker/docker-compose.worker.yml:42` (and `:85`) bound the background worker at
`2G`, but the background lane validates its cgroup `memory.max` equals
`BACKGROUND_WORKER_MEMORY_LIMIT_BYTES` (448 MiB, `python/nexus/config.py:42`,
checked by the process executor's validated cgroup open). the overlay's minio
cors/ports are also hardcoded to 3000/3001. an isolated stack ran the lane with
`mem_limit`/`memswap_limit` 448m (matching `deploy/hetzner`) and it validated.

fix: bound the local overlay exactly as production does and derive the cors
origins from the web port.

acceptance: `docker compose -f docker/docker-compose.worker.yml up` starts a
background lane that passes its cgroup validation on a clean host.
