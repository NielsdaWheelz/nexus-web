status: open
origin: 2026-09-14 maximum publication worker review
area: worker runtime composition

`web_article_ingest.py:63-81` selects `local_node_ingest_command()` from
`Environment.TEST`, while `node_ingest.py:16` derives a checkout path with
`parents[3]`. a packaged `/app/nexus` worker running the real local test stack
therefore selects `/node/ingest/ingest.mjs`, although Docker ships
`/app/node/ingest/ingest.mjs`. this is the same source-supported composition
hazard exposed for reader scripts by run `2d62e6863b9d280e`; the actual adapter now fails in run `e2e35ed86a0b8eb9`: the configured
checkout entrypoint is ignored and `Node ingest script is unavailable` is raised.
this is a local adapter observation; packaged web extraction remains pending.

separate runtime/package composition from the product data environment. preserve
explicit local execution and the maintained Node ingest dependency directory;
do not add filesystem fallback probes or make production tests use another path.

acceptance: actual packaged worker under the test data environment performs its
real Node extraction, and the checkout path remains usable through its explicit
composition. capture a behavioral red/green at that boundary.

current correction separates the explicit absolute script setting from data policy.
checkout launchers and the test controller supply the path; production publication
must reject both the old ambient variable and the new local composition override.
local adapter and before-mutation deployment proofs are in progress. installed
image proof also checks reader script resources in distribution metadata, so a
source-copy path cannot conceal a missing wheel member.
