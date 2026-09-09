# Queue-seam history inserts wait behind `FOR UPDATE` holders of the media row

**Status:** open (hazard; no deadlock cycle identified)
**Origin:** Imports workspace cutover, Track B, 2026-09-08
**Area:** `python/nexus/jobs/history_projections.py`, `python/nexus/jobs/worker.py`

## What is wrong

`media_processing_events.media_id` is a foreign key. Inserting a row takes a
`FOR KEY SHARE` lock on the referenced `media` row, which conflicts with
`FOR UPDATE`. The worker's queue transitions (`fail_job`, dead-letter,
reclaim, reschedule) now insert history in their own transaction, so a
transition for media M waits while another session holds M `FOR UPDATE`
(a source publication phase of another job, a reindex `prepare`, a recovery
admission). Before this cut, queue transitions touched only `background_jobs`
and the capacity row.

Observed during Track B's proofs: a test session that held the media lock after
a refused admission blocked the worker's history insert indefinitely
(`pg_stat_activity`: `INSERT INTO media_processing_events ... Lock transactionid`).
The owner-side fix (admissions roll back on refusal) removed that case; the
coupling itself remains. The holders above never wait on the failing job's row,
so no cycle is known, only a bounded wait.

## Prerequisites

None.

## Proposed fix

Either lock media rows with `FOR NO KEY UPDATE` where the row's key is not
changed (the source publication fences, reindex prepare/publish, recovery
admissions), which does not conflict with the FK's `KEY SHARE`, or record the
queue-envelope history through a media-independent owner row. Prove with a
service case that a queue transition for M does not wait on a concurrent
publication phase of M.

## Acceptance

`fail_job` for a job of media M commits while another session holds M
`FOR NO KEY UPDATE`, and the deadlock detector never fires in the source
recovery proofs.
