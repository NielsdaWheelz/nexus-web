"""Worker job handler for PDF extraction.

Owns async completion-state transitions for PDF extraction:
extracting -> ready_for_reading (success) or extracting -> failed (error).

On successful extraction, performs explicit PDF evidence indexing so downstream
indexing failures surface as failure_stage='embed'.
"""

from uuid import UUID

from nexus.db.models import Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.media_processing_state import (
    mark_failed,
    mark_ready_for_reading,
    mark_stage_warning,
)
from nexus.services.pdf_indexing import index_pdf_evidence
from nexus.services.pdf_ingest import (
    PdfExtractionError,
    PdfExtractionResult,
    extract_pdf_artifacts,
)
from nexus.services.pdf_metadata import persist_pdf_metadata
from nexus.storage.client import get_storage_client
from nexus.tasks.enrich_metadata import dispatch_enrich_metadata

logger = get_logger(__name__)

_MAX_ERROR_MSG_LEN = 1000


def ingest_pdf(
    media_id: str,
    request_id: str | None = None,
    embedding_only: bool = False,
) -> dict:
    """Execute PDF extraction and commit lifecycle transition.

    When embedding_only=True, skips extraction and goes straight to
    the embedding handoff (for embed-stage retry paths that preserve
    existing text artifacts).
    """
    media_uuid = UUID(media_id)

    logger.info(
        "ingest_pdf_started",
        media_id=media_id,
        request_id=request_id,
        embedding_only=embedding_only,
    )

    session_factory = get_session_factory()
    db = session_factory()
    storage_client = get_storage_client()

    try:
        media = db.get(Media, media_uuid)
        if media is None or media.processing_status != ProcessingStatus.extracting:
            logger.info(
                "ingest_pdf_skipped",
                media_id=media_id,
                reason="not_extracting",
                request_id=request_id,
            )
            return {"status": "skipped", "reason": "not_extracting"}

        if embedding_only:
            return _handle_embedding_only(db, media, media_uuid, request_id)

        result = extract_pdf_artifacts(db, media_uuid, storage_client)

        media = db.get(Media, media_uuid)
        if media is None or media.processing_status != ProcessingStatus.extracting:
            db.commit()
            return {"status": "skipped", "reason": "state_changed"}

        if isinstance(result, PdfExtractionError):
            mark_failed(
                db,
                media,
                stage="extract",
                error_code=result.error_code,
                error_message=(result.error_message or "")[:_MAX_ERROR_MSG_LEN],
            )

            logger.warning(
                "ingest_pdf_extraction_failed",
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

        assert isinstance(result, PdfExtractionResult)

        persist_pdf_metadata(db, media, result)
        mark_ready_for_reading(db, media)

        if not result.has_text:
            mark_stage_warning(
                db,
                media,
                stage="extract",
                error_code="E_PDF_TEXT_UNAVAILABLE",
                error_message="PDF text is unavailable; OCR is required.",
            )

        db.commit()

        logger.info(
            "ingest_pdf_completed",
            media_id=media_id,
            page_count=result.page_count,
            has_text=result.has_text,
            request_id=request_id,
        )

        index_pdf_evidence(db, media_uuid, request_id, result)
        dispatch_enrich_metadata(media_id, request_id)

        return {
            "status": "success",
            "page_count": result.page_count,
            "has_text": result.has_text,
        }

    except Exception as e:
        db.rollback()
        logger.error(
            "ingest_pdf_unexpected_error",
            media_id=media_id,
            error=str(e),
            request_id=request_id,
        )
        try:
            media = db.get(Media, media_uuid)
            if media and media.processing_status == ProcessingStatus.extracting:
                mark_failed(
                    db,
                    media,
                    stage="extract",
                    error_code="E_INGEST_FAILED",
                    error_message=str(e)[:_MAX_ERROR_MSG_LEN],
                )
        except Exception:
            logger.exception("ingest_pdf_failed_to_mark_failed", media_id=media_id)
        raise
    finally:
        db.close()


def _handle_embedding_only(db, media: Media, media_uuid: UUID, request_id: str | None) -> dict:
    """Handle embedding-only retry path. Skips extraction, goes to embedding."""
    mark_ready_for_reading(db, media)
    db.commit()

    logger.info(
        "ingest_pdf_embedding_only_ready",
        media_id=str(media_uuid),
        request_id=request_id,
    )

    index_pdf_evidence(db, media_uuid, request_id, None)

    return {"status": "success", "embedding_only": True}


def run_pdf_ingest_sync(
    db,
    media_id: UUID,
    storage_client=None,
) -> PdfExtractionResult | PdfExtractionError:
    """Run PDF extraction synchronously using provided session.

    Does NOT perform lifecycle transitions — caller is responsible.
    """
    sc = storage_client or get_storage_client()
    return extract_pdf_artifacts(db, media_id, sc)
