status: open
origin: 2026-09-14 bounded-workspace capacity run 8bb58bd302499f69
area: accepted source / content indexing

actual maximum epub source publishes successfully, then its automatically queued
`media_content_reindex_job` fails in `content_indexing.py:2193` with
`ContentIndexResourceLimitExceeded: Document content exceeds the bounded indexing envelope.`
source sha256: `6190acafd6d9d62d876708a40c901a37490ac7fe81296e600314e20dd909e5a0`.
receipt: `nexus-web-bounded-web-proof/test-results/runs/8bb58bd302499f69/api-capacity-candidate-worker-epub.json`.

inspect token/chunk splitting for the four long unbroken source paragraphs;
preserve complete source positions while bounding actual embedding inputs.
use the existing local external-provider fixture for execution; do not mask the
failure, lower accepted source limits, or dispatch paid providers during sensitivity.

acceptance: the unchanged accepted source completes indexing with bounded chunks,
exact provenance and no omitted text; actual worker qualification includes the
automatic job, with source and image hashes retained.
