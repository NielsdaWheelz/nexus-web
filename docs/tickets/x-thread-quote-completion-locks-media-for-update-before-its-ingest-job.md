# X-thread quote completion holds the quote media `FOR UPDATE` before locking its running ingest job

**Status:** open (residual lock cycle outside Track B's files)
**Origin:** Imports workspace cutover, Track B review fix, 2026-09-08
**Area:** `python/nexus/services/x_ingest.py` (`_replace_x_post_snapshot_artifacts`),
`python/nexus/services/reader_publication.py` (`replace_reader_publication`),
`python/nexus/services/media_source_ingest.py` (`complete_x_post_snapshot_attempt`)

## What is wrong

The worker's queue transitions for `ingest_media_source` insert
`media_processing_events`, whose FK takes `KEY SHARE` on the media row. Every
Track B owner path that goes on to lock queue rows now holds the media
`FOR NO KEY UPDATE`, which admits that share (proved by
`test_import_source_recovery.py::test_handler_failure_schedules_a_retry_without_waiting_on_the_owners_media_lock`).

One path outside those files still holds `FOR UPDATE` first: inside the
`publish_x_thread_artifacts` phase, `_replace_x_post_snapshot_artifacts` calls
`replace_reader_publication`, which locks the quote-post media
`with_for_update()`, and then `complete_x_post_snapshot_attempt` calls
`lock_jobs_for_payload` on that media's in-flight ingest job with no status
filter. If that child job is `running` and its worker is inside `fail_job` /
`complete_job` at that moment (holding the job row, inserting the child's
history), the two transactions wait on each other and PostgreSQL aborts one.
The other reader-publication phases (`publish_web_article_artifacts`, the PDF/EPUB
file publish) also take `FOR UPDATE`, but they lock no queue rows, so they only
delay a transition until they commit.

## Prerequisites

None.

## Proposed fix

Either lock the media `FOR NO KEY UPDATE` in `replace_reader_publication` (its
key never changes; `FOR SHARE` readers still conflict with it), or make
`complete_x_post_snapshot_attempt` lock only non-running queue rows for the
attempt (a running row is never superseded there). Prove it with a two-session
case in the X ingest owner proof: one session holding the quote media through
`replace_reader_publication` then locking its job row, while the worker fails
that job.

## Acceptance

The named case completes without a deadlock, and the source recovery lock-cycle
case stays green.
