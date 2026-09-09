# `Refresh source` is offered where the dead-job guard always refuses it

**Status:** open
**Origin:** Imports workspace cutover, Track C2 residual fixes (OI-027 follow-up),
2026-09-09
**Area:** `python/nexus/services/media_source_ingest.py`
(`_raise_if_source_action_not_reacquirable`); `python/nexus/services/capabilities.py`
(`can_refresh_source`)

## What is wrong

`_raise_if_source_action_not_reacquirable`
(`python/nexus/services/media_source_ingest.py:2570-2595`, the dead-job branch
at `:2583-2589`) refuses every source action whose latest attempt still carries
its own `ingest_media_source` job in `dead`. The capability that offers the action does not read that fact:
`can_refresh_source` (`python/nexus/services/capabilities.py:241-248`) is true
for the creator of a refreshable kind whenever the media is
`ready_for_reading` or `failed`, the last error code is not same-source
terminal, and `source_recovery` is not a `RepairSourceOffer`.

The two disagree in a state the product reaches: an import that published and
whose queue row then died (a crash after publication). The media stays
`ready_for_reading`, the attempt stays `succeeded`, `can_repair_source` and
`can_retry` are both false — nothing is offered to recover it — yet
`Refresh source` is offered and every call returns
`409 E_RETRY_NOT_ALLOWED`. Proved directly:
`python/tests/service/test_import_source_recovery.py::test_succeeded_attempt_with_a_later_dead_job_is_complete_and_unrepairable`
builds that state through the real worker and asserts both the capability set
and the refusal.

Note that the guard is **not** reachable in the `repairable` state its old
message named ("Source processing is suspended and requires operator repair.",
removed 2026-09-09). A repairable media projects `processing_status =
"suspended"`, which is not in `_REFRESHABLE_STATUSES`
(`media_source_ingest.py:206-209`), so `refresh_source_for_viewer` refuses
earlier with `E_MEDIA_NOT_READY`, and `repair_source_for_system_media` requires
`attempt.status == "failed"`. Its reachable states are a succeeded or a
terminally failed attempt whose exact job is dead.

## Prerequisites

Decide which side owns the fact:

1. the dead job of a *settled* attempt does not restrict a later source action
   (the guard narrows to attempts that are still nonterminal, which is the
   `repairable` state the offer already covers), or
2. a dead job on the latest attempt suppresses `can_refresh_source`, so the
   command is never offered where it cannot run.

`can_refresh_source` already consumes `source_recovery`
(`capabilities.py:240`), so (2) needs one more fact on the same seam rather
than a new query.

## Proposed fix

Take (1) or (2) and make the offer and the guard read the same fact, then keep
the refusal only for the race (the offer was rendered before the job died).

## Acceptance

For every media a viewer is offered `Refresh source` on, the refresh either
runs or fails only on a state change since the offer was rendered, proved at
`python/tests/service/test_import_source_recovery.py` beside the case above.
