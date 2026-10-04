# jobs registry has six pure forwarding adapters

status: open, source-qualified · origin: 2026-10-04 simplify-02 audit at `5e970dce0515fea7d06d8bd1af48f90d39f1c185`, rechecked at `58bdd8a77bb865450c8c197c4c35ca904b2ddaa5` · area: job dispatch

six live adapters in `python/nexus/jobs/registry.py` only lazily import and return `handler(payload=payload, context=context)`. their native tasks already accept that exact keyword contract:

| registry adapter / line | native handler / declaration line |
| --- | --- |
| `_run_media_content_reindex` / 307 | `nexus.tasks.media_content_reindex:media_content_reindex_job` / 23 |
| `_run_dossier_build` / 330 | `nexus.tasks.dossier_build:dossier_build` / 22 |
| `_run_podcast_sync_subscription` / 336 | `nexus.tasks.podcast_sync_subscription:podcast_sync_subscription_job` / 15 |
| `_run_podcast_backfill_subscription` / 342 | `nexus.tasks.podcast_backfill_subscription:podcast_backfill_subscription` / 11 |
| `_run_media_teardown` / 435 | `nexus.tasks.media_teardown:media_teardown` / 59 |
| `_run_storage_object_cleanup` / 441 | `nexus.tasks.storage_object_cleanup:storage_object_cleanup` / 311 |

these are not dead handlers. registry paths dynamically call them. `queue.py:56-76,211-240` stores kind/payload, not a handler path; `worker.py:202,222-228` resolves current registry policy for a claim. `process_executor.py:194,481-483` carries the path only in its ephemeral parent/child request. other adapters perform real argument projection or omit a protocol argument and remain outside this item.

point these six `handler_path` values directly at their native tasks and delete the forwarders, approximately 36 authored lines. preserve lazy resolution, payload/context/result contracts, job kinds, leases, retries, receipts and failure projections. no queued-path migration is needed. prerequisite for deployment: drain/restart old worker parents before removing paths they may still emit into newly started children; do not retain legacy aliases.

acceptance: all six paths resolve with the same signature; focused isolated worker settlement preserves result/error classification and registry metadata; `./scripts/test` passes. no provider or destructive task execution is justified merely to remove forwarding. no runtime qualification has been performed for this proposed slice.
