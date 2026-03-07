"""Periodic reconciler for stale ingest jobs.

Recovers media rows stuck in `extracting` when the original Celery task was
dropped/discarded or never finished. Recovery is bounded:
- re-dispatch up to N attempts
- then fail closed with deterministic timeout metadata
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from nexus.celery import celery_app
from nexus.celery_contract import INGEST_QUEUE
from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

_RECOVERABLE_KINDS = frozenset({"pdf", "epub", "podcast_episode"})
_MAX_ERROR_MSG_LEN = 1000
_BATCH_LIMIT = 100


@celery_app.task(bind=True, max_retries=0, name="reconcile_stale_ingest_media_job")
def reconcile_stale_ingest_media_job(
    self,
    request_id: str | None = None,
) -> dict[str, int]:
    """Requeue or fail stale `extracting` media rows.

    Rows are considered stale when:
    - processing_status = extracting
    - kind in {pdf, epub, podcast_episode}
    - processing_started_at older than INGEST_STALE_EXTRACTING_SECONDS
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

        if not stale_rows:
            return {"scanned": 0, "requeued": 0, "failed": 0}

        now = datetime.now(UTC)
        requeued = 0
        failed = 0

        for media in stale_rows:
            attempts = int(media.processing_attempts or 0)
            if attempts < settings.ingest_stale_requeue_max_attempts:
                try:
                    _dispatch_recovery_task(media, request_id)
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
                    _mark_failed(
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
                _mark_failed(
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

        db.commit()
        logger.info(
            "stale_ingest_reconcile_complete",
            scanned=len(stale_rows),
            requeued=requeued,
            failed=failed,
            request_id=request_id,
        )
        return {"scanned": len(stale_rows), "requeued": requeued, "failed": failed}
    except Exception:
        db.rollback()
        logger.exception("stale_ingest_reconcile_unexpected_error", request_id=request_id)
        raise
    finally:
        db.close()


def _dispatch_recovery_task(media: Media, request_id: str | None) -> None:
    media_id = str(media.id)
    if media.kind == "pdf":
        from nexus.tasks.ingest_pdf import ingest_pdf

        ingest_pdf.apply_async(
            args=[media_id],
            kwargs={"request_id": request_id},
            queue=INGEST_QUEUE,
        )
        return

    if media.kind == "epub":
        from nexus.tasks.ingest_epub import ingest_epub

        ingest_epub.apply_async(
            args=[media_id],
            kwargs={"request_id": request_id},
            queue=INGEST_QUEUE,
        )
        return

    if media.kind == "podcast_episode":
        from nexus.tasks.podcast_transcribe_episode import podcast_transcribe_episode_job

        podcast_transcribe_episode_job.apply_async(
            args=[media_id],
            kwargs={"request_id": request_id},
            queue=INGEST_QUEUE,
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
