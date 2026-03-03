from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, ProcessingStatus
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration


def _insert_extracting_media(
    db: Session,
    *,
    kind: str,
    attempts: int,
    started_seconds_ago: int,
) -> UUID:
    media_id = uuid4()
    user_id = uuid4()
    started_at = datetime.now(UTC) - timedelta(seconds=started_seconds_ago)

    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text("""
            INSERT INTO media (
                id,
                kind,
                title,
                processing_status,
                processing_attempts,
                processing_started_at,
                created_by_user_id
            )
            VALUES (
                :id,
                :kind,
                'stale media',
                'extracting',
                :attempts,
                :started_at,
                :uid
            )
        """),
        {
            "id": media_id,
            "kind": kind,
            "attempts": attempts,
            "started_at": started_at,
            "uid": user_id,
        },
    )
    db.flush()
    return media_id


def _recovery_settings(*, stale_seconds: int = 60, max_attempts: int = 3):
    return SimpleNamespace(
        ingest_stale_extracting_seconds=stale_seconds,
        ingest_stale_requeue_max_attempts=max_attempts,
    )


def test_reconciler_requeues_stale_pdf_when_attempts_below_limit(db_session: Session):
    media_id = _insert_extracting_media(
        db_session,
        kind="pdf",
        attempts=1,
        started_seconds_ago=120,
    )

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(max_attempts=3),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
        patch("nexus.tasks.ingest_pdf.ingest_pdf.apply_async") as mock_dispatch,
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["scanned"] >= 1, f"Expected at least one stale row scanned, got: {result}"
    assert result["requeued"] >= 1, f"Expected at least one stale row requeued, got: {result}"
    mock_dispatch.assert_called()

    db_session.expire_all()
    refreshed = db_session.get(Media, media_id)
    assert refreshed.processing_status == ProcessingStatus.extracting
    assert refreshed.processing_attempts == 2


def test_reconciler_fails_stale_pdf_after_max_recovery_attempts(db_session: Session):
    media_id = _insert_extracting_media(
        db_session,
        kind="pdf",
        attempts=3,
        started_seconds_ago=120,
    )

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(max_attempts=3),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["scanned"] >= 1, f"Expected at least one stale row scanned, got: {result}"
    assert result["failed"] >= 1, f"Expected at least one stale row failed closed, got: {result}"

    db_session.expire_all()
    refreshed = db_session.get(Media, media_id)
    assert refreshed.processing_status == ProcessingStatus.failed
    assert refreshed.failure_stage == FailureStage.other
    assert refreshed.last_error_code == "E_INGEST_TIMEOUT"
