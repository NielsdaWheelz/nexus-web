# search extension omits explain planning time

`docker/Dockerfile.postgres:4-10` pins pg_search `0.26.2` on postgres 15.
its [explain hook](https://github.com/paradedb/paradedb/blob/d22f0fba4da0cc4491f7197b37cd5f3a0da09b12/pg_search/src/postgres/planner_warnings.rs#L245)
passes a null planning-duration pointer to `ExplainOnePlan` on that version.
an actual restored pg15.19 query on 2026-10-27 omitted `Planning Time` even with
`EXPLAIN (SUMMARY ON, FORMAT JSON)`; the diagnostic stopped at that assertion,
so it did not establish complete-read timing.

client time minus executor time cannot be attributed to planning from these
plans. cursor rows, buffers and executor duration remain usable. this
observability gap does not waive search deadlines.

prefer an upstream fix. resolve when the pinned extension preserves postgres's
planning-duration measurement and an actual query reports it. no extension fork
or replacement profiling system is proposed here.
