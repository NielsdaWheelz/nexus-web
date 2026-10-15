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

production evidence, 2026-10-13 release: on source `3ea1b8e6`, nine
`GET /lectern/suggestions` responses between 21:04:13z and 21:06:11z
took 30.96–47.78 seconds (all 200). one completed after shutdown began;
the api subsequently exceeded its 30-second stop grace. the precise
connection that prevented shutdown is not established. private evidence:
`release/attempts/16763c3cd/shutdown-failure/api.log`.

the api termination fix is separate from query performance. reproduce the
ordinary slate read on the restored production copy and retain the query plan
before changing the responsible query. no higher statement timeout or result
truncation qualifies as resolution.

restored production diagnosis, 2026-10-13: exact source `16763c3c` took
33.82 seconds for the lectern read. five serial similarity statements cost
31.81 seconds; the graph/ranking statement cost 0.52 seconds. each similarity
plan read 637,712 chunk embeddings before its exact per-family top-400 sort.
`_similar` now ranks all media anchors in one query, preserving active embedding
identity, target eligibility, distance/owner/chunk order, and each anchor/family
limit. filtering the existing distance threshold before ranking cannot displace
an admitted chunk. the prototype retained every similarity row in 6.12 seconds;
its plan materialized five anchor vectors, sorted four admitted chunks in 25 kb,
and used no temp blocks on the unchanged 512 mib postgres clone.

five full responses (lectern, quick reads, two ordinary libraries and the
default library) remain byte-identical. nine empty/identity/limit controls
pass, and all 800 ordered chunk identities at two filled top-400 boundaries
match. full ordered candidate lists also match: 43 lectern, 11 quick-read
and 20 ordinary-library candidates. the complete lectern read fell from 31.71 to 6.60 seconds; ordinary
library reads fell from 32.43–34.15 to 7.19–7.36 seconds.

qualification receipts are under
`release/suggestions-query-qualification/`. the whole-graph lane and synapse
exclusion query remain separate open work; this correction does not qualify
those broader scaling claims.

2026-10-14 lectern diagnosis, read-only: newer retained evidence confirms the
interaction remains slow with jit disabled. the actual `665e7b3af` image's
restored-corpus owner calls took 6.882 seconds for suggestions and 0.603 seconds
for quick reads. source `367da80e0` has no changes to the suggestions owner or
lectern routes relative to that image. this is backend evidence, not a fresh
browser or production request measurement.

an earlier jit-off breakdown took 7.140 seconds for suggestions, of which
6.921 seconds was similarity acquisition and 0.175 seconds graph/ranking.
the corresponding quick read took 0.348 seconds, with 0.105 seconds similarity.
the retained exact-query plans traversed 456 eligible media / 637,712 embeddings
for suggestions and 124 media / 1,151 embeddings for quick reads. limiting the
response to ten items does not bound acquisition.

local evidence (retained from prior qualification, not rerun in this session):

- `/tmp/nexus-full-readmodels-final665-once-20261014T2045Z/readback/full-readmodels-final665-once-20261014T2045Z/bounded-summary.json`;
- `/tmp/nexus-full-readmodels-20261014T2030/readback/full-readmodels-20261014T2030/artifacts/off-lectern-suggestions/receipt.json` and the `off-quick-reads` sibling;
- `/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-13/release/suggestions-query-qualification/final-source/plan-0.json` and `plan-1.json`.

implemented serving contract, 2026-10-15: publish a bounded
candidate shortlist outside the read path; permit stale ranking while
rechecking current visibility, completion, membership and capacity on delivery.
this deliberately relaxes exact request-snapshot ranking. reuse the existing
queue only with an explicit refresh/queue-wait contract; its serial workers do
not guarantee a prompt first build. approximate or work-level vector retrieval
changes relevance policy and needs separate quality qualification.

the [suggestions implementation plan](../suggestions-plan.md) owns the approved
background publication cutover. [its verification](../suggestions-verification.md) records cheap published reads
on the owned 717,006-embedding copy. this does not close the separate
graph-lane and synapse-exclusion work above; those costs remain in background
ranking and discovery.

fresh production observation, 2026-10-14 pacific / 2026-10-15 utc: read-only
inspection of `nexus-api-1` reports source
`0bd6619236ae911bb35741aa2017a4a44312cdf2`, schema `0278`; relevant suggestions
backend and frontend files match checkout `367da80e0`. the bounded last-three-hour
log read (maximum 12,000 lines) contained sixteen completed suggestions requests
between 03:02:55z and 05:53:41z: 6.624–16.182 seconds, median 11.475 seconds.
fifteen quick-reads requests between 03:02:44z and 05:53:30z took 0.408–4.543
seconds, median 0.887 seconds. all logged status 200.

suggestions extrema: request `5c6e0d6a-ffc3-4297-a4ab-efa5aa2aa684` at
05:47:35.816876z (6,623.59 ms), and
`c0af9342-20f6-463d-8aad-15ae5d76ed29` at 05:47:09.963413z (16,182.37 ms).
these are api response-header timings from `RequestIDMiddleware`, not browser
receipt/render proof, not a count of abandoned requests, and not a fresh
benchmark; no product read was generated for this log inspection.
