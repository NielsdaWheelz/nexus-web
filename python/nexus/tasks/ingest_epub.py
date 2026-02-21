"""Celery task for EPUB extraction.

Parallel to ingest_web_article.py structure.  Calls the EPUB extraction
domain executor and returns a structured outcome payload for PR-03
orchestration consumption.

PR-02 scope: extraction execution only.  Does NOT mutate
processing_status, retry policy fields, or endpoint-facing lifecycle
semantics (owned by PR-03).
"""

from uuid import UUID

from nexus.celery import celery_app
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.epub_ingest import (
    EpubExtractionError,
    EpubExtractionResult,
    extract_epub_artifacts,
)
from nexus.storage import get_storage_client

logger = get_logger(__name__)


@celery_app.task(bind=True, max_retries=0, name="ingest_epub")
def ingest_epub(
    self,
    media_id: str,
    request_id: str | None = None,
) -> dict:
    """Execute EPUB extraction asynchronously.

    Returns structured extraction outcome for PR-03 orchestration.
    """
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
        result = extract_epub_artifacts(db, media_uuid, storage_client)
        db.commit()

        if isinstance(result, EpubExtractionError):
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
        raise
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Synchronous execution helper (for tests and dev mode)
# ---------------------------------------------------------------------------


def run_epub_ingest_sync(
    db,
    media_id: UUID,
    storage_client=None,
) -> EpubExtractionResult | EpubExtractionError:
    """Run EPUB extraction synchronously using provided session.

    Args:
        db: Database session to use.
        media_id: UUID of the media to extract.
        storage_client: Optional storage client (defaults to get_storage_client()).

    Returns:
        EpubExtractionResult on success, EpubExtractionError on failure.
    """
    sc = storage_client or get_storage_client()
    return extract_epub_artifacts(db, media_id, sc)
