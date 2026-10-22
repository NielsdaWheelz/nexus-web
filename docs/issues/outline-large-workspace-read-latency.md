# large-workspace outline reads take seconds

run26 at `9a343c588`, lab `20261021-204931-982017a119cc`, loaded a page with
200 children in a 10,000-edge account and eight retained panes, including a
50,000-codepoint formatted note. the continuation's first-page reread took
4.136 s and cursor read 3.238 s; both returned 100 rows at version 401. the first
post-timeout snapshot contained all 200 unique rows in exact response order.
the trace does not attribute the remaining delay among parsing, adoption and
rendering. this is slow readiness, not demonstrated lost pagination.

the writing benchmark excludes fixture setup from its measured budgets. keep
those budgets and row requirements; profile this read path separately through
`useResourceOutline.ts` and the resource-graph outline owner. resolve when page
readiness meets an explicit read-latency target at this load with evidence of the
responsible costs; no source cause or latency-budget pass is established yet.
