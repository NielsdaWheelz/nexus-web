from datetime import UTC, date, datetime, timedelta
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


def _recovery_settings(
    *,
    stale_seconds: int = 60,
    max_attempts: int = 3,
    semantic_batch_limit: int = 50,
    semantic_retry_failed_seconds: int = 300,
):
    return SimpleNamespace(
        ingest_stale_extracting_seconds=stale_seconds,
        ingest_stale_requeue_max_attempts=max_attempts,
        ingest_semantic_repair_batch_limit=semantic_batch_limit,
        ingest_semantic_failed_retry_seconds=semantic_retry_failed_seconds,
    )


def _insert_extracting_podcast_with_reserved_quota(
    db: Session,
    *,
    attempts: int,
    started_seconds_ago: int,
    reserved_minutes: int,
) -> tuple[UUID, UUID, date]:
    media_id = uuid4()
    user_id = uuid4()
    started_at = datetime.now(UTC) - timedelta(seconds=started_seconds_ago)
    usage_date = datetime.now(UTC).date()

    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text(
            """
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
                :media_id,
                'podcast_episode',
                'stale podcast media',
                'extracting',
                :attempts,
                :started_at,
                :user_id
            )
            """
        ),
        {
            "media_id": media_id,
            "attempts": attempts,
            "started_at": started_at,
            "user_id": user_id,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                last_request_reason,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                'running',
                'none',
                'none',
                'search',
                :started_at,
                :started_at
            )
            """
        ),
        {"media_id": media_id, "started_at": started_at},
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_transcription_jobs (
                media_id,
                requested_by_user_id,
                request_reason,
                reserved_minutes,
                reservation_usage_date,
                status,
                attempts,
                started_at,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :user_id,
                'search',
                :reserved_minutes,
                :usage_date,
                'running',
                1,
                :started_at,
                :started_at,
                :started_at
            )
            """
        ),
        {
            "media_id": media_id,
            "user_id": user_id,
            "reserved_minutes": reserved_minutes,
            "usage_date": usage_date,
            "started_at": started_at,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_transcription_usage_daily (
                user_id,
                usage_date,
                minutes_used,
                minutes_reserved,
                updated_at
            )
            VALUES (
                :user_id,
                :usage_date,
                0,
                :minutes_reserved,
                :updated_at
            )
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "minutes_reserved": reserved_minutes,
            "updated_at": started_at,
        },
    )
    db.flush()
    return media_id, user_id, usage_date


def _insert_ready_podcast_with_semantic_backlog(
    db: Session,
    *,
    semantic_status: str,
    updated_seconds_ago: int,
) -> tuple[UUID, UUID]:
    media_id = uuid4()
    user_id = uuid4()
    version_id = uuid4()
    updated_at = datetime.now(UTC) - timedelta(seconds=updated_seconds_ago)

    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text(
            """
            INSERT INTO media (
                id,
                kind,
                title,
                processing_status,
                external_playback_url,
                created_by_user_id,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                'podcast_episode',
                'semantic backlog podcast',
                'ready_for_reading',
                'https://cdn.example.com/semantic.mp3',
                :user_id,
                :updated_at,
                :updated_at
            )
            """
        ),
        {
            "media_id": media_id,
            "user_id": user_id,
            "updated_at": updated_at,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_transcript_versions (
                id,
                media_id,
                version_no,
                transcript_coverage,
                is_active,
                request_reason,
                created_by_user_id,
                created_at,
                updated_at
            )
            VALUES (
                :version_id,
                :media_id,
                1,
                'full',
                true,
                'search',
                :user_id,
                :updated_at,
                :updated_at
            )
            """
        ),
        {
            "version_id": version_id,
            "media_id": media_id,
            "user_id": user_id,
            "updated_at": updated_at,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                active_transcript_version_id,
                last_request_reason,
                last_error_code,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                'ready',
                'full',
                :semantic_status,
                :version_id,
                'search',
                :last_error_code,
                :updated_at,
                :updated_at
            )
            """
        ),
        {
            "media_id": media_id,
            "semantic_status": semantic_status,
            "version_id": version_id,
            "last_error_code": "E_INTERNAL" if semantic_status == "failed" else None,
            "updated_at": updated_at,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_transcript_segments (
                transcript_version_id,
                media_id,
                segment_idx,
                canonical_text,
                t_start_ms,
                t_end_ms,
                speaker_label,
                created_at
            )
            VALUES
                (
                    :version_id,
                    :media_id,
                    0,
                    'semantic repair segment one',
                    0,
                    1300,
                    'Host',
                    :updated_at
                ),
                (
                    :version_id,
                    :media_id,
                    1,
                    'semantic repair segment two',
                    1500,
                    2900,
                    'Guest',
                    :updated_at
                )
            """
        ),
        {
            "version_id": version_id,
            "media_id": media_id,
            "updated_at": updated_at,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_transcript_chunks (
                transcript_version_id,
                media_id,
                chunk_idx,
                chunk_text,
                t_start_ms,
                t_end_ms,
                embedding,
                embedding_model,
                created_at
            )
            VALUES
                (
                    :version_id,
                    :media_id,
                    0,
                    'legacy stale chunk one',
                    0,
                    1300,
                    '[0.1,0.2,0.3]'::jsonb,
                    'hash_v1_frozen_0026',
                    :updated_at
                ),
                (
                    :version_id,
                    :media_id,
                    1,
                    'legacy stale chunk two',
                    1500,
                    2900,
                    '[0.3,0.2,0.1]'::jsonb,
                    'hash_v1_frozen_0026',
                    :updated_at
                )
            """
        ),
        {
            "version_id": version_id,
            "media_id": media_id,
            "updated_at": updated_at,
        },
    )
    db.flush()
    return media_id, version_id


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
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["scanned"] >= 1, f"Expected at least one stale row scanned, got: {result}"
    assert result["requeued"] >= 1, f"Expected at least one stale row requeued, got: {result}"
    queued_count = db_session.execute(
        text(
            """
            SELECT COUNT(*)
            FROM background_jobs
            WHERE kind = 'ingest_pdf'
              AND payload->>'media_id' = :media_id
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    assert queued_count >= 1, (
        "expected stale pdf requeue to persist an ingest_pdf queue row "
        f"for media_id={media_id}, got {queued_count}"
    )

    db_session.expire_all()
    refreshed = db_session.get(Media, media_id)
    assert refreshed.processing_status == ProcessingStatus.extracting
    assert refreshed.processing_attempts == 2


def test_reconciler_requeues_stale_podcast_episode_when_attempts_below_limit(
    db_session: Session,
):
    media_id = _insert_extracting_media(
        db_session,
        kind="podcast_episode",
        attempts=0,
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
    assert result["requeued"] >= 1, f"Expected at least one stale row requeued, got: {result}"
    queued_count = db_session.execute(
        text(
            """
            SELECT COUNT(*)
            FROM background_jobs
            WHERE kind = 'podcast_transcribe_episode_job'
              AND payload->>'media_id' = :media_id
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    assert queued_count >= 1, (
        "expected stale podcast requeue to persist one transcription queue row "
        f"for media_id={media_id}, got {queued_count}"
    )

    db_session.expire_all()
    refreshed = db_session.get(Media, media_id)
    assert refreshed.processing_status == ProcessingStatus.extracting
    assert refreshed.processing_attempts == 1


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


def test_reconciler_fail_close_repairs_podcast_transcript_state_and_quota(db_session: Session):
    media_id, user_id, usage_date = _insert_extracting_podcast_with_reserved_quota(
        db_session,
        attempts=3,
        started_seconds_ago=300,
        reserved_minutes=12,
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

    assert result["failed"] >= 1, f"expected stale podcast to fail closed, got: {result}"

    db_session.expire_all()
    media = db_session.get(Media, media_id)
    assert media is not None
    assert media.processing_status == ProcessingStatus.failed
    assert media.last_error_code == "E_INGEST_TIMEOUT"

    transcript_state_row = db_session.execute(
        text(
            """
            SELECT transcript_state, transcript_coverage, last_error_code
            FROM media_transcript_states
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert transcript_state_row is not None
    assert transcript_state_row[0] == "failed_provider"
    assert transcript_state_row[1] == "none"
    assert transcript_state_row[2] == "E_INGEST_TIMEOUT"

    job_row = db_session.execute(
        text(
            """
            SELECT status, error_code, reserved_minutes, reservation_usage_date
            FROM podcast_transcription_jobs
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert job_row is not None
    assert job_row[0] == "failed"
    assert job_row[1] == "E_INGEST_TIMEOUT"
    assert int(job_row[2] or 0) == 0
    assert job_row[3] is None

    usage_row = db_session.execute(
        text(
            """
            SELECT minutes_used, minutes_reserved
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id AND usage_date = :usage_date
            """
        ),
        {"user_id": user_id, "usage_date": usage_date},
    ).fetchone()
    assert usage_row is not None
    assert int(usage_row[0] or 0) == 0
    assert int(usage_row[1] or 0) == 0


def test_reconciler_repairs_pending_semantic_backlog_for_ready_podcast_transcripts(
    db_session: Session,
):
    media_id, version_id = _insert_ready_podcast_with_semantic_backlog(
        db_session,
        semantic_status="pending",
        updated_seconds_ago=3600,
    )

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(
                stale_seconds=10_000_000,
                max_attempts=3,
                semantic_batch_limit=5000,
                semantic_retry_failed_seconds=300,
            ),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["semantic_scanned"] >= 1, (
        f"expected semantic backlog scan to include pending media row, got: {result}"
    )
    assert result["semantic_repaired"] >= 1, (
        f"expected pending semantic row to be repaired, got: {result}"
    )

    db_session.expire_all()
    state_row = db_session.execute(
        text(
            """
            SELECT semantic_status, last_error_code
            FROM media_transcript_states
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert state_row is not None
    assert state_row[0] == "ready"
    assert state_row[1] is None

    from nexus.services.semantic_chunks import current_transcript_embedding_model

    model_row = db_session.execute(
        text(
            """
            SELECT DISTINCT embedding_model
            FROM podcast_transcript_chunks
            WHERE transcript_version_id = :transcript_version_id
            ORDER BY embedding_model
            """
        ),
        {"transcript_version_id": version_id},
    ).fetchall()
    assert model_row == [(current_transcript_embedding_model(),)], (
        "semantic repair must fully replace legacy cutover embeddings with current runtime model"
    )


def test_reconciler_repairs_ready_semantic_rows_when_active_model_changes(
    db_session: Session,
):
    media_id, version_id = _insert_ready_podcast_with_semantic_backlog(
        db_session,
        semantic_status="ready",
        updated_seconds_ago=10_000_000,
    )

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(
                stale_seconds=10_000_000,
                max_attempts=3,
                semantic_batch_limit=5000,
                semantic_retry_failed_seconds=300,
            ),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["semantic_scanned"] >= 1, (
        "expected semantic backlog scan to include ready rows that carry stale embeddings, "
        f"got: {result}"
    )
    assert result["semantic_repaired"] >= 1, (
        "expected stale ready row to be auto-repaired when active embedding model changes, "
        f"got: {result}"
    )

    db_session.expire_all()
    state_row = db_session.execute(
        text(
            """
            SELECT semantic_status, last_error_code
            FROM media_transcript_states
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert state_row is not None
    assert state_row[0] == "ready"
    assert state_row[1] is None

    from nexus.services.semantic_chunks import current_transcript_embedding_model

    model_row = db_session.execute(
        text(
            """
            SELECT DISTINCT embedding_model
            FROM podcast_transcript_chunks
            WHERE transcript_version_id = :transcript_version_id
            ORDER BY embedding_model
            """
        ),
        {"transcript_version_id": version_id},
    ).fetchall()
    assert model_row == [(current_transcript_embedding_model(),)], (
        "auto-repair for stale ready rows must converge to the active embedding model"
    )


def test_reconciler_retries_failed_semantic_backlog_after_retry_window(
    db_session: Session,
):
    media_id, version_id = _insert_ready_podcast_with_semantic_backlog(
        db_session,
        semantic_status="failed",
        updated_seconds_ago=7200,
    )

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(
                stale_seconds=10_000_000,
                max_attempts=3,
                semantic_batch_limit=5000,
                semantic_retry_failed_seconds=300,
            ),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["semantic_scanned"] >= 1, (
        f"expected semantic backlog scan to include failed row past retry window, got: {result}"
    )
    assert result["semantic_repaired"] >= 1, (
        f"expected failed semantic row to retry and repair, got: {result}"
    )

    db_session.expire_all()
    state_row = db_session.execute(
        text(
            """
            SELECT semantic_status, last_error_code
            FROM media_transcript_states
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert state_row is not None
    assert state_row[0] == "ready"
    assert state_row[1] is None

    chunk_count = db_session.execute(
        text(
            """
            SELECT COUNT(*)
            FROM podcast_transcript_chunks
            WHERE transcript_version_id = :transcript_version_id
            """
        ),
        {"transcript_version_id": version_id},
    ).scalar()
    assert int(chunk_count or 0) == 2, (
        "semantic repair retry must regenerate a complete chunk set for the active transcript version"
    )
