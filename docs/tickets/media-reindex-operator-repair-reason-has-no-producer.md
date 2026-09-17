# The `operator_repair` media-reindex reason has no producer

**Status:** open
**Origin:** Imports workspace cutover, Track C2 review round 3, 2026-09-08
**Area:** `python/nexus/services/content_indexing.py`
(`MEDIA_CONTENT_REINDEX_REASONS`)

## What is wrong

`MEDIA_CONTENT_REINDEX_REASONS` admits four payload reasons
(`python/nexus/services/content_indexing.py:75-82`) and
`_parse_payload` rejects anything else
(`python/nexus/tasks/media_content_reindex.py:136`). Only three are ever
written: `source_success`
(`python/nexus/services/media_source_ingest.py:1497,1504`), `reconciliation`
(`python/nexus/tasks/reconcile_stale_ingest_media.py:248`,
`python/nexus/ops/oracle_reconcile.py:262,269`) and `oracle_corpus_seed`
(`python/nexus/services/oracle_corpus.py:350,359`).

`operator_repair` has no producer, at this revision or at `origin/main`: repair
requeues the *existing* dead job, which keeps the reason its enqueue wrote, so
no repair path has ever minted a payload with this reason. at discovery, the only other references were a now-deleted fixture and the
wire documentation in
`docs/cutovers/media-pipeline-reliability-hard-cutover.md:442`.

This surfaced while reverting an undirected `mark_content_index_pending(...,
reason="operator_repair")` write out of `repair_dead_media_reindex` — that write
used the same token for a *status reason*, which is a different vocabulary, so
removing it did not change the payload set either way.

## Prerequisites

None; the decision is local to the reason vocabulary.

## Proposed fix

drop `"operator_repair"` from `MEDIA_CONTENT_REINDEX_REASONS` and delete the
token from the cutover document's payload example.

## Acceptance

Every member of `MEDIA_CONTENT_REINDEX_REASONS` is written by a named product
transition.
