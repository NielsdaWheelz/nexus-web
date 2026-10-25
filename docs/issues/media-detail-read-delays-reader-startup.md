# media detail reads delay reader startup

problem: ready, tiny epub uploads can remain at `Loading media…` while their
detail reads take more than ten seconds. the reader publication itself is ready.

evidence: unmodified `a09557224`, canonical lab `20261025-132324-258b012674de`.
`/reader` returned 200 in 78ms at 20:28:04.550 utc. the following bootstrap and
mounted `/media/{id}` reads returned 200 after 11410.94ms and 12424.31ms
(`api.log:540,544`; the ac2 browser trace has the mounted request still pending
when its frame check expires). surrounding account/session/import reads took
under 271ms. entry owner: `python/nexus/services/media.py:408`, calling `_rows`
at line 133. read-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of `_ROWS_SQL`
for one admitted media measured 9109.662ms execution, including 9023.266ms of
postgres jit work across 381 functions (6108.701ms optimization, 2500.777ms
emission). compilation, not row retrieval, dominates this observed read.

impact: reader startup stalls; live control checks must await actual mounted
readiness before exercising behavior. a longer generic interaction timeout is
not a product repair.

resolve by reducing the owning projection's unnecessary compilation work while
preserving visibility, capabilities and returned facts; do not disable jit
globally or change browser interaction deadlines. repeat ready-reader navigation
with equivalent uploaded documents and active worker work; retain query/request
timings showing the startup delay removed. backend changes are outside the
reader-view presentation bundle.
