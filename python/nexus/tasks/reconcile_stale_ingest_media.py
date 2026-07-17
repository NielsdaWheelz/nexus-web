"""Periodic reconciler for stale ingest jobs.

Recovers media rows stuck in `extracting` when the original worker job was
dropped/discarded or never finished. Recovery is bounded:
- re-dispatch up to N attempts
- then fail closed with deterministic timeout metadata
"""

from datetime import datetime

from sqlalchemy import func, literal, or_, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Media, MediaFile, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.content_indexing import (
    IndexOwner,
    mark_content_index_failed,
    repair_ready_media_content_index_now,
)
from nexus.services.media_deletion import delete_abandoned_document_media
from nexus.services.media_processing_state import mark_failed
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)

logger = get_logger(__name__)

_RECOVERABLE_KINDS = frozenset({"web_article", "pdf", "epub", "video", "podcast_episode"})
_MAX_ERROR_MSG_LEN = 1000
_BATCH_LIMIT = 100


def _mark_stale_media_failed(
    db,
    media: Media,
    *,
    now: datetime,
    error_code: str,
    error_message: str,
) -> None:
    from nexus.services.media_source_ingest import mark_latest_source_attempt_failed

    mark_latest_source_attempt_failed(
        db=db,
        media_id=media.id,
        error_code=error_code,
        error_message=error_message,
    )
    if media.kind == "podcast_episode":
        from nexus.services.podcasts.transcription import (
            mark_podcast_transcription_failure,
        )

        mark_podcast_transcription_failure(
            db,
            media_id=media.id,
            error_code=error_code,
            error_message=error_message,
            now=now,
        )
        return

    mark_failed(
        db,
        media,
        stage="other",
        error_code=error_code,
        error_message=error_message,
    )


def reconcile_stale_ingest_media_job(
    request_id: str | None = None,
) -> dict[str, int]:
    """Requeue or fail stale `extracting` media rows.

    Rows are considered stale when:
    - processing_status = extracting
    - kind in {web_article, pdf, epub, video, podcast_episode}
    - processing_started_at older than INGEST_STALE_EXTRACTING_SECONDS

    Also repairs semantic transcript backlog:
    - media_transcript_states.semantic_status in {pending, failed}
    - transcript_state in {ready, partial}
    - current transcript segments exist
    """
    settings = get_settings()

    session_factory = get_session_factory()
    db = session_factory()

    try:
        pending_upload_rows = db.execute(
            select(Media, MediaFile.storage_path)
            .join(MediaFile, MediaFile.media_id == Media.id)
            .where(Media.processing_status == ProcessingStatus.pending)
            .where(Media.kind.in_(("pdf", "epub")))
            .where(
                Media.created_at
                < func.now()
                - (literal(int(settings.signed_url_expiry_s)) * text("interval '1 second'"))
            )
            .where(
                or_(
                    Media.processing_started_at.is_(None),
                    Media.processing_started_at
                    < func.now()
                    - (
                        literal(int(settings.ingest_stale_extracting_seconds))
                        * text("interval '1 second'")
                    ),
                )
            )
            .order_by(Media.created_at.asc())
            .limit(_BATCH_LIMIT)
            .with_for_update(skip_locked=True)
        ).all()
        for media, _storage_path in pending_upload_rows:
            # Claim each stale pending upload for durable teardown (intent + job). The
            # media_teardown job owns storage deletion now; this reconciler no longer
            # deletes objects inline (spec §3.1). Keeps its DB-row reconciliation duty.
            delete_abandoned_document_media(db, media.id)

        stale_rows = (
            db.execute(
                select(Media)
                .where(Media.processing_status == ProcessingStatus.extracting)
                .where(Media.kind.in_(tuple(_RECOVERABLE_KINDS)))
                .where(Media.processing_started_at.is_not(None))
                .where(
                    Media.processing_started_at
                    < func.now()
                    - (
                        literal(int(settings.ingest_stale_extracting_seconds))
                        * text("interval '1 second'")
                    )
                )
                .order_by(Media.processing_started_at.asc())
                .limit(_BATCH_LIMIT)
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )

        now = db.execute(text("SELECT now()")).scalar_one()
        requeued = 0
        failed = 0

        for media in stale_rows:
            attempts = int(media.processing_attempts or 0)
            if attempts < settings.ingest_stale_requeue_max_attempts:
                try:
                    _dispatch_recovery_task(db, media, request_id)
                    media.processing_attempts = attempts + 1
                    media.processing_started_at = now
                    media.updated_at = now
                    requeued += 1
                    logger.warning(
                        "stale_ingest_requeued",
                        media_id=str(media.id),
                        media_kind=str(media.kind),
                        attempts=media.processing_attempts,
                        request_id=request_id,
                    )
                except Exception as exc:
                    _mark_stale_media_failed(
                        db,
                        media,
                        now=now,
                        error_code=ApiErrorCode.E_INGEST_FAILED.value,
                        error_message=f"Recovery requeue failed: {exc}",
                    )
                    failed += 1
                    logger.error(
                        "stale_ingest_requeue_failed",
                        media_id=str(media.id),
                        media_kind=str(media.kind),
                        attempts=attempts,
                        error=str(exc),
                        request_id=request_id,
                    )
            else:
                _mark_stale_media_failed(
                    db,
                    media,
                    now=now,
                    error_code=ApiErrorCode.E_INGEST_TIMEOUT.value,
                    error_message=(
                        "Ingest exceeded stale-time threshold and max recovery attempts. "
                        "Retry from API to resume processing."
                    ),
                )
                failed += 1
                logger.warning(
                    "stale_ingest_failed_closed",
                    media_id=str(media.id),
                    media_kind=str(media.kind),
                    attempts=attempts,
                    max_attempts=settings.ingest_stale_requeue_max_attempts,
                    request_id=request_id,
                )

        content_index_scanned = 0
        content_index_repaired = 0
        content_index_requeued = 0
        content_index_failed = 0
        content_index_rows = db.execute(
            text(
                """
                SELECT mcis.owner_id AS media_id, mcis.status
                FROM content_index_states mcis
                JOIN media m ON mcis.owner_kind = 'media' AND m.id = mcis.owner_id
                WHERE (
                    (
                        mcis.status IN ('pending', 'failed')
                    )
                    OR (
                        mcis.status = 'indexing'
                        AND mcis.updated_at < now() - (CAST(:stale_seconds AS integer) * interval '1 second')
                    )
                  )
                  AND (
                      (
                          m.kind IN ('web_article', 'epub', 'pdf')
                          AND m.processing_status = 'ready_for_reading'
                      )
                      OR (
                          m.kind IN ('podcast_episode', 'video')
                          AND EXISTS (
                              SELECT 1
                              FROM media_transcript_states mts
                              WHERE mts.media_id = m.id
                                AND mts.transcript_state IN ('ready', 'partial')
                                AND mts.transcript_coverage IN ('partial', 'full')
                          )
                      )
                  )
                ORDER BY mcis.updated_at ASC, mcis.owner_id ASC
                LIMIT :limit
                """
            ),
            {
                "stale_seconds": int(settings.ingest_stale_extracting_seconds),
                "limit": int(settings.ingest_semantic_repair_batch_limit),
            },
        ).fetchall()
        content_index_scanned = len(content_index_rows)
        for row in content_index_rows:
            media_id = row[0]
            try:
                if str(row[1] or "") == "indexing":
                    mark_content_index_failed(
                        db,
                        owner=IndexOwner("media", media_id),
                        failure_code=ApiErrorCode.E_INGEST_TIMEOUT.value,
                        failure_message=(
                            "Evidence index exceeded stale-time threshold and was "
                            "requeued for deterministic repair."
                        ),
                    )
                    content_index_requeued += 1
                result = repair_ready_media_content_index_now(
                    db,
                    media_id=media_id,
                    reason="content_index_repair",
                )
                if result is None:
                    _mark_content_index_state_failed(
                        db,
                        media_id,
                        "No readable media exists for evidence index repair",
                    )
                    content_index_failed += 1
                elif result.status in {"ready", "no_text"}:
                    content_index_repaired += 1
                else:
                    _mark_content_index_state_failed(
                        db,
                        media_id,
                        f"Evidence index repair ended with status {result.status}",
                    )
                    content_index_failed += 1
            except Exception as exc:
                error_code = (
                    exc.code.value
                    if isinstance(exc, ApiError)
                    else ApiErrorCode.E_INGEST_FAILED.value
                )
                mark_content_index_failed(
                    db,
                    owner=IndexOwner("media", media_id),
                    failure_code=error_code,
                    failure_message=f"Evidence index repair failed: {exc}"[:_MAX_ERROR_MSG_LEN],
                )
                _mark_content_index_state_failed(
                    db,
                    media_id,
                    f"Evidence index repair failed: {exc}",
                )
                content_index_failed += 1

        semantic_scanned = 0
        semantic_repaired = 0
        semantic_failed = 0
        semantic_skipped = 0
        embedding_model = current_transcript_embedding_model()
        embedding_provider = current_transcript_embedding_provider()
        semantic_candidates = db.execute(
            text(
                """
                SELECT mts.media_id
                FROM media_transcript_states mts
                JOIN media m ON m.id = mts.media_id
                WHERE m.kind IN ('podcast_episode', 'video')
                  AND EXISTS (
                      SELECT 1
                      FROM podcast_transcript_segments pts
                      WHERE pts.media_id = mts.media_id
                  )
                  AND mts.transcript_state IN ('ready', 'partial')
                  AND mts.transcript_coverage IN ('partial', 'full')
                  AND (
                      mts.semantic_status = 'pending'
                      OR (
                          mts.semantic_status = 'failed'
                          AND mts.updated_at < now() - (CAST(:retry_failed_seconds AS integer) * interval '1 second')
                      )
                      OR (
                          mts.semantic_status = 'ready'
                          AND (
                              NOT EXISTS (
                                  SELECT 1
                                  FROM content_index_states mcis
                                  WHERE mcis.owner_kind = 'media' AND mcis.owner_id = mts.media_id
                                    AND mcis.status = 'ready'
                                    AND mcis.active_embedding_provider = :embedding_provider
                                    AND mcis.active_embedding_model = :embedding_model
                              )
                          )
                      )
                  )
                ORDER BY mts.updated_at ASC, mts.media_id ASC
                LIMIT :semantic_limit
                """
            ),
            {
                "retry_failed_seconds": int(settings.ingest_semantic_failed_retry_seconds),
                "semantic_limit": int(settings.ingest_semantic_repair_batch_limit),
                "embedding_provider": embedding_provider,
                "embedding_model": embedding_model,
            },
        ).fetchall()
        semantic_scanned = len(semantic_candidates)
        if semantic_candidates:
            from nexus.services.podcasts.transcription import (
                repair_podcast_transcript_semantic_index_now,
            )

            for row in semantic_candidates:
                media_id = row[0]
                result = repair_podcast_transcript_semantic_index_now(
                    db,
                    media_id=media_id,
                    request_reason="operator_requeue",
                )
                if result.status == "completed":
                    semantic_repaired += 1
                elif result.status == "failed":
                    semantic_failed += 1
                    logger.warning(
                        "stale_ingest_semantic_repair_failed",
                        media_id=str(media_id),
                        error_code=result.error_code,
                        request_id=request_id,
                    )
                else:
                    semantic_skipped += 1

        db.commit()
        logger.info(
            "stale_ingest_reconcile_complete",
            pending_upload_deleted=len(pending_upload_rows),
            scanned=len(stale_rows),
            requeued=requeued,
            failed=failed,
            content_index_scanned=content_index_scanned,
            content_index_repaired=content_index_repaired,
            content_index_requeued=content_index_requeued,
            content_index_failed=content_index_failed,
            semantic_scanned=semantic_scanned,
            semantic_repaired=semantic_repaired,
            semantic_failed=semantic_failed,
            semantic_skipped=semantic_skipped,
            request_id=request_id,
        )
        return {
            "scanned": len(stale_rows),
            "pending_upload_deleted": len(pending_upload_rows),
            "requeued": requeued,
            "failed": failed,
            "content_index_scanned": content_index_scanned,
            "content_index_repaired": content_index_repaired,
            "content_index_requeued": content_index_requeued,
            "content_index_failed": content_index_failed,
            "semantic_scanned": semantic_scanned,
            "semantic_repaired": semantic_repaired,
            "semantic_failed": semantic_failed,
            "semantic_skipped": semantic_skipped,
        }
    except Exception:
        db.rollback()
        logger.exception("stale_ingest_reconcile_unexpected_error", request_id=request_id)
        raise
    finally:
        db.close()


def _dispatch_recovery_task(db: Session, media: Media, request_id: str | None) -> None:
    if media.kind in {"pdf", "web_article", "epub", "video", "podcast_episode"}:
        from nexus.services.media_source_ingest import requeue_latest_source_attempt_for_media

        requeue_latest_source_attempt_for_media(
            db=db,
            media=media,
            request_id=request_id,
        )
        return

    raise ValueError(f"Unsupported recovery kind: {media.kind}")


def _mark_content_index_state_failed(db: Session, media_id, message: str) -> None:
    db.execute(
        text(
            """
            UPDATE content_index_states
            SET status = 'failed',
                status_reason = :message,
                updated_at = now()
            WHERE owner_kind = 'media' AND owner_id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "message": message[:_MAX_ERROR_MSG_LEN],
        },
    )
