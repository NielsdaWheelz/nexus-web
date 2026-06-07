from datetime import UTC, datetime
from uuid import uuid4

import pytest

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.services.media_processing_state import (
    mark_extraction_started_by_id,
    mark_failed_by_id,
    mark_ready_for_reading,
    mark_ready_for_reading_by_id,
    reset_for_reingest,
)

pytestmark = pytest.mark.unit


class FlushRecorder:
    flushed = False

    def flush(self) -> None:
        self.flushed = True


class ExecuteRecorder:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def execute(self, _statement: object, params: dict[str, object]) -> None:
        self.calls.append(params)

    def commit(self) -> None:
        raise AssertionError("by-id transition helpers must not commit")


def test_reset_for_reingest_starts_new_attempt_and_clears_failure_metadata():
    db = FlushRecorder()
    media = Media(
        kind="web_article",
        title="Failed article",
        processing_status=ProcessingStatus.failed,
        processing_attempts=1,
        processing_started_at=datetime(2026, 1, 1, tzinfo=UTC),
        processing_completed_at=datetime(2026, 1, 2, tzinfo=UTC),
        failure_stage=FailureStage.extract,
        last_error_code="E_INGEST_FAILED",
        last_error_message="failed",
        failed_at=datetime(2026, 1, 2, tzinfo=UTC),
        updated_at=datetime(2026, 1, 2, tzinfo=UTC),
    )

    reset_for_reingest(db, media)  # type: ignore[arg-type]

    assert media.processing_status == ProcessingStatus.extracting
    assert media.processing_attempts == 2
    assert media.processing_started_at is not None
    assert media.processing_completed_at is None
    assert media.failure_stage is None
    assert media.last_error_code is None
    assert media.last_error_message is None
    assert media.failed_at is None
    assert media.updated_at is not None
    assert db.flushed is True


def test_by_id_transition_helpers_use_canonical_status_values_without_committing():
    db = ExecuteRecorder()
    media_id = uuid4()
    now = datetime(2026, 1, 1, tzinfo=UTC)

    mark_extraction_started_by_id(db, media_id=media_id, now=now)  # type: ignore[arg-type]
    mark_ready_for_reading_by_id(db, media_id=media_id, now=now)  # type: ignore[arg-type]
    mark_failed_by_id(  # type: ignore[arg-type]
        db,
        media_id=media_id,
        stage="transcribe",
        error_code="E_TRANSCRIPTION_FAILED",
        error_message="failed",
        now=now,
    )

    assert [call["processing_status"] for call in db.calls] == [
        ProcessingStatus.extracting.value,
        ProcessingStatus.ready_for_reading.value,
        ProcessingStatus.failed.value,
    ]
    assert db.calls[2]["failure_stage"] == FailureStage.transcribe.value


def test_mark_ready_for_reading_clears_failure_metadata_and_completes_extraction():
    db = FlushRecorder()
    media = Media(
        kind="web_article",
        title="Refreshing article",
        processing_status=ProcessingStatus.extracting,
        processing_attempts=2,
        processing_started_at=datetime(2026, 1, 1, tzinfo=UTC),
        failure_stage=FailureStage.extract,
        last_error_code="E_INGEST_FAILED",
        last_error_message="failed",
        failed_at=datetime(2026, 1, 2, tzinfo=UTC),
    )

    mark_ready_for_reading(db, media)  # type: ignore[arg-type]

    assert media.processing_status == ProcessingStatus.ready_for_reading
    assert media.processing_attempts == 2
    assert media.processing_completed_at is not None
    assert media.failure_stage is None
    assert media.last_error_code is None
    assert media.last_error_message is None
    assert media.failed_at is None
    assert media.updated_at is not None
    assert db.flushed is True
