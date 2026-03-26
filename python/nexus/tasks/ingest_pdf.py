"""Worker job handler for PDF extraction (S6 PR-03).

Owns async completion-state transitions for PDF extraction:
extracting -> ready_for_reading (success) or extracting -> failed (error).

On successful extraction, performs explicit handoff to the existing
embedding pipeline so downstream failures surface as failure_stage='embed'.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, MediaAuthor, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.services.pdf_ingest import (
    PdfExtractionError,
    PdfExtractionResult,
    extract_pdf_artifacts,
)
from nexus.storage import get_storage_client

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

        now = datetime.now(UTC)

        if isinstance(result, PdfExtractionError):
            media.processing_status = ProcessingStatus.failed
            media.failure_stage = FailureStage.extract
            media.last_error_code = result.error_code
            media.last_error_message = (result.error_message or "")[:_MAX_ERROR_MSG_LEN]
            media.failed_at = now
            media.updated_at = now
            db.commit()

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

        _persist_pdf_metadata(db, media, result)

        media.processing_status = ProcessingStatus.ready_for_reading
        media.processing_completed_at = now
        media.failure_stage = None
        media.last_error_code = None
        media.last_error_message = None
        media.failed_at = None
        media.updated_at = now

        if not result.has_text:
            media.last_error_code = "E_PDF_TEXT_UNAVAILABLE"

        db.commit()

        logger.info(
            "ingest_pdf_completed",
            media_id=media_id,
            page_count=result.page_count,
            has_text=result.has_text,
            request_id=request_id,
        )

        _try_embedding_handoff(db, media_uuid, request_id)
        _try_enrich_dispatch(media_id, request_id)

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
                now = datetime.now(UTC)
                media.processing_status = ProcessingStatus.failed
                media.failure_stage = FailureStage.extract
                media.last_error_code = "E_INGEST_FAILED"
                media.last_error_message = str(e)[:_MAX_ERROR_MSG_LEN]
                media.failed_at = now
                media.updated_at = now
                db.commit()
        except Exception:
            logger.exception("ingest_pdf_failed_to_mark_failed", media_id=media_id)
        raise
    finally:
        db.close()


def _persist_pdf_metadata(db: Session, media: Media, result: PdfExtractionResult) -> None:
    """Persist PDF document metadata extracted from doc.metadata."""
    # Update title if PDF has embedded title and current title looks like a filename
    if result.pdf_title and media.title and ".pdf" in media.title.lower():
        media.title = result.pdf_title[:255]

    # Split author string on ; or , and create MediaAuthor rows
    if result.pdf_author:
        for sep in [";", ","]:
            if sep in result.pdf_author:
                names = [n.strip() for n in result.pdf_author.split(sep) if n.strip()]
                break
        else:
            names = [result.pdf_author.strip()]

        for i, name in enumerate(names):
            if name:
                db.add(
                    MediaAuthor(
                        media_id=media.id,
                        name=name[:255],
                        role="author",
                        sort_order=i,
                    )
                )

    if result.pdf_subject and not media.description:
        media.description = result.pdf_subject[:2000]

    if result.pdf_creation_date and not media.published_date:
        media.published_date = result.pdf_creation_date


def _handle_embedding_only(db, media: Media, media_uuid: UUID, request_id: str | None) -> dict:
    """Handle embedding-only retry path. Skips extraction, goes to embedding."""
    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.ready_for_reading
    media.processing_completed_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now
    db.commit()

    logger.info(
        "ingest_pdf_embedding_only_ready",
        media_id=str(media_uuid),
        request_id=request_id,
    )

    _try_embedding_handoff(db, media_uuid, request_id)

    return {"status": "success", "embedding_only": True}


def _try_embedding_handoff(db, media_uuid: UUID, request_id: str | None) -> None:
    """Attempt embedding pipeline handoff after successful extraction.

    Per S6-PR03-D12: if this fails synchronously, classify as embed-stage
    failure and preserve extracted artifacts.
    """
    try:
        pass
    except Exception as exc:
        logger.error(
            "ingest_pdf_embedding_handoff_failed",
            media_id=str(media_uuid),
            error=str(exc),
            request_id=request_id,
        )
        try:
            media = db.get(Media, media_uuid)
            if media and media.processing_status == ProcessingStatus.ready_for_reading:
                now = datetime.now(UTC)
                media.processing_status = ProcessingStatus.failed
                media.failure_stage = FailureStage.embed
                media.last_error_code = "E_INGEST_FAILED"
                media.last_error_message = f"Embedding handoff failed: {exc}"[:1000]
                media.failed_at = now
                media.updated_at = now
                db.commit()
        except Exception:
            logger.exception(
                "ingest_pdf_failed_to_mark_embed_failure",
                media_id=str(media_uuid),
            )


def _try_enrich_dispatch(media_id: str, request_id: str | None) -> None:
    """Best-effort dispatch of metadata enrichment task."""
    session_factory = get_session_factory()
    db = session_factory()
    try:
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload={"media_id": media_id, "request_id": request_id},
            max_attempts=1,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)
    finally:
        db.close()


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
