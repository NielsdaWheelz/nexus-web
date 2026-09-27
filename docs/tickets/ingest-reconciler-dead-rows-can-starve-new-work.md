# dead obligations can monopolize bounded reconciliation

status: open
origin: 2026-09-26 static processing-pipeline review
area: source and index reconciliation

`tasks/reconcile_stale_ingest_media.py:24-61` selects the oldest 25 source or
index obligations before checking their queue ownership.
`services/media_source_ingest.py:1291-1296` returns suspended for an exact dead
job without changing the selection order. 25 such old rows can occupy every
batch indefinitely and prevent younger jobless work from being discovered.
this is a static finding, not an observed production starvation incident.

filter out obligations already governed by an eligible live or dead queue row
before applying the bounded discovery limit. preserve explicit dead-job repair;
do not turn reconciliation into automatic redrive of terminal failures.

acceptance: with 25 older dead obligations, a younger jobless recoverable
obligation is discovered and enqueued exactly once; dead jobs remain suspended.
