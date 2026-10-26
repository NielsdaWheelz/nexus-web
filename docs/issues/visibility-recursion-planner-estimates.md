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

if later actual plans incur unnecessary work, preserve membership uniqueness and
candidate bounds in the canonical visibility composition. prove unchanged grants,
containment, tombstones and teardown visibility on populated graphs, with improved
estimates and actual execution. no query rewrite or statistics mutation is part of
the current fix.
