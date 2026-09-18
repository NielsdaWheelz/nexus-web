# internal ingest operator routes have no known client

status: open (capability decision) · origin: 2026-09-17 slop sweep, updated
2026-09-17 cleanup · area: ingest operations · oi-142

`python/nexus/api/routes/internal_ingest.py:1-87` registers POST
`/internal/ingest/reconcile`, GET `/internal/ingest/reconcile/health`, and POST
`/internal/ingest/{content-index,source}/{media_id}/retry-dead`. no repository
script or browser client calls these routes. the cutover document mentions
them at `docs/cutovers/media-pipeline-reliability-hard-cutover.md:945-951`.
they are reachable by authenticated operator requests with `X-Nexus-Internal`;
absence of a repository caller does not establish that an HTTP interface is
unused. the earlier claim that these routes had no entry point was incorrect.

prerequisite: establish whether these manual operator capabilities are wanted.
if retained, record them as an intentional operations interface. if removed,
delete the router, its three response schemas, and any newly orphaned health
or enqueue wrapper. preserve the automatic ingest reconciler and the
viewer-facing `repair_dead_source_execution` and `repair_dead_media_reindex`.

acceptance: the operator interface is deliberately retained or completely
removed, and viewer retries and automatic reconciliation still work.
