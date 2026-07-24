"""Focused integration tests for the media-pipeline reliability cutover."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.jobs.queue import JobExecutionContext, enqueue_job
from nexus.services.content_indexing import (
    ContentIndexPlan,
    IndexOwner,
    ensure_media_content_reindex_job,
    prepare_media_content_reindex,
    publish_media_content_reindex,
    request_media_content_reindex,
)
from nexus.services.media import get_media_for_viewer, read_event_snapshot
from nexus.services.source_publication import (
    SourcePublicationFence,
    SourcePublicationSuperseded,
    run_source_publication_phase,
)
from tests.factories import create_pdf_media_with_text, get_user_default_library

pytestmark = pytest.mark.integration


def _ready_pdf(db: Session, user_id: UUID) -> UUID:
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    media_id = create_pdf_media_with_text(
        db,
        user_id,
        library_id,
        plain_text="A readable document survives operation suspension.",
        page_count=1,
        page_spans=[(0, 49)],
        status="ready_for_reading",
    )
    db.execute(
        text(
            """
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:media_id, :storage_path, 'application/pdf', 128)
            """
        ),
        {"media_id": media_id, "storage_path": f"pipeline-tests/{media_id}.pdf"},
    )
    db.commit()
    return media_id


def _dead_job(
    db: Session,
    *,
    kind: str,
    payload: dict[str, object],
) -> UUID:
    job = enqueue_job(db, kind=kind, payload=payload, max_attempts=3)
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'dead', attempts = 3, finished_at = now()
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    return job.id


def _source_attempt(
    db: Session,
    *,
    media_id: UUID,
    user_id: UUID,
    status: str = "running",
    attempt_no: int = 1,
) -> UUID:
    attempt_id = uuid4()
    db.execute(
        text(
            """
            INSERT INTO media_source_attempts (
                id, media_id, created_by_user_id, source_type, attempt_no,
                status, intent_key, source_payload
            )
            VALUES (
                :attempt_id, :media_id, :user_id, 'uploaded_pdf_file',
                :attempt_no, :status, :intent_key, '{}'::jsonb
            )
            """
        ),
        {
            "attempt_id": attempt_id,
            "media_id": media_id,
            "user_id": user_id,
            "attempt_no": attempt_no,
            "status": status,
            "intent_key": f"pipeline-test:{media_id}:{attempt_no}",
        },
    )
    return attempt_id


def test_current_dead_source_job_projects_suspended_without_closing_reader(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_pdf(db_session, bootstrapped_user)
    attempt_id = _source_attempt(
        db_session,
        media_id=media_id,
        user_id=bootstrapped_user,
    )
    job_id = _dead_job(
        db_session,
        kind="ingest_media_source",
        payload={
            "media_id": str(media_id),
            "attempt_id": str(attempt_id),
            "actor_user_id": str(bootstrapped_user),
            "request_id": None,
        },
    )
    db_session.execute(
        text("UPDATE media_source_attempts SET job_id = :job_id WHERE id = :attempt_id"),
        {"job_id": job_id, "attempt_id": attempt_id},
    )
    db_session.flush()

    media = get_media_for_viewer(db_session, bootstrapped_user, media_id)
    snapshot = read_event_snapshot(
        db_session,
        viewer_id=bootstrapped_user,
        media_id=media_id,
    )

    assert media.processing_status == "suspended"
    assert media.capabilities.can_read is True
    assert media.capabilities.can_download_file is True
    assert media.capabilities.can_retry is False
    assert media.capabilities.can_refresh_source is False
    assert snapshot.terminal is True
    assert snapshot.payload["processing_status"] == "suspended"
    assert "retrieval_status" in snapshot.payload
    assert "retrieval_status_reason" in snapshot.payload


def test_current_dead_reindex_job_projects_suspended_retrieval_only(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_pdf(db_session, bootstrapped_user)
    db_session.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind, owner_id, status, status_reason, revision
            )
            VALUES ('media', :media_id, 'indexing', 'source_success', 4)
            """
        ),
        {"media_id": media_id},
    )
    _dead_job(
        db_session,
        kind="media_content_reindex_job",
        payload={
            "media_id": str(media_id),
            "revision": 4,
            "reason": "source_success",
            "request_id": {"kind": "Absent"},
        },
    )
    db_session.flush()

    media = get_media_for_viewer(db_session, bootstrapped_user, media_id)

    assert media.processing_status == "ready_for_reading"
    assert media.retrieval_status == "suspended"
    assert media.capabilities.can_read is True
    assert media.capabilities.can_search is False


def _ready_web_article(db: Session, user_id: UUID) -> UUID:
    media_id = uuid4()
    db.execute(
        text(
            """
            INSERT INTO media (
                id, kind, title, processing_status, created_by_user_id
            )
            VALUES (
                :media_id, 'web_article', 'revision fixture',
                'ready_for_reading', :user_id
            )
            """
        ),
        {"media_id": media_id, "user_id": user_id},
    )
    fragment_id = uuid4()
    canonical_text = "The current source revision owns this exact text."
    db.execute(
        text(
            """
            INSERT INTO fragments (
                id, media_id, idx, html_sanitized, canonical_text
            )
            VALUES (
                :fragment_id, :media_id, 0, '<p>Current revision text.</p>',
                :canonical_text
            )
            """
        ),
        {
            "fragment_id": fragment_id,
            "media_id": media_id,
            "canonical_text": canonical_text,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO fragment_blocks (
                fragment_id, block_idx, start_offset, end_offset
            )
            VALUES (:fragment_id, 0, 0, :end_offset)
            """
        ),
        {"fragment_id": fragment_id, "end_offset": len(canonical_text)},
    )
    return media_id


def test_new_revision_coalesces_waiting_job_and_resets_retry_budget(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_web_article(db_session, bootstrapped_user)
    first = request_media_content_reindex(
        db_session,
        media_id=media_id,
        reason="source_success",
        request_id=None,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'failed',
                attempts = 2,
                available_at = now() + interval '1 hour',
                error_code = 'E_INTERNAL',
                last_error = 'old failure'
            WHERE id = :job_id
            """
        ),
        {"job_id": first.background_job_id},
    )

    second = request_media_content_reindex(
        db_session,
        media_id=media_id,
        reason="operator_repair",
        request_id="new-intent",
    )

    assert second.background_job_id == first.background_job_id
    assert second.revision == first.revision + 1
    row = db_session.execute(
        text(
            """
            SELECT status, attempts, error_code, last_error, payload,
                   available_at <= now()
            FROM background_jobs
            WHERE id = :job_id
            """
        ),
        {"job_id": second.background_job_id},
    ).one()
    assert row[0:4] == ("pending", 0, None, None)
    assert row[4]["revision"] == second.revision
    assert row[5] is True


def test_running_revision_gets_one_waiting_successor(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_web_article(db_session, bootstrapped_user)
    first = request_media_content_reindex(
        db_session,
        media_id=media_id,
        reason="source_success",
        request_id=None,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'running',
                attempts = 1,
                claimed_by = 'old-worker',
                lease_expires_at = now() + interval '5 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": first.background_job_id},
    )

    successor = request_media_content_reindex(
        db_session,
        media_id=media_id,
        reason="source_success",
        request_id=None,
    )

    assert successor.background_job_id != first.background_job_id
    rows = db_session.execute(
        text(
            """
            SELECT id, status, payload->>'revision'
            FROM background_jobs
            WHERE kind = 'media_content_reindex_job'
              AND payload->>'media_id' = :media_id
            ORDER BY id
            """
        ),
        {"media_id": str(media_id)},
    ).all()
    assert {row[1] for row in rows} == {"running", "pending"}
    assert str(successor.revision) in {row[2] for row in rows}


def test_ensure_current_revision_never_bypasses_dead_job(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_web_article(db_session, bootstrapped_user)
    db_session.execute(
        text(
            """
            INSERT INTO content_index_states (
                owner_kind, owner_id, status, status_reason, revision
            )
            VALUES ('media', :media_id, 'indexing', 'source_success', 3)
            """
        ),
        {"media_id": media_id},
    )
    job_id = _dead_job(
        db_session,
        kind="media_content_reindex_job",
        payload={
            "media_id": str(media_id),
            "revision": 3,
            "reason": "source_success",
            "request_id": {"kind": "Absent"},
        },
    )

    intent = ensure_media_content_reindex_job(
        db_session,
        media_id=media_id,
        reason="reconciliation",
        request_id=None,
    )

    assert intent.suspended is True
    assert intent.enqueued is False
    assert intent.background_job_id == job_id


def test_lost_source_claim_rolls_back_authoritative_mutation(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_pdf(db_session, bootstrapped_user)
    original_title = db_session.execute(
        text("SELECT title FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    attempt_id = _source_attempt(
        db_session,
        media_id=media_id,
        user_id=bootstrapped_user,
    )
    job = enqueue_job(
        db_session,
        kind="ingest_media_source",
        payload={
            "media_id": str(media_id),
            "attempt_id": str(attempt_id),
            "actor_user_id": str(bootstrapped_user),
            "request_id": None,
        },
        max_attempts=3,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'running',
                attempts = 1,
                claimed_by = 'new-worker',
                lease_expires_at = now() + interval '5 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.execute(
        text("UPDATE media_source_attempts SET job_id = :job_id WHERE id = :attempt_id"),
        {"job_id": job.id, "attempt_id": attempt_id},
    )
    db_session.commit()

    fence = SourcePublicationFence(
        attempt_id=attempt_id,
        job_id=job.id,
        worker_id="stale-worker",
        attempt_no=1,
    )
    with pytest.raises(SourcePublicationSuperseded):
        run_source_publication_phase(
            session_factory=sessionmaker(
                bind=db_session.get_bind(),
                autocommit=False,
                autoflush=False,
                expire_on_commit=False,
            ),
            label="reject_stale_test_publication",
            fence=fence,
            media_ids=(media_id,),
            mutate=lambda phase_db, _attempt: phase_db.execute(
                text("UPDATE media SET title = 'stale publication' WHERE id = :media_id"),
                {"media_id": media_id},
            ),
        )

    assert (
        db_session.execute(
            text("SELECT title FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        ).scalar_one()
        == original_title
    )


def test_obsolete_revision_cannot_publish_after_successor_request(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = _ready_web_article(db_session, bootstrapped_user)
    first = request_media_content_reindex(
        db_session,
        media_id=media_id,
        reason="source_success",
        request_id=None,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'running',
                attempts = 1,
                claimed_by = 'index-worker',
                lease_expires_at = now() + interval '15 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": first.background_job_id},
    )
    context = JobExecutionContext(
        job_id=first.background_job_id,
        worker_id="index-worker",
        attempt_no=1,
    )
    work = prepare_media_content_reindex(
        db_session,
        media_id=media_id,
        revision=first.revision,
        reason="source_success",
        context=context,
        lease_seconds=900,
    )
    assert work is not None
    db_session.commit()

    request_media_content_reindex(
        db_session,
        media_id=media_id,
        reason="source_success",
        request_id="successor",
    )
    db_session.commit()

    plan = ContentIndexPlan(
        owner=IndexOwner("media", media_id),
        source_kind="web_article",
        blocks=work.blocks,
        chunks=(),
        embedding_provider="test",
        embedding_model="test",
        embedding_dimensions=1,
    )
    result = publish_media_content_reindex(
        db_session,
        work=work,
        plan=plan,
        context=context,
        lease_seconds=900,
    )

    assert result is None
    assert (
        db_session.execute(
            text(
                """
                SELECT count(*)
                FROM content_blocks
                WHERE owner_kind = 'media' AND owner_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).scalar_one()
        == 0
    )
