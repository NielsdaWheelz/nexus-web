# source acceptance can commit without enqueued work

status: open
origin: 2026-09-26 static processing-pipeline review
area: durable source admission

`services/media_source_ingest.py:827-831` commits url acceptance before
enqueueing; refresh commits at `1559` before enqueueing after `1560`.
`tasks/reconcile_stale_ingest_media.py:24-41` only examines extracting media
with a processing start time. a process exit in that commit gap can leave an
accepted attempt without a job while media remains pending, ready or failed.
`services/imports.py:241-242,784` projects it as active/queued without recovery.
this is a static crash-window finding; no such live row was observed in the
2026-09-26 failure inventory.

commit durable acceptance and its queue work atomically where input is already
durable. reconcile by source-attempt ownership when admission requires an
external boundary. use the existing database queue, not a second scheduler.

acceptance: interrupt admission at its commit/enqueue boundary; the accepted
intent is either absent or has recoverable work, and reconciliation converges
without duplicate publication.
