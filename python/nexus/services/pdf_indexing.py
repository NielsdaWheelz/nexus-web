"""PDF evidence indexing ownership."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.errors import ApiError
from nexus.logging import get_logger
from nexus.services.media_processing_state import mark_stage_warning
from nexus.services.pdf_ingest import PdfExtractionResult

logger = get_logger(__name__)


def index_pdf_evidence(
    db: Session,
    media_uuid: UUID,
    request_id: str | None,
    extraction_result: PdfExtractionResult | None = None,
) -> None:
    """Index extracted PDF text into the shared evidence layer."""
    try:
        from nexus.services.content_indexing import (
            build_pdf_indexable_blocks,
            rebuild_media_content_index,
        )

        media = db.get(Media, media_uuid)
        if media is None:
            raise RuntimeError("Media not found for PDF content indexing")

        plain_text = extraction_result.plain_text if extraction_result else media.plain_text or ""
        page_spans = (
            list(extraction_result.page_spans)
            if extraction_result
            else list(media.pdf_page_text_spans)
        )
        page_spans = sorted(page_spans, key=lambda span: span.page_number)
        blocks = build_pdf_indexable_blocks(
            media_id=media_uuid,
            plain_text=plain_text,
            page_spans=page_spans,
            extraction_method=extraction_result.extraction_method
            if extraction_result
            else "digital_text",
            ocr_confidence=extraction_result.ocr_confidence if extraction_result else None,
        )

        index_result = rebuild_media_content_index(
            db,
            media_id=media_uuid,
            source_kind="pdf",
            blocks=blocks,
            reason="pdf_ingest",
        )
        if not plain_text.strip():
            _mark_pdf_ocr_required_index(db, media_uuid)
        db.commit()

        logger.info(
            "ingest_pdf_evidence_index_completed",
            media_id=str(media_uuid),
            request_id=request_id,
            index_status=index_result.status,
            chunk_count=index_result.chunk_count,
        )
    except Exception as exc:
        db.rollback()
        logger.error(
            "ingest_pdf_evidence_index_failed",
            media_id=str(media_uuid),
            error=str(exc),
            request_id=request_id,
        )
        error_code = exc.code.value if isinstance(exc, ApiError) else "E_INGEST_FAILED"
        try:
            from nexus.services.content_indexing import mark_content_index_failed

            media = db.get(Media, media_uuid)
            if media:
                failure_message = f"PDF evidence index failed: {exc}"[:1000]
                mark_stage_warning(
                    db,
                    media,
                    stage="embed",
                    error_code=error_code,
                    error_message=failure_message,
                )
                mark_content_index_failed(
                    db,
                    media_id=media_uuid,
                    failure_code=error_code,
                    failure_message=failure_message,
                )
                db.commit()
        except Exception:
            logger.exception(
                "ingest_pdf_failed_to_mark_evidence_index_failure",
                media_id=str(media_uuid),
            )


def _mark_pdf_ocr_required_index(db: Session, media_uuid: UUID) -> None:
    now = datetime.now(UTC)
    db.execute(
        text(
            """
            UPDATE media_content_index_states
            SET status = 'ocr_required',
                status_reason = 'ocr_required',
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_uuid, "now": now},
    )
