"""Celery task for EPUB extraction.

Owns async completion-state transitions for EPUB extraction:
extracting -> ready_for_reading (success) or extracting -> failed (error).
Service routes own entry transitions and dispatch.
"""

from datetime import UTC, datetime
from uuid import UUID

from nexus.celery import celery_app
from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionResult,
    extract_epub_artifacts,
)
from nexus.storage import get_storage_client

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000


@celery_app.task(bind=True, max_retries=0, name="ingest_epub")
def ingest_epub(
    self,
    media_id: str,
    request_id: str | None = None,
) -> dict:
    """Execute EPUB extraction and commit lifecycle transition."""
    media_uuid = UUID(media_id)

    logger.info(
        "ingest_epub_started",
        media_id=media_id,
        request_id=request_id,
    )

    session_factory = get_session_factory()
    db = session_factory()
    storage_client = get_storage_client()

    try:
        media = db.get(Media, media_uuid)
        if media is None or media.processing_status != ProcessingStatus.extracting:
            logger.info(
                "ingest_epub_skipped",
                media_id=media_id,
                reason="not_extracting",
                request_id=request_id,
            )
            return {"status": "skipped", "reason": "not_extracting"}

        result = extract_epub_artifacts(db, media_uuid, storage_client)

        media = db.get(Media, media_uuid)
        if media is None or media.processing_status != ProcessingStatus.extracting:
            db.commit()
            return {"status": "skipped", "reason": "state_changed"}

        now = datetime.now(UTC)

        if isinstance(result, EpubExtractionError):
            media.processing_status = ProcessingStatus.failed
            media.failure_stage = FailureStage.extract
            media.last_error_code = result.error_code
            media.last_error_message = (result.error_message or "")[:_MAX_ERROR_MSG_LEN]
            media.failed_at = now
            media.updated_at = now
            db.commit()

            logger.warning(
                "ingest_epub_extraction_failed",
                media_id=media_id,
                error_code=result.error_code,
                error_message=result.error_message,
                request_id=request_id,
            )
            return {
                "status": "failed",
                "error_code": result.error_code,
                "error_message": result.error_message,
                "terminal": result.terminal,
            }

        assert isinstance(result, EpubExtractionResult)

        media.processing_status = ProcessingStatus.ready_for_reading
        media.processing_completed_at = now
        media.failure_stage = None
        media.last_error_code = None
        media.last_error_message = None
        media.failed_at = None
        media.updated_at = now
        db.commit()

        logger.info(
            "ingest_epub_completed",
            media_id=media_id,
            chapter_count=result.chapter_count,
            toc_node_count=result.toc_node_count,
            asset_count=result.asset_count,
            request_id=request_id,
        )
        return {
            "status": "success",
            "chapter_count": result.chapter_count,
            "toc_node_count": result.toc_node_count,
            "asset_count": result.asset_count,
            "title": result.title,
        }

    except Exception as e:
        db.rollback()
        logger.error(
            "ingest_epub_unexpected_error",
            media_id=media_id,
            error=str(e),
            request_id=request_id,
        )
        try:
            media = db.get(Media, media_uuid)
            if media and media.processing_status == ProcessingStatus.extracting:
                now = datetime.now(UTC)
                media.processing_status = ProcessingStatus.failed
                media.failure_stage = FailureStage.extract
                media.last_error_code = "E_INGEST_FAILED"
                media.last_error_message = str(e)[:_MAX_ERROR_MSG_LEN]
                media.failed_at = now
                media.updated_at = now
                db.commit()
        except Exception:
            logger.exception("ingest_epub_failed_to_mark_failed", media_id=media_id)
        raise
    finally:
        db.close()


def run_epub_ingest_sync(
    db,
    media_id: UUID,
    storage_client=None,
) -> EpubExtractionResult | EpubExtractionError:
    """Run EPUB extraction synchronously using provided session.

    Does NOT perform lifecycle transitions — caller is responsible.
    """
    sc = storage_client or get_storage_client()
    return extract_epub_artifacts(db, media_id, sc)
