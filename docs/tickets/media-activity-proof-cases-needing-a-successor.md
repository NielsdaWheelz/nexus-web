# `test_media_activity.py` cases with no successor owner yet

**Status:** open (blocks Track C2's deletion of the file)
**Origin:** 2026-09-08, imports workspace hard cutover, Track C1 (reviewer finding)
**Area:** `python/tests/service/test_media_activity.py`,
`python/tests/service/test_imports.py`

## What is wrong

Contract §4 makes `python/tests/service/test_imports.py` the canonical owner of
the imports query and has Track C2 delete `test_media_activity.py`. Track C1
adapted most of that file's risks, and added two more after review
(`test_terminal_source_failure_without_a_recorded_code_still_needs_attention`,
`test_settled_index_outcome_is_complete_and_asks_for_nothing`). These named
cases still have no successor anywhere, so deleting the file today would drop
proven risks (`docs/local-rules/testing-standards.md` §§13–14: a replacement
must name the same risk).

- `:41 test_activity_composes_queue_progress_index_and_viewer_visibility` —
  `waiting_reason` Queue/Capacity/RetryBackoff, `next_retry_at`, and counted
  progress on an active row. `test_imports.py` asserts an Active state only for
  an upload in verification, so no imports proof reads a queue-derived reason.
- `:290 test_activity_orders_lifecycle_evidence_not_media_edits` — ordering and
  `updated_at` come from lifecycle evidence, never from unrelated media edits
  (contract D13).
- `:534 test_failed_index_state_without_exact_current_dead_job_is_invariant_defect`
  — `test_imports.py::test_failed_index_without_its_exact_dead_job_is_still_a_defect`
  carries only the "no job at all" case; the parametrization over a pending /
  failed / running / succeeded non-exact job is unproven.
- `:643 test_published_attempt_ignores_stale_source_failure_without_in_flight_progress`
  — a published run with a later dead job is silent, not attention.
- `:431 test_ingest_health_projects_upload_publication_and_resource_facts` —
  `get_ingest_recovery_health`, whose owner is Track B, not the query.

Track B's contract §3 proofs (`test_import_source_recovery.py`,
`test_import_index_recovery.py`) cover recovery admission, not classification,
so they do not claim any of these.

## Proposed fix

Before Track C2 deletes `test_media_activity.py`, carry the first four rows into
`test_imports.py` as named cases (the third as a parametrization of the existing
defect case), and confirm the fifth is owned by a Track B proof. Retire a row
only by naming, in this ticket, the risk it stops carrying and why.

## Acceptance

`test_media_activity.py` is deleted only when every row above is either a named
case in an owner proof or a recorded, justified retirement, and
`pytest:python/tests/service/test_imports.py` is green.
