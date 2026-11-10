# queue claim io qualification after recovery cutover

historical qualification at `28070c420` against `990d16f66` observed about
25.27 mib of temporary data per claim while processing roughly 100,000 accepted
`authored_text_reindex_job` jobs. this was backlog work, separate from finite
observation. the scope/media observation plans wrote no temporary data.

proof: private archive
`/Users/nnandal/.local/state/nexus-task-archives/finite-observation-20261109/private/lab/20261109-142527-d77f910ac1b1/artifacts/`
contains `background-baseline.private.json`, `postgres-temporary-io.private.log`
and `observation-query-plans.private.json`: 19 completed jobs and 19 temporary
files / 503,521,280 bytes in 60 seconds without a browser. the wider original run
is `20261109-133948-92224e73c855`.

upstream recovery (`e6ef89a08`, integrated from `d855bf190`) changed the claim:
`python/nexus/jobs/queue.py` now selects pending/failed rows and orders directly by
available_at/id. the expired-running branch and computed sort are removed; the
existing `idx_background_jobs_due_claim` partial index matches that ordering.
the historical spill is NOT an established defect in the integrated source.

resolve with a current populated-backlog claim plan and bounded no-browser
sample proving acceptable temporary io and unchanged priority, skip-locked,
capacity, execution fencing and ownership. do not tune work memory to conceal
a query defect. the retained original dump records the former0336 finite-cleanup
schema; it cannot be restored as proof of the different0336 metadata migration.
new replay data must follow the current migration chain. no queue edit belongs
to this observation change without current evidence.
