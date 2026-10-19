# jobs runtime reauthor: release steps

status: open until the release that carries the jobs runtime reauthor (it lands
after the pending production release).
origin: 2026-10-10 jobs runtime reauthor (branch cleanup/jobs-runtime-reauthor,
coordinator review R5, R6).
area: release / workers.

the api and both worker images ship together; migration `0276` drops
`background_job_capacity_leases.worker_id` and `attempt_no` and expires every
running row's lease. an old worker cannot run against it (it writes the dropped
columns), and handler paths changed (`module:fn` in the owners), so no old worker
may run any job after the new images start.

1. the release stops every writer before migrating (`release.py`: stop `api`,
   `worker-interactive`, `worker-background`, then backup, then migrate). `0276`
   must run in that window, with every worker stopped (one upgrade with model
   tools' `0274` and collection revisions' `0275` if they ship together).
2. the window must have no chat run in flight when the workers stop: the
   interactive lane does not observe SIGTERM inside a running handler
   ([ticket](interactive-worker-ignores-sigterm-mid-job.md)), so a run longer than
   the 30 s stop timeout is SIGKILLed (exit 137) and fails the release's
   clean-stop check. the owner is not using the app then.
3. after `0276` every abandoned `running` row is reclaimed at once by the new
   workers (that attempt spent, `E_WORKER_INTERRUPTED`, history recorded).
4. at leisure, delete from the private `deploy/env/env-prod-worker` the ten
   retired knobs (`WORKER_POLL_INTERVAL_SECONDS`, `WORKER_IDLE_BACKOFF_MAX_SECONDS`,
   `WORKER_SCHEDULER_INTERVAL_SECONDS`, `WORKER_HEARTBEAT_INTERVAL_SECONDS`,
   `WORKER_LEASE_SECONDS`, `WORKER_DB_FAILURE_BACKOFF_SECONDS`,
   `WORKER_DB_FAILURE_BACKOFF_MAX_SECONDS`, `WORKER_ALLOWED_JOB_KINDS`,
   `NEXUS_ALLOW_WORKER_MAINTENANCE`, `SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS`);
   settings ignore them meanwhile.

expected after release: `docker kill` of a worker mid-job ends its job's attempt
within about 30 s of the restart (was up to 1,200 s); background child log lines
reach `docker logs worker-background`; the gutenberg sync is
`nexus sync-gutenberg-catalog` (`deployment.md`).

acceptance: the release record shows 0276 applied with all writers stopped, both
lanes healthy after `up`, and no exit 137 at the stop.
