from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, literal, select, text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, MediaFile, ProcessingStatus, User
from nexus.storage.paths import build_storage_path, build_upload_staging_storage_path
from tests.support.storage import FakeStorageClient
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
    source_type_by_kind = {
        "pdf": "uploaded_pdf_file",
        "epub": "uploaded_epub_file",
        "web_article": "generic_web_url",
        "podcast_episode": "podcast_episode_transcript",
    }
    source_type = source_type_by_kind.get(kind)
    if source_type is not None:
        db.execute(
            text("""
                INSERT INTO media_source_attempts (
                    media_id, created_by_user_id, source_type, attempt_no, status,
                    intent_key, source_payload, started_at
                )
                VALUES (
                    :media_id, :user_id, :source_type, 1, 'running',
                    :intent_key, '{}'::jsonb, :started_at
                )
            """),
            {
                "media_id": media_id,
                "user_id": user_id,
                "source_type": source_type,
                "intent_key": f"test:{source_type}:{media_id}",
                "started_at": started_at,
            },
        )
    db.flush()
    return media_id


def _insert_stale_pending_upload(
    db: Session,
    *,
    age_seconds: int = 600,
    processing_started_seconds_ago: int | None = None,
) -> tuple[UUID, str, str]:
    media_id = uuid4()
    user_id = uuid4()
    created_at = db.execute(
        select(func.now() - (literal(age_seconds) * text("interval '1 second'")))
    ).scalar_one()
    processing_started_at = (
        db.execute(
            select(
                func.now() - (literal(processing_started_seconds_ago) * text("interval '1 second'"))
            )
        ).scalar_one()
        if processing_started_seconds_ago is not None
        else None
    )
    storage_path = build_upload_staging_storage_path(media_id, "pdf")
    final_storage_path = build_storage_path(media_id, "pdf")

    db.add(User(id=user_id))
    db.add(
        Media(
            id=media_id,
            kind="pdf",
            title="abandoned upload",
            processing_status=ProcessingStatus.pending,
            processing_started_at=processing_started_at,
            created_by_user_id=user_id,
            created_at=created_at,
            updated_at=created_at,
        )
    )
    db.add(
        MediaFile(
            media_id=media_id,
            storage_path=storage_path,
            content_type="application/pdf",
            size_bytes=12,
        )
    )
    db.flush()
    return media_id, storage_path, final_storage_path


def _seed_stale_pending_upload_child_rows(db: Session, media_id: UUID) -> None:
    user_id = db.execute(
        text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    default_library_id = uuid4()
    db.execute(
        text("""
            INSERT INTO libraries (id, owner_user_id, name, is_default)
            VALUES (:library_id, :user_id, 'Abandoned Uploads', true)
        """),
        {"library_id": default_library_id, "user_id": user_id},
    )
    db.execute(
        text("""
            INSERT INTO memberships (library_id, user_id, role)
            VALUES (:library_id, :user_id, 'admin')
        """),
        {"library_id": default_library_id, "user_id": user_id},
    )
    db.execute(
        text("""
            INSERT INTO library_entries (library_id, media_id, position)
            VALUES (:library_id, :media_id, 0)
        """),
        {"library_id": default_library_id, "media_id": media_id},
    )
    db.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            VALUES (:library_id, :media_id)
        """),
        {"library_id": default_library_id, "media_id": media_id},
    )
    db.execute(
        text("""
            INSERT INTO user_media_deletions (user_id, media_id)
            VALUES (:user_id, :media_id)
        """),
        {"user_id": user_id, "media_id": media_id},
    )
    db.execute(
        text("""
            INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason)
            VALUES ('media', :media_id, 'failed', 'test_abandoned_upload_cleanup')
        """),
        {"media_id": media_id},
    )
    db.execute(
        text("""
            INSERT INTO resource_edges (
                user_id,
                kind,
                origin,
                source_scheme,
                source_id,
                target_scheme,
                target_id
            )
            VALUES (:user_id, 'context', 'user', 'media', :media_id, 'media', :other_id)
        """),
        {"user_id": user_id, "media_id": media_id, "other_id": uuid4()},
    )


def _assert_stale_pending_upload_child_rows_deleted(db: Session, media_id: UUID) -> None:
    assert _count_rows(db, "library_entries", "media_id = :media_id", media_id=media_id) == 0
    assert (
        _count_rows(db, "default_library_intrinsics", "media_id = :media_id", media_id=media_id)
        == 0
    )
    assert _count_rows(db, "user_media_deletions", "media_id = :media_id", media_id=media_id) == 0
    assert _count_rows(db, "media_file", "media_id = :media_id", media_id=media_id) == 0
    assert (
        _count_rows(
            db,
            "content_index_states",
            "owner_kind = 'media' AND owner_id = :media_id",
            media_id=media_id,
        )
        == 0
    )
    bare_edges = db.execute(
        text("""
            SELECT COUNT(*)
            FROM resource_edges
            WHERE ordinal IS NULL
              AND ((source_scheme = 'media' AND source_id = :media_id)
                OR (target_scheme = 'media' AND target_id = :media_id))
        """),
        {"media_id": media_id},
    ).scalar_one()
    assert int(bare_edges) == 0, "media deletion must clean bare edges (graph cleanup rule 2)"


def _count_rows(db: Session, table: str, where: str, **params: object) -> int:
    return int(db.execute(text(f"SELECT COUNT(*) FROM {table} WHERE {where}"), params).scalar_one())


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
        signed_url_expiry_s=300,
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
) -> UUID:
    media_id = uuid4()
    user_id = uuid4()
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
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
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
            "last_error_code": "E_INTERNAL" if semantic_status == "failed" else None,
            "updated_at": updated_at,
        },
    )
    db.execute(
        text(
            """
            INSERT INTO podcast_transcript_segments (
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
                    :media_id,
                    0,
                    'semantic repair segment one',
                    0,
                    1300,
                    'Host',
                    :updated_at
                ),
                (
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
            "media_id": media_id,
            "updated_at": updated_at,
        },
    )
    db.flush()
    return media_id


def _insert_ready_document_with_pending_content_index(db: Session, *, kind: str) -> UUID:
    media_id = uuid4()
    user_id = uuid4()
    fragment_id = uuid4()
    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text(
            """
            INSERT INTO media (
                id,
                kind,
                title,
                processing_status,
                plain_text,
                page_count,
                created_by_user_id
            )
            VALUES (
                :media_id,
                :kind,
                'Sample indexed document',
                'ready_for_reading',
                :plain_text,
                :page_count,
                :user_id
            )
            """
        ),
        {
            "media_id": media_id,
            "kind": kind,
            "plain_text": "Sample PDF evidence repair needle." if kind == "pdf" else None,
            "page_count": 1 if kind == "pdf" else None,
            "user_id": user_id,
        },
    )
    if kind in {"web_article", "epub"}:
        db.execute(
            text(
                """
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (
                    :fragment_id,
                    :media_id,
                    0,
                    '<p>Sample evidence repair needle.</p>',
                    'Sample evidence repair needle.'
                )
                """
            ),
            {"fragment_id": fragment_id, "media_id": media_id},
        )
    if kind == "video":
        db.execute(
            text(
                """
                INSERT INTO media_transcript_states (
                    media_id,
                    transcript_state,
                    transcript_coverage,
                    semantic_status,
                    last_request_reason
                )
                VALUES (:media_id, 'ready', 'full', 'pending', 'search')
                """
            ),
            {"media_id": media_id},
        )
        db.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    media_id,
                    segment_idx,
                    canonical_text,
                    t_start_ms,
                    t_end_ms,
                    speaker_label
                )
                VALUES (
                    :media_id,
                    0,
                    'Sample video transcript repair needle.',
                    0,
                    1500,
                    'Speaker'
                )
                """
            ),
            {"media_id": media_id},
        )
    if kind == "pdf":
        db.execute(
            text(
                """
                INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                VALUES (:media_id, 'media/test/sample.pdf', 'application/pdf', 1024)
                """
            ),
            {"media_id": media_id},
        )
        db.execute(
            text(
                """
                INSERT INTO pdf_page_text_spans (
                    media_id,
                    page_number,
                    start_offset,
                    end_offset
                )
                VALUES (:media_id, 1, 0, 34)
                """
            ),
            {"media_id": media_id},
        )
    db.execute(
        text(
            """
            INSERT INTO content_index_states (owner_kind, owner_id, status, status_reason)
            VALUES ('media', :media_id, 'pending', 'test')
            """
        ),
        {"media_id": media_id},
    )
    db.flush()
    return media_id


def _mark_content_index_state_stale_indexing(db: Session, *, media_id: UUID) -> None:
    started_at = datetime.now(UTC) - timedelta(hours=2)
    db.execute(
        text(
            """
            UPDATE content_index_states
            SET
                status = 'indexing',
                status_reason = 'stale indexing test',
                updated_at = :started_at
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {"media_id": media_id, "started_at": started_at},
    )
    db.flush()


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
            WHERE kind = 'ingest_media_source'
              AND payload->>'media_id' = :media_id
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    assert queued_count >= 1, (
        "expected stale pdf requeue to persist an ingest_media_source queue row "
        f"for media_id={media_id}, got {queued_count}"
    )
    attempt_row = db_session.execute(
        text(
            """
            SELECT msa.status, msa.job_id
            FROM media_source_attempts msa
            WHERE msa.media_id = :media_id
            ORDER BY msa.attempt_no DESC, msa.created_at DESC, msa.id DESC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert attempt_row is not None
    assert attempt_row.status == "queued"
    assert attempt_row.job_id is not None


def test_reconciler_deletes_stale_pending_upload_and_storage_object(db_session: Session):
    media_id, storage_path, final_storage_path = _insert_stale_pending_upload(db_session)
    _seed_stale_pending_upload_child_rows(db_session, media_id)
    db_session.commit()
    storage = FakeStorageClient()
    storage.put_object(storage_path, b"%PDF-stale", "application/pdf")
    storage.put_object(final_storage_path, b"%PDF-final-orphan", "application/pdf")

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_storage_client",
            return_value=storage,
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["pending_upload_deleted"] >= 1
    assert storage.get_object(storage_path) is None
    assert storage.get_object(final_storage_path) is None
    remaining = db_session.execute(
        text("SELECT COUNT(*) FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    assert remaining == 0
    _assert_stale_pending_upload_child_rows_deleted(db_session, media_id)


def test_reconciler_keeps_pending_upload_with_active_confirmation_claim(
    db_session: Session,
):
    media_id, storage_path, final_storage_path = _insert_stale_pending_upload(
        db_session,
        processing_started_seconds_ago=10,
    )
    db_session.commit()
    storage = FakeStorageClient()
    storage.put_object(storage_path, b"%PDF-stale", "application/pdf")
    storage.put_object(final_storage_path, b"%PDF-final-in-progress", "application/pdf")

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(stale_seconds=60),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_storage_client",
            return_value=storage,
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["pending_upload_deleted"] == 0
    assert storage.get_object(storage_path) == b"%PDF-stale"
    assert storage.get_object(final_storage_path) == b"%PDF-final-in-progress"
    remaining = db_session.execute(
        text("SELECT COUNT(*) FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()
    assert remaining == 1


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
            WHERE kind = 'ingest_media_source'
              AND payload->>'media_id' = :media_id
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    assert queued_count >= 1, (
        "expected stale podcast requeue to persist one source queue row "
        f"for media_id={media_id}, got {queued_count}"
    )

    db_session.expire_all()
    refreshed = db_session.get(Media, media_id)
    assert refreshed.processing_status == ProcessingStatus.extracting
    assert refreshed.processing_attempts == 1


@pytest.mark.parametrize("kind", ["web_article", "epub", "pdf", "video"])
def test_reconciler_repairs_pending_document_content_index(db_session: Session, kind: str):
    media_id = _insert_ready_document_with_pending_content_index(db_session, kind=kind)

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(stale_seconds=10_000_000, semantic_batch_limit=5000),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["content_index_scanned"] >= 1, (
        f"expected content-index scan to include pending {kind}, got: {result}"
    )
    assert result["content_index_repaired"] >= 1, (
        f"expected pending {kind} to be rebuilt, got: {result}"
    )

    row = db_session.execute(
        text(
            """
            SELECT mcis.status, count(cc.id)
            FROM content_index_states mcis
            JOIN content_chunks cc ON cc.owner_kind = mcis.owner_kind AND cc.owner_id = mcis.owner_id
            WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
            GROUP BY mcis.status
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    assert row is not None, f"expected repaired content index for media_id={media_id}"
    assert row[0] == "ready"
    assert row[1] >= 1


def test_reconciler_recovers_stale_indexing_document_content_index(db_session: Session):
    media_id = _insert_ready_document_with_pending_content_index(db_session, kind="web_article")
    _mark_content_index_state_stale_indexing(db_session, media_id=media_id)

    with (
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_settings",
            return_value=_recovery_settings(stale_seconds=60, semantic_batch_limit=5000),
        ),
        patch(
            "nexus.tasks.reconcile_stale_ingest_media.get_session_factory",
            return_value=task_session_factory(db_session),
        ),
    ):
        from nexus.tasks.reconcile_stale_ingest_media import reconcile_stale_ingest_media_job

        result = reconcile_stale_ingest_media_job()

    assert result["content_index_scanned"] >= 1, (
        f"expected stale indexing content-index row to be scanned, got: {result}"
    )
    assert result["content_index_requeued"] >= 1, (
        f"expected stale indexing content-index row to be requeued for repair, got: {result}"
    )
    assert result["content_index_repaired"] >= 1, (
        f"expected stale indexing content-index row to be rebuilt, got: {result}"
    )

    rows = db_session.execute(
        text(
            """
            SELECT
                mcis.status,
                active_chunk.chunk_text
            FROM content_index_states mcis
            JOIN content_chunks active_chunk
                ON active_chunk.owner_kind = mcis.owner_kind
               AND active_chunk.owner_id = mcis.owner_id
            WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    assert rows, f"expected repaired content index for media_id={media_id}"
    assert rows[0][0] == "ready"
    assert rows[0][1] == "Sample evidence repair needle."


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
    media_id = _insert_ready_podcast_with_semantic_backlog(
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
            SELECT DISTINCT ce.embedding_model
            FROM content_chunks cc
            JOIN content_embeddings ce ON ce.chunk_id = cc.id
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
              AND cc.source_kind = 'transcript'
            ORDER BY ce.embedding_model
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    assert model_row == [(current_transcript_embedding_model(),)], (
        "semantic repair must fully replace superseded embeddings with current runtime model"
    )


def test_reconciler_repairs_ready_semantic_rows_when_active_model_changes(
    db_session: Session,
):
    media_id = _insert_ready_podcast_with_semantic_backlog(
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
            SELECT DISTINCT ce.embedding_model
            FROM content_chunks cc
            JOIN content_embeddings ce ON ce.chunk_id = cc.id
            WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
              AND cc.source_kind = 'transcript'
            ORDER BY ce.embedding_model
            """
        ),
        {"media_id": media_id},
    ).fetchall()
    assert model_row == [(current_transcript_embedding_model(),)], (
        "auto-repair for stale ready rows must converge to the active embedding model"
    )


def test_reconciler_retries_failed_semantic_backlog_after_retry_window(
    db_session: Session,
):
    media_id = _insert_ready_podcast_with_semantic_backlog(
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
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
              AND source_kind = 'transcript'
            """
        ),
        {"media_id": media_id},
    ).scalar()
    assert int(chunk_count or 0) == 2, (
        "semantic repair retry must regenerate a complete chunk set for the current transcript"
    )
