"""Stopped-world operator contract for the EPUB offset cutover."""

from uuid import uuid4

import pytest

from nexus.ops.epub_navigation_offsets_cutover import (
    DeferredMedia,
    classify_repair_action,
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
