status: open
origin: 2026-09-14 bounded-workspace run 66a2d2004332e575
area: nexus history / database work

`python/nexus/services/nexus_history.py:58` computes every distinct target before
limiting recents to five. real postgres at 100,000 retained rows sorts all 100,000,
spills 10,392 kib, and takes 601.714 ms in explain analyze. the existing candidate
frecency query returns only 190 indexed rows in 2.779 ms.
receipt: `test-results/runs/66a2d2004332e575/nexus-history-growth.json`.

preserve exact distinct-target order, latest label/source, tie breaking and scores.
review the existing recency index and mutation owner before choosing a query or
stored projection. do not truncate candidate rows before deduplication.

acceptance: actual retained-growth and highly repeated-target fixtures preserve
results without a full-history sort; record query plans and bounded materialization,
then qualify the actual api overlap and cold-read scope.

reviewed repair uses the existing recency index in one recursive query/snapshot.
ordinary `7149cacb49af1ea7` returns exact five distinct targets for both 100,000
distinct rows and a 100,000-row duplicate prefix. the distinct recency plan takes
0.080 ms and sorts only five rows; repeated-prefix plan takes 26.192 ms and the
first full service call 289.225 ms. canonical candidate-filter sensitivity
`c91898b368290794` and full-sort auxiliary `ae54f728b97dac82` both pass.
actual api/cold-read overlap remains the only open acceptance in this ticket.
