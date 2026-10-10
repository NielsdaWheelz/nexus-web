# a dead oracle job leaves its reading pending forever

status: open, source-qualified · origin: 2026-10-04 oracle audit; restated by the oracle rewrite; updated 2026-10-10 generation rewrite · area: oracle generation recovery

`jobs/registry.py` declares `oracle_reading_generate` with one attempt, but
`services/oracle/readings.create_reading` enqueues with `jobs/queue.enqueue_job`'s
three-attempt default. a job that dies (an expired lease or a handler defect)
leaves its reading `pending`: the pane shows skeletons for good and the stream
stays open on keepalives. since the generation rewrite nothing replays: the
`Generation` dead-letter projection closes the job's `llm_calls` row
`interrupted`, but nothing settles the reading
([dead-background-jobs-leave-domain-rows-pending](dead-background-jobs-leave-domain-rows-pending.md)).

a stored `streaming` reading has no owner either: its job no-ops, as under main and
simplify-04 (0262 keeps stored status), so it shows skeletons and its stream stays
open for good. the same settlement should cover it.

proposed fix: when an oracle job dies, fail its pending reading
`runtime_unavailable` in the dead-letter transaction (the user starts a new
reading), and make the declared and stored attempt counts agree.

acceptance: an exhausted or interrupted oracle job leaves its reading `failed`
with a closed code, and the pane shows the failure copy.
