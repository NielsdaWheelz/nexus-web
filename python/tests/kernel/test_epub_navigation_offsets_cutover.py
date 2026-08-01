"""Pure stopped-world state model for the EPUB navigation-offset repair."""

from __future__ import annotations

from uuid import UUID

import pytest

from nexus.ops.epub_navigation_offsets_cutover import (
    ActiveRepairJob,
    DeferredMedia,
    classify_repair_action,
    scope_repair_jobs,
)

_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000800")
_FOREIGN_MEDIA_ID = UUID("00000000-0000-0000-0000-000000000801")
_OWNER_ID = UUID("00000000-0000-0000-0000-000000000802")
_ATTEMPT_ID = UUID("00000000-0000-0000-0000-000000000803")


def _media(processing_status: str, attempt_status: str) -> DeferredMedia:
    return DeferredMedia(
        media_id=_MEDIA_ID,
        owner_user_id=_OWNER_ID,
        attempt_id=_ATTEMPT_ID,
        processing_status=processing_status,
        attempt_status=attempt_status,
    )


def test_cutover_state_model_admits_only_resumable_media_and_owned_dead_work() -> None:
    resumable_cases = (
        ("ready_for_reading", "succeeded", "enqueue"),
        ("extracting", "accepted", "resume"),
        ("extracting", "queued", "resume"),
        ("extracting", "running", "resume"),
    )
    for processing_status, attempt_status, expected in resumable_cases:
        actual = classify_repair_action(_media(processing_status, attempt_status))
        assert actual == expected, (
            "cutover misclassified a resumable source state: "
            f"processing={processing_status} attempt={attempt_status} actual={actual}"
        )

    rejected_cases = (
        ("failed", "failed"),
        ("ready_for_reading", "failed"),
        ("extracting", "failed"),
        ("extracting", "succeeded"),
    )
    for processing_status, attempt_status in rejected_cases:
        with pytest.raises(
            RuntimeError,
            match="non-resumable source state",
        ):
            classify_repair_action(_media(processing_status, attempt_status))

    relevant_dead = ActiveRepairJob(
        job_id=UUID("00000000-0000-0000-0000-000000000820"),
        kind="media_content_reindex_job",
        status="dead",
        media_id=_MEDIA_ID,
    )
    foreign_dead = ActiveRepairJob(
        job_id=UUID("00000000-0000-0000-0000-000000000821"),
        kind="media_content_reindex_job",
        status="dead",
        media_id=_FOREIGN_MEDIA_ID,
    )
    foreign_pending = ActiveRepairJob(
        job_id=UUID("00000000-0000-0000-0000-000000000822"),
        kind="ingest_media_source",
        status="pending",
        media_id=_FOREIGN_MEDIA_ID,
    )

    scoped_jobs = scope_repair_jobs(
        (relevant_dead, foreign_dead, foreign_pending),
        relevant_dead_media_ids=frozenset({_MEDIA_ID}),
    )

    assert scoped_jobs == (relevant_dead, foreign_pending), (
        f"cutover job scope admitted the wrong stopped-world work: {scoped_jobs!r}"
    )
