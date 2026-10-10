# a dead oracle job leaves its reading pending forever

status: open, source-qualified · origin: 2026-10-04 oracle audit; restated by the oracle rewrite (cleanup/oracle-reauthor) · area: oracle generation recovery

`jobs/registry.py` declares `oracle_reading_generate` with one attempt, but
`services/oracle/readings.create_reading` enqueues with `jobs/queue.enqueue_job`'s
three-attempt default, and nothing settles a reading whose job dies: an uncertain
dispatch (`readings._run` raises `GenerationUncertain`), an expired lease or a handler
defect leaves the row `pending`. the pane then shows skeletons for good and the
stream stays open on keepalives. the dead row carries the journal (a `Completed`
outcome can still be replayed by requeueing it), but `jobs/registry._run_prune_background_jobs`
deletes dead rows after the configured retention (default 30 days).

a stored `streaming` reading has no owner either: its job no-ops, as under main and
simplify-04 (0262 keeps stored status; simplify-04's 0259 backup has one, c2ad581b,
with a queued job), so it shows skeletons and its stream stays open for good. the same
recovery should settle it.

do not fabricate a failure before a known generation terminal or resend an uncertain
generation. retain dead oracle jobs (`never_prune_dead`) and give the operator one
exact recovery: requeue a `Completed` journal; mark a reading whose job died before
any dispatch `failed`; leave an uncertain one for manual settlement. make the declared
and stored attempt counts agree.

acceptance: an exhausted or interrupted oracle job leaves its reading discoverable
and its journal unpruned; the recovery settles it through `_publish`.
