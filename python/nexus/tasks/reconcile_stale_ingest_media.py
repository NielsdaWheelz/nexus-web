"""Periodic reconciler for stale ingest jobs.

Recovers media rows stuck in `extracting` when the original worker job was
dropped/discarded or never finished. Recovery is bounded:
- re-dispatch up to N attempts
- then fail closed with deterministic timeout metadata
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger

logger = get_logger(__name__)

_RECOVERABLE_KINDS = frozenset({"pdf", "epub", "podcast_episode"})
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
    if media.kind == "podcast_episode":
        from nexus.services.podcasts.transcripts import (
            mark_podcast_transcription_failure_for_recovery,
        )

        mark_podcast_transcription_failure_for_recovery(
            db,
            media_id=media.id,
            error_code=error_code,
            error_message=error_message,
            now=now,
        )
        return

    _mark_failed(
        media,
        now=now,
        error_code=error_code,
        error_message=error_message,
    )


def reconcile_stale_ingest_media_job(
    request_id: str | None = None,
) -> dict[str, int]:
    """Requeue or fail stale `extracting` media rows.

    Rows are considered stale when:
    - processing_status = extracting
    - kind in {pdf, epub, podcast_episode}
    - processing_started_at older than INGEST_STALE_EXTRACTING_SECONDS

    Also repairs semantic transcript backlog:
    - media_transcript_states.semantic_status in {pending, failed}
    - transcript_state in {ready, partial}
    - active transcript version exists
    """
    settings = get_settings()
    stale_before = datetime.now(UTC) - timedelta(seconds=settings.ingest_stale_extracting_seconds)

    session_factory = get_session_factory()
    db = session_factory()

    try:
        stale_rows = (
            db.execute(
                select(Media)
                .where(Media.processing_status == ProcessingStatus.extracting)
                .where(Media.kind.in_(tuple(_RECOVERABLE_KINDS)))
                .where(Media.processing_started_at.is_not(None))
                .where(Media.processing_started_at < stale_before)
                .order_by(Media.processing_started_at.asc())
                .limit(_BATCH_LIMIT)
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )

        now = datetime.now(UTC)
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

        semantic_scanned = 0
        semantic_repaired = 0
        semantic_failed = 0
        semantic_skipped = 0
        retry_failed_before = now - timedelta(seconds=settings.ingest_semantic_failed_retry_seconds)
        from nexus.services.semantic_chunks import current_transcript_embedding_model

        active_embedding_model = current_transcript_embedding_model()
        semantic_candidates = db.execute(
            text(
                """
                SELECT mts.media_id
                FROM media_transcript_states mts
                JOIN media m ON m.id = mts.media_id
                WHERE m.kind = 'podcast_episode'
                  AND mts.active_transcript_version_id IS NOT NULL
                  AND mts.transcript_state IN ('ready', 'partial')
                  AND mts.transcript_coverage IN ('partial', 'full')
                  AND (
                      mts.semantic_status = 'pending'
                      OR (
                          mts.semantic_status = 'failed'
                          AND mts.updated_at < :retry_failed_before
                      )
                      OR (
                          mts.semantic_status = 'ready'
                          AND (
                              NOT EXISTS (
                                  SELECT 1
                                  FROM content_chunks tc
                                  WHERE tc.transcript_version_id = mts.active_transcript_version_id
                                    AND tc.source_kind = 'transcript'
                              )
                              OR EXISTS (
                                  SELECT 1
                                  FROM content_chunks tc
                                  WHERE tc.transcript_version_id = mts.active_transcript_version_id
                                    AND tc.source_kind = 'transcript'
                                    AND (
                                        tc.embedding_vector IS NULL
                                        OR tc.embedding_model IS NULL
                                        OR tc.embedding_model <> :active_embedding_model
                                    )
                              )
                          )
                      )
                  )
                ORDER BY mts.updated_at ASC, mts.media_id ASC
                LIMIT :semantic_limit
                """
            ),
            {
                "retry_failed_before": retry_failed_before,
                "semantic_limit": int(settings.ingest_semantic_repair_batch_limit),
                "active_embedding_model": active_embedding_model,
            },
        ).fetchall()
        semantic_scanned = len(semantic_candidates)
        if semantic_candidates:
            from nexus.services.podcasts.transcripts import (
                repair_podcast_transcript_semantic_index_now,
            )

            for row in semantic_candidates:
                media_id = row[0]
                result = repair_podcast_transcript_semantic_index_now(
                    db,
                    media_id=media_id,
                    request_reason="operator_requeue",
                    request_id=request_id,
                )
                status = str(result.get("status") or "")
                if status == "completed":
                    semantic_repaired += 1
                elif status == "failed":
                    semantic_failed += 1
                    logger.warning(
                        "stale_ingest_semantic_repair_failed",
                        media_id=str(media_id),
                        error_code=result.get("error_code"),
                        request_id=request_id,
                    )
                else:
                    semantic_skipped += 1

        db.commit()
        logger.info(
            "stale_ingest_reconcile_complete",
            scanned=len(stale_rows),
            requeued=requeued,
            failed=failed,
            semantic_scanned=semantic_scanned,
            semantic_repaired=semantic_repaired,
            semantic_failed=semantic_failed,
            semantic_skipped=semantic_skipped,
            request_id=request_id,
        )
        return {
            "scanned": len(stale_rows),
            "requeued": requeued,
            "failed": failed,
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
    media_id = str(media.id)
    if media.kind == "pdf":
        enqueue_job(
            db,
            kind="ingest_pdf",
            payload={
                "media_id": media_id,
                "request_id": request_id,
                "embedding_only": False,
            },
        )
        return

    if media.kind == "epub":
        enqueue_job(
            db,
            kind="ingest_epub",
            payload={
                "media_id": media_id,
                "request_id": request_id,
            },
        )
        return

    if media.kind == "podcast_episode":
        enqueue_job(
            db,
            kind="podcast_transcribe_episode_job",
            payload={
                "media_id": media_id,
                "request_id": request_id,
            },
        )
        return

    raise ValueError(f"Unsupported recovery kind: {media.kind}")


def _mark_failed(media: Media, *, now: datetime, error_code: str, error_message: str) -> None:
    media.processing_status = ProcessingStatus.failed
    media.failure_stage = FailureStage.other
    media.last_error_code = error_code
    media.last_error_message = error_message[:_MAX_ERROR_MSG_LEN]
    media.failed_at = now
    media.updated_at = now
