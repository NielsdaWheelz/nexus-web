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

2026-11-16: candidate `d3bf104b0` preserved authority fixtures but its summary
timed out at 30,005 ms. its nonexecuting plan left evidence decoding in a join
filter over 16,254 fragments and 642 source edges. the capture owner now resolves
evidence identities before authority joins; representative read-only comparison
reduced 9,555 ms to 85 ms with equal complete rows and capture sets. this repairs
that execution blocker; it does not repair the recursive visibility estimates.

if later actual plans incur unnecessary work, preserve membership uniqueness and
candidate bounds in the canonical visibility composition. prove unchanged grants,
containment, tombstones and teardown visibility on populated graphs, with improved
estimates and actual execution. no query rewrite or statistics mutation is part of
this capture-owner repair.
