# reindex payload request_id is write-only

status: deferred (needs a data migration) · origin: 2026-09-27, pr-02 backend dead-code sweep (claude session) · area:
jobs / content indexing

`_reindex_payload` (`python/nexus/services/content_indexing.py:1164-1174`)
persists `request_id` as a Presence in every `media_content_reindex_job`
payload, and `_parse_payload`
(`python/nexus/tasks/media_content_reindex.py:84-115`) demands exactly the four
keys `media_id`, `revision`, `reason`, `request_id` and validates the Presence.
nothing reads the value. it is threaded through `request_media_content_reindex`
(`content_indexing.py:1177`) and `ensure_media_content_reindex_job` (`:1256`)
from seven call sites: `tasks/reconcile_stale_ingest_media.py:190`,
`services/oracle_corpus.py:340`, `ops/oracle_reconcile.py:259,266`,
`ops/processing_recovery.py:122`, `services/media_source_ingest.py:2257`,
`services/reader_navigation_repair.py:176`.

why not a plain deletion: dead reindex jobs are never pruned
(`jobs/registry.py` `media_content_reindex_job` has `never_prune_dead=True`) and
repair requeues the stored payload verbatim (`content_indexing.py:1549`
`requeue_dead_job`). a three-key validator alone would fail every pre-existing
pending or dead job. job matching reads only `media_id` and `revision`, so the
key is safe to strip from stored rows.

fix, in one release with a migration:
`UPDATE background_jobs SET payload = payload - 'request_id' WHERE kind = 'media_content_reindex_job'`,
the three-key writer and validator, and removal of the `request_id` params and
their pass-throughs.

acceptance: after upgrade, a pre-existing dead reindex job requeues and
succeeds; `rg request_id` finds nothing on the reindex path.
