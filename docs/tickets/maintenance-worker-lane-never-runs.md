# the maintenance worker lane never runs, so nothing is ever pruned

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: jobs · oi-149

`prune_terminal_jobs` has exactly one caller,
`python/nexus/tasks/prune_background_jobs.py:24`, the body of the
`prune_background_jobs_job` kind. that kind lives only in
`MAINTENANCE_JOB_KINDS` (`jobs/job_topology.py:30-34`), and
`JobWorker.run_scheduler_once` skips any periodic kind outside
`self.allowed_kinds` (`jobs/worker.py:695`). `rg -n WORKER_LANE deploy docker
.github scripts` shows only the interactive and background lanes deployed
(`deploy/hetzner/docker-compose.yml:115,159`;
`docker/docker-compose.worker.yml:27,71`), and `apps/worker/README.md:72-84`
documents maintenance as "a one-off process, never a deployed service".

so `prune_background_jobs_job` has never run in production: `background_jobs`
grows without bound and `purge_expired_auth_handoff_codes`, which has the same
topology problem, never expires handoff codes. `never_prune_dead` is not inert
configuration — `docs/modules/storage.md:104-109` names it as the invariant that
keeps a failed run operator-discoverable — so option (b) below is a genuine
capability loss, not tidying.

decision: (a) move both kinds into the background lane so pruning starts, or (b)
delete the maintenance lane and both jobs?

prerequisite: the owner's answer. under (a), terminal job-row deletion begins on
the next deploy; `never_prune_dead` keeps dead-letter rows.

fix: (a) move `prune_background_jobs_job` and `purge_expired_auth_handoff_codes`
from `MAINTENANCE_JOB_KINDS` into `BACKGROUND_WORKER_JOB_KINDS`, keep
`never_prune_dead` and `excluded_dead_kinds` as they are, and update
`apps/worker/README.md:73-86` and `docs/modules/storage.md`. (b) delete
`prune_background_jobs.py`, `prune_terminal_jobs`, the `excluded_dead_kinds`
parameter, the `never_prune_dead` field with its 11 call-site arguments, and the
registry entry.

acceptance: no scheduled-looking sweep exists that no lane can enqueue, and the
worker readme describes the lanes that are actually deployed.
