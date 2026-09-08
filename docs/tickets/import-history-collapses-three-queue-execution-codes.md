# Import history collapses three queue execution codes to `E_WORKER_HANDLER_FAILED`

**Status:** open (accepted for the cutover; degrades inspector precision only)
**Origin:** Imports workspace cutover, Track A, 2026-09-08
**Area:** `python/nexus/schemas/import_history.py` (`SafeFailureCode`,
`queue_failure_code`); `python/nexus/jobs/worker.py`

## What is wrong

`SafeFailureCode` is composed exactly as contract D5 specifies: the
upload-verification alias, the two new upload codes, and every
`ApiErrorCode.E_*` token the source-ingest adapter modules reference, plus
`E_RESOURCE_LIMIT`, `E_WORKER_INTERRUPTED` and `E_WORKER_HANDLER_FAILED`.

`python/nexus/jobs/worker.py` can also write `E_JOB_KIND_UNKNOWN`,
`E_WORKER_CHILD_DEFECT` and `E_WORKER_TASK_FAILED` to
`background_jobs.error_code`. D5 does not list them, so the queue seam's total
`queue_failure_code` maps all three to `E_WORKER_HANDLER_FAILED`
(`schemas/import_history.py`, proved by
`python/tests/kernel/test_import_history_schema.py::
test_queue_failure_code_is_total_and_assume_defects_on_an_uncatalogued_code`).

Consequence: an import whose execution died from an unknown job kind, a child
defect, or a task-level failure shows the generic execution failure in the
Imports inspector. The precise code is still on `background_jobs.error_code`,
so nothing is lost durably — only the reader's explanation is coarser.

## Prerequisites

Track E's copy owner must have a distinct template for each code added, or the
new codes reach the browser with no copy.

## Proposed fix

Add `E_JOB_KIND_UNKNOWN`, `E_WORKER_CHILD_DEFECT` and `E_WORKER_TASK_FAILED`
to the `SafeFailureCode` literal, extend the kernel catalog scan to cover
`nexus/jobs/worker.py` and `nexus/jobs/queue.py` the way it covers
`nexus/storage/client.py`, and add the three copy templates.

## Acceptance

A dead job carrying one of the three codes shows that code in the inspector,
and adding a new `E_*` literal to `jobs/worker.py` without adding it to the
catalog fails `test_safe_failure_code_catalog_names_every_owner_failure_code`.
