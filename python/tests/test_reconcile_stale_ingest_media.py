"""Focused integration tests for enqueue-only media-pipeline reconciliation."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_job
from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        signed_url_expiry_s=300,
        ingest_stale_extracting_seconds=60,
    )


def _reconcile(db: Session) -> dict[str, int]:
    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_settings(),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db),
        ),
        patch(
            "nexus.services.semantic_chunks.build_text_embeddings",
            side_effect=AssertionError("reconciliation must not call an embedding provider"),
        ),
    ):
        return reconcile_stale_ingest_media_job(request_id="reconcile-test")


def _insert_stale_source_attempt(db: Session) -> tuple[UUID, UUID, UUID]:
    user_id = uuid4()
    media_id = uuid4()
    attempt_id = uuid4()
    started_at = datetime.now(UTC) - timedelta(minutes=5)
    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, processing_started_at,
                created_by_user_id
            )
            VALUES (
                :media_id, 'web_article', 'stale source', 'extracting',
                :started_at, :user_id
            )
            """
        ),
        {
            "media_id": media_id,
            "started_at": started_at,
            "user_id": user_id,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO media_source_attempts (
                id, media_id, created_by_user_id, source_type, attempt_no,
                status, intent_key, source_payload, started_at
            )
            VALUES (
                :attempt_id, :media_id, :user_id, 'generic_web_url', 1,
                'running', :intent_key, '{}'::jsonb, :started_at
            )
            """
        ),
        {
            "attempt_id": attempt_id,
            "media_id": media_id,
            "user_id": user_id,
            "intent_key": f"reconcile-test:{media_id}",
            "started_at": started_at,
        },
    )
    db.flush()
    return user_id, media_id, attempt_id


def test_reconciler_recreates_only_a_missing_source_job(db_session: Session):
    user_id, media_id, attempt_id = _insert_stale_source_attempt(db_session)

    result = _reconcile(db_session)

    assert result["source_enqueued"] == 1
    row = (
        db_session.execute(
            text(
                """
            SELECT
                msa.job_id,
                msa.status AS attempt_status,
                j.kind,
                j.status AS job_status,
                j.payload
            FROM media_source_attempts msa
            JOIN background_jobs j ON j.id = msa.job_id
            WHERE msa.id = :attempt_id
            """
            ),
            {"attempt_id": attempt_id},
        )
        .mappings()
        .one()
    )
    assert row["attempt_status"] == "queued"
    assert row["kind"] == "ingest_media_source"
    assert row["job_status"] == "pending"
    assert row["payload"] == {
        "media_id": str(media_id),
        "attempt_id": str(attempt_id),
        "actor_user_id": str(user_id),
        "request_id": "reconcile-test",
    }


def test_reconciler_reports_current_dead_source_job_without_replay(db_session: Session):
    user_id, media_id, attempt_id = _insert_stale_source_attempt(db_session)
    job = enqueue_job(
        db_session,
        kind="ingest_media_source",
        payload={
            "media_id": str(media_id),
            "attempt_id": str(attempt_id),
            "actor_user_id": str(user_id),
            "request_id": None,
        },
        max_attempts=3,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'dead', attempts = 3, finished_at = now()
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.execute(
        text("UPDATE media_source_attempts SET job_id = :job_id WHERE id = :attempt_id"),
        {"job_id": job.id, "attempt_id": attempt_id},
    )
    db_session.flush()

    result = _reconcile(db_session)

    assert result["source_suspended"] == 1
    assert result["source_enqueued"] == 0
    rows = db_session.execute(
        text(
            """
            SELECT id, status, attempts
            FROM background_jobs
            WHERE kind = 'ingest_media_source'
              AND payload->>'attempt_id' = :attempt_id
            """
        ),
        {"attempt_id": str(attempt_id)},
    ).all()
    assert rows == [(job.id, "dead", 3)]


@pytest.mark.parametrize("kind", ["web_article", "epub", "pdf"])
def test_reconciler_ensures_current_document_revision_job(
    db_session: Session,
    kind: str,
):
    user_id = uuid4()
    media_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, created_by_user_id
            )
            VALUES (:media_id, :kind, 'pending index', 'ready_for_reading', :user_id)
            """
        ),
        {"media_id": media_id, "kind": kind, "user_id": user_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind, owner_id, status, status_reason, revision
            )
            VALUES ('media', :media_id, 'pending', 'source_success', 7)
            """
        ),
        {"media_id": media_id},
    )
    db_session.flush()

    result = _reconcile(db_session)

    assert result["content_index_enqueued"] == 1
    payload = db_session.execute(
        text(
            """
            SELECT payload
            FROM background_jobs
            WHERE kind = 'media_content_reindex_job'
              AND payload->>'media_id' = :media_id
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    assert payload["revision"] == 7
    assert payload["reason"] == "reconciliation"


def test_reconciler_dispatches_existing_transcript_semantic_job(db_session: Session):
    user_id = uuid4()
    media_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, created_by_user_id
            )
            VALUES (
                :media_id, 'podcast_episode', 'semantic backlog',
                'ready_for_reading', :user_id
            )
            """
        ),
        {"media_id": media_id, "user_id": user_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id, transcript_state, transcript_coverage,
                semantic_status, last_request_reason
            )
            VALUES (:media_id, 'ready', 'full', 'pending', 'episode_open')
            """
        ),
        {"media_id": media_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO podcast_transcript_segments (
                media_id, segment_idx, canonical_text, t_start_ms, t_end_ms
            )
            VALUES (:media_id, 0, 'semantic repair text', 0, 1000)
            """
        ),
        {"media_id": media_id},
    )
    db_session.flush()

    result = _reconcile(db_session)

    assert result["semantic_enqueued"] == 1
    assert (
        db_session.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE kind = 'podcast_reindex_semantic_job'
                  AND payload->>'media_id' = :media_id
                """
            ),
            {"media_id": str(media_id)},
        ).scalar_one()
        == 1
    )
