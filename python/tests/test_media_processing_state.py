from datetime import UTC, datetime

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.services.media_processing_state import mark_ready_for_reading, reset_for_reingest


class FlushRecorder:
    flushed = False

    def flush(self) -> None:
        self.flushed = True


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
