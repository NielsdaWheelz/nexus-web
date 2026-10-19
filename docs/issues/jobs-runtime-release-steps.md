# jobs runtime reauthor: retired worker knobs

status: open · origin: 2026-10-10 jobs runtime reauthor (`0276`, released 2026-10-13) · area: release / workers

`0276` and the new workers shipped with the 2026-10-13 release. one owner step is
left: the private `deploy/env/env-prod-worker` still names nine knobs no code
reads (`WORKER_POLL_INTERVAL_SECONDS`, `WORKER_IDLE_BACKOFF_MAX_SECONDS`,
`WORKER_SCHEDULER_INTERVAL_SECONDS`, `WORKER_HEARTBEAT_INTERVAL_SECONDS`,
`WORKER_LEASE_SECONDS`, `WORKER_DB_FAILURE_BACKOFF_SECONDS`,
`WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS`, `WORKER_ALLOWED_JOB_KINDS`,
`SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS`; checked 2026-10-19). settings ignore
them. delete them and re-run `deploy/hetzner/sync-env.sh`.

resolved when: the env file names none of them; delete this file.
