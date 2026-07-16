"""Worker job handler for EPUB extraction.

Owns async completion-state transitions for EPUB extraction:
extracting -> ready_for_reading (success) or extracting -> failed (error).
Service routes own entry transitions and dispatch.
"""

from uuid import UUID

from nexus.db.models import Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services import contributors
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionResult,
    extract_epub_artifacts,
)
from nexus.services.epub_metadata import build_epub_author_observation, persist_epub_metadata
from nexus.services.media_processing_state import mark_failed, mark_ready_for_reading
from nexus.storage.client import get_storage_client
from nexus.tasks.enrich_metadata import dispatch_enrich_metadata

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000


def ingest_epub(
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

        if isinstance(result, EpubExtractionError):
            mark_failed(
                db,
                media,
                stage="extract",
                error_code=result.error_code,
                error_message=(result.error_message or "")[:_MAX_ERROR_MSG_LEN],
            )

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

        # Persist source work and commit WITHOUT crossing ready, then apply the
        # author observation through the facade in a fresh session (spec 2.4 /
        # D-13); ready is only crossed after the author op commits.
        persist_epub_metadata(db, media, result)
        db.commit()

        observation, truncated = build_epub_author_observation(result)
        if truncated:
            logger.info("epub_author_truncation", media_id=media_id, truncated=truncated)
        contributors.replace_observed_role_slices(
            target=contributors.MediaTarget(media_uuid),
            observation=observation,
            source="epub_opf",
        )

        media = db.get(Media, media_uuid)
        if media is None or media.processing_status != ProcessingStatus.extracting:
            return {"status": "skipped", "reason": "state_changed"}
        mark_ready_for_reading(db, media)
        db.commit()

        dispatch_enrich_metadata(media_id, request_id)

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

    except Exception as exc:
        db.rollback()
        logger.exception(
            "ingest_epub_unexpected_error",
            media_id=media_id,
            error=str(exc),
            request_id=request_id,
        )
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
