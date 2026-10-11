# local worker overlay hardcodes its minio cors origins and ports

status: open (the memory half was fixed by the 2026-10-10 jobs reauthor: the
overlay bounds `worker-background` at `mem_limit`/`memswap_limit` 448m, `init:
true`); read from code, not run · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: local development / worker

the overlay's minio cors/ports are hardcoded to 3000/3001.

fix: derive the cors origins from the web port.

acceptance: `docker compose -f docker/docker-compose.worker.yml up` with a
non-default web port serves browser uploads.
