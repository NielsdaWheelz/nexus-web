# visibility recursion loses cardinality bounds in the planner

the canonical visibility relation estimates 27,111,549,776 rows but returns 12,425
ids in local run `20261025-132803-65627ff9690b`, source `7f363b5f5`.
`media._ROWS_SQL` consequently estimates 95,936,626,429,090 rows for a 20-id batch.
populated tables are autoanalyzed; empty containment tables have `reltuples=-1`.
private artifacts `query-cost-{entries,summary}-jit-off-actual.json` contain the
actual plans. the recursive worktable never executes because containment is empty.

the application compilation policy addresses the measured multi-second jit cost;
it does not correct these estimates. actual jit-off queries took 42/52 ms, with
no shared reads or temporary spill, so no additional execution blocker is proved.

2026-11-16 representative-corpus blocker: candidate `d3bf104b0` kept the small
authority fixtures correct but its 11-id summary timed out at 30,005 ms; deployed
`d05d69b` returned the same requested rows in 9,484 ms. the candidate's plan-only
inspection places evidence decoding in a nested-loop join filter over an
estimated 16,254 fragments and 642 media-source edges, despite typed uuid
equality. no per-node execution time was measured for that refused statement.
derive evidence identities once before joining fragments at the shared capture
owner; require unchanged authority and measured representative improvement.

if later actual plans incur unnecessary work, preserve membership uniqueness and
candidate bounds in the canonical visibility composition. prove unchanged grants,
containment, tombstones and teardown visibility on populated graphs, with improved
estimates and actual execution. no query rewrite or statistics mutation is part of
the current fix.
