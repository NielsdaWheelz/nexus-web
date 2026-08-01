"""Stopped-world operator contract for the EPUB offset cutover."""

from uuid import uuid4

import pytest

from nexus.ops.epub_navigation_offsets_cutover import (
    ActiveRepairJob,
    CutoverCensus,
    DeferredMedia,
    classify_repair_action,
    require_converged,
    scope_repair_jobs,
)

pytestmark = pytest.mark.unit


def _media(*, processing_status: str, attempt_status: str) -> DeferredMedia:
    return DeferredMedia(
        media_id=uuid4(),
        owner_user_id=uuid4(),
        attempt_id=uuid4(),
        processing_status=processing_status,
        attempt_status=attempt_status,
    )


def test_ready_succeeded_media_enqueues_one_canonical_refresh():
    assert (
        classify_repair_action(
            _media(processing_status="ready_for_reading", attempt_status="succeeded")
        )
        == "enqueue"
    )


@pytest.mark.parametrize("attempt_status", ["accepted", "queued", "running"])
def test_in_flight_media_resumes_its_durable_attempt(attempt_status: str):
    assert (
        classify_repair_action(
            _media(processing_status="extracting", attempt_status=attempt_status)
        )
        == "resume"
    )


@pytest.mark.parametrize(
    ("processing_status", "attempt_status"),
    [
        ("failed", "failed"),
        ("ready_for_reading", "failed"),
        ("extracting", "succeeded"),
    ],
)
def test_non_resumable_media_state_fails_closed(
    processing_status: str,
    attempt_status: str,
):
    with pytest.raises(RuntimeError, match="non-resumable source state"):
        classify_repair_action(
            _media(
                processing_status=processing_status,
                attempt_status=attempt_status,
            )
        )


def test_convergence_requires_an_empty_current_unresolved_job_set():
    census = CutoverCensus(
        revision="0208",
        deferred_rows=0,
        media=(),
        active_jobs=(
            ActiveRepairJob(
                job_id=uuid4(),
                kind="ingest_media_source",
                status="dead",
                media_id=uuid4(),
            ),
        ),
    )

    with pytest.raises(RuntimeError, match="did not converge"):
        require_converged(census)


def test_convergence_accepts_only_the_empty_repaired_census():
    census = CutoverCensus(
        revision="0208",
        deferred_rows=0,
        media=(),
        active_jobs=(),
    )

    require_converged(census)


def test_job_scope_keeps_claimable_foreign_work_and_only_relevant_dead_jobs():
    affected_media_id = uuid4()
    foreign_media_id = uuid4()
    affected_dead = ActiveRepairJob(
        job_id=uuid4(),
        kind="media_content_reindex_job",
        status="dead",
        media_id=affected_media_id,
    )
    foreign_dead = ActiveRepairJob(
        job_id=uuid4(),
        kind="media_content_reindex_job",
        status="dead",
        media_id=foreign_media_id,
    )
    foreign_pending = ActiveRepairJob(
        job_id=uuid4(),
        kind="ingest_media_source",
        status="pending",
        media_id=foreign_media_id,
    )

    assert scope_repair_jobs(
        (affected_dead, foreign_dead, foreign_pending),
        relevant_dead_media_ids=frozenset({affected_media_id}),
    ) == (affected_dead, foreign_pending)
