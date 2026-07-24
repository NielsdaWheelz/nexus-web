"""Bounded enqueue-only reconciliation for ingest-owned durable work."""

from __future__ import annotations

from functools import partial
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.jobs.queue import enqueue_job, lock_jobs_for_payload
from nexus.services.content_indexing import (
    MediaContentReindexIntent,
    ensure_media_content_reindex_job,
)
from nexus.services.media_deletion import delete_abandoned_document_media
from nexus.services.media_source_ingest import ensure_stale_source_attempt_job

_BATCH_LIMIT = 25


def reconcile_stale_ingest_media_job(
    request_id: str | None = None,
) -> dict[str, int]:
    settings = get_settings()
    discovery = get_session_factory()()
    try:
        pending_upload_ids = list(
            discovery.scalars(
                text(
                    """
                    SELECT m.id
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.processing_status = 'pending'
                      AND m.kind IN ('pdf', 'epub')
                      AND m.created_at
                          < now() - (CAST(:upload_seconds AS integer) * interval '1 second')
                    ORDER BY m.created_at ASC, m.id ASC
                    LIMIT :limit
                    """
                ),
                {
                    "upload_seconds": int(settings.signed_url_expiry_s),
                    "limit": _BATCH_LIMIT,
                },
            )
        )
        source_rows = (
            discovery.execute(
                text(
                    """
                SELECT msa.id AS attempt_id, msa.media_id
                FROM media_source_attempts msa
                JOIN media m ON m.id = msa.media_id
                WHERE msa.status IN ('accepted', 'queued', 'running')
                  AND m.processing_status = 'extracting'
                  AND m.processing_started_at IS NOT NULL
                  AND m.processing_started_at
                      < now() - (CAST(:stale_seconds AS integer) * interval '1 second')
                  AND NOT EXISTS (
                      SELECT 1
                      FROM media_source_attempts newer
                      WHERE newer.media_id = msa.media_id
                        AND (
                            newer.attempt_no,
                            newer.created_at,
                            newer.id
                        ) > (
                            msa.attempt_no,
                            msa.created_at,
                            msa.id
                        )
                  )
                ORDER BY m.processing_started_at ASC, msa.id ASC
                LIMIT :limit
                """
                ),
                {
                    "stale_seconds": int(settings.ingest_stale_extracting_seconds),
                    "limit": _BATCH_LIMIT,
                },
            )
            .mappings()
            .all()
        )
        index_rows = (
            discovery.execute(
                text(
                    """
                SELECT cis.owner_id AS media_id
                FROM content_index_states cis
                JOIN media m
                  ON cis.owner_kind = 'media'
                 AND m.id = cis.owner_id
                WHERE m.kind IN ('web_article', 'epub', 'pdf')
                  AND m.processing_status = 'ready_for_reading'
                  AND (
                      cis.status = 'pending'
                      OR (
                          cis.status = 'indexing'
                          AND cis.updated_at
                              < now()
                                - (CAST(:stale_seconds AS integer) * interval '1 second')
                      )
                  )
                ORDER BY cis.updated_at ASC, cis.owner_id ASC
                LIMIT :limit
                """
                ),
                {
                    "stale_seconds": int(settings.ingest_stale_extracting_seconds),
                    "limit": _BATCH_LIMIT,
                },
            )
            .mappings()
            .all()
        )
        semantic_rows = (
            discovery.execute(
                text(
                    """
                SELECT mts.media_id
                FROM media_transcript_states mts
                JOIN media m ON m.id = mts.media_id
                WHERE m.kind IN ('podcast_episode', 'video')
                  AND mts.transcript_state IN ('ready', 'partial')
                  AND mts.transcript_coverage IN ('partial', 'full')
                  AND mts.semantic_status IN ('pending', 'failed')
                  AND EXISTS (
                      SELECT 1
                      FROM podcast_transcript_segments pts
                      WHERE pts.media_id = mts.media_id
                  )
                ORDER BY mts.updated_at ASC, mts.media_id ASC
                LIMIT :limit
                """
                ),
                {"limit": _BATCH_LIMIT},
            )
            .mappings()
            .all()
        )
        discovery.rollback()
    finally:
        discovery.close()

    pending_upload_deleted = 0
    for media_id in pending_upload_ids:
        db = get_session_factory()()
        try:
            retry_serializable(
                db,
                "reconcile_abandoned_upload",
                partial(_delete_pending_upload, db, UUID(str(media_id))),
            )
            pending_upload_deleted += 1
        finally:
            db.close()

    source_enqueued = 0
    source_deduplicated = 0
    source_suspended = 0
    source_skipped = 0
    for row in source_rows:
        db = get_session_factory()()
        try:
            outcome = retry_serializable(
                db,
                "reconcile_stale_source_attempt",
                partial(
                    _ensure_source,
                    db,
                    media_id=UUID(str(row["media_id"])),
                    attempt_id=UUID(str(row["attempt_id"])),
                    request_id=request_id,
                ),
            )
        finally:
            db.close()
        if outcome == "enqueued":
            source_enqueued += 1
        elif outcome == "deduplicated":
            source_deduplicated += 1
        elif outcome == "suspended":
            source_suspended += 1
        else:
            source_skipped += 1

    index_enqueued = 0
    index_deduplicated = 0
    index_suspended = 0
    for row in index_rows:
        db = get_session_factory()()
        try:
            intent = retry_serializable(
                db,
                "reconcile_media_content_index",
                partial(
                    _ensure_index,
                    db,
                    media_id=UUID(str(row["media_id"])),
                    request_id=request_id,
                ),
            )
        finally:
            db.close()
        if intent.suspended:
            index_suspended += 1
        elif intent.enqueued:
            index_enqueued += 1
        else:
            index_deduplicated += 1

    semantic_enqueued = 0
    semantic_deduplicated = 0
    for row in semantic_rows:
        db = get_session_factory()()
        try:
            inserted = retry_serializable(
                db,
                "reconcile_podcast_semantic_index",
                partial(
                    _ensure_semantic,
                    db,
                    media_id=UUID(str(row["media_id"])),
                    request_id=request_id,
                ),
            )
        finally:
            db.close()
        if inserted:
            semantic_enqueued += 1
        else:
            semantic_deduplicated += 1

    return {
        "pending_upload_deleted": pending_upload_deleted,
        "source_scanned": len(source_rows),
        "source_enqueued": source_enqueued,
        "source_deduplicated": source_deduplicated,
        "source_suspended": source_suspended,
        "source_skipped": source_skipped,
        "content_index_scanned": len(index_rows),
        "content_index_enqueued": index_enqueued,
        "content_index_deduplicated": index_deduplicated,
        "content_index_suspended": index_suspended,
        "semantic_scanned": len(semantic_rows),
        "semantic_enqueued": semantic_enqueued,
        "semantic_deduplicated": semantic_deduplicated,
    }


def _delete_pending_upload(db: Session, media_id: UUID) -> None:
    delete_abandoned_document_media(db, media_id)
    db.commit()


def _ensure_source(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    request_id: str | None,
) -> str:
    outcome = ensure_stale_source_attempt_job(
        db,
        media_id=media_id,
        attempt_id=attempt_id,
        request_id=request_id,
    )
    db.commit()
    return outcome


def _ensure_index(
    db: Session,
    *,
    media_id: UUID,
    request_id: str | None,
) -> MediaContentReindexIntent:
    intent = ensure_media_content_reindex_job(
        db,
        media_id=media_id,
        reason="reconciliation",
        request_id=request_id,
    )
    db.commit()
    return intent


def _ensure_semantic(
    db: Session,
    *,
    media_id: UUID,
    request_id: str | None,
) -> bool:
    locked = db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).scalar_one_or_none()
    if locked is None:
        db.commit()
        return False
    jobs = lock_jobs_for_payload(
        db,
        kind="podcast_reindex_semantic_job",
        expected_payload_match={"media_id": str(media_id)},
    )
    if any(job.status in {"pending", "failed", "running", "dead"} for job in jobs):
        db.commit()
        return False
    enqueue_job(
        db,
        kind="podcast_reindex_semantic_job",
        payload={
            "media_id": str(media_id),
            "requested_by_user_id": None,
            "request_reason": "operator_requeue",
            "request_id": request_id,
        },
    )
    db.commit()
    return True
