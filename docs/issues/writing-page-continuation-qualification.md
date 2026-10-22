# 200-row writing load fails before latency sampling

at `f8250653b`, lab `20261021-184338-a4e8ed8957a8` created all 10,000 owned
edges, including the intended 200 page children. the actual `show more` action
left 100 `[data-collection-row-id]` elements in `performance-rows` for ten seconds
(`writing-performance.spec.ts:201`). no latency sample ran.

the retained trace shows only first-page requests; no cursor request was sent.
`apps/web/src/lib/api/pagePrefix.ts` treated retained `asked: 1` data as a
completed two-page result and reset demand before continuation. distinguish the
completed request's page demand from retained data; preserve shorter-prefix
display, failure retention and genuine cursor-conflict restart. no latency budget
has failed and the required row count must remain unchanged.

resolved when the real continuation displays all 200 required rows and both
desktop and android performance qualification reach their measured phases.

the requested-prefix repair passed the focused 200-row/refresh/real-409 journey
in run24. run26's full fixture did send its cursor request and eventually mounted
all 200 unique rows in response order; the first post-deadline snapshot proves
this 338 ms after the ten-second setup assertion expired. the two reads consumed
7.374 s. use a bounded setup-readiness deadline without weakening measured
budgets. slow initial reads are tracked in `outline-large-workspace-read-latency.md`.

run27 reached the exact desktop load with 200 rows and eight mounted retained
panes. tracing capability then failed before the first input, separately tracked
in `writing-trace-capability-qualification.md`. android qualification remains open.
