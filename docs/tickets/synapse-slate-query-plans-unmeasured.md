# synapse and slate query plans are unmeasured at production shape

status: open · origin: 2026-10-04 synapse reauthor (design §9 risk, branch cleanup/synapse-reauthor) · area: suggestions / discovery / performance

the rewrite moved slate ranking into one sql statement per surface
(`services/suggestions.py:_targets_sql` + `_candidates`: every visible media per
read, the materialized engagement union, the owner-normalized edge lane) and
gave synapse a new exclusion query (`services/connection_discovery.py:_excluded`: edges
filtered by the source's exact endpoint, plus every one of the user's
suppressions, owner-normalized by `owner_rows_sql`; dismissals are
human-scale, but `_publish` reads all of them under SERIALIZABLE). all of it
ran correctly on the harness stack (37/37 journeys) and on scratch postgres
fixtures, but no plan was taken against a production-shaped database. the
edge lane's known O(graph) cost is `resonance-edge-lane-scans-whole-graph.md`.

fix: on a redacted production-shape fixture (thousands of media, a dense
graph), run EXPLAIN (ANALYZE, BUFFERS) for the three slate reads and for
`_excluded` on a heavily linked note; fix any plan that scans per read what an
index or an earlier filter would bound.

acceptance: recorded plans and timings under the api's statement timeout, with
the slates returning the same json before and after any fix.
