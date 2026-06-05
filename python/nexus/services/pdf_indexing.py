"""PDF evidence indexing ownership."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.errors import ApiError
from nexus.logging import get_logger
from nexus.services.media_processing_state import mark_stage_warning
from nexus.services.pdf_ingest import TEXT_EXTRACT_VERSION, PdfExtractionResult

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
            IndexableBlock,
            SourceSnapshotSpec,
            rebuild_media_content_index,
        )

        media = db.get(Media, media_uuid)
        if media is None:
            raise RuntimeError("Media not found for PDF content indexing")

        plain_text = extraction_result.plain_text if extraction_result else media.plain_text or ""
        text_bytes = plain_text.encode("utf-8")
        source_fingerprint = None
        if extraction_result and extraction_result.source_fingerprint:
            source_fingerprint = extraction_result.source_fingerprint
        elif media.file_sha256:
            source_fingerprint = f"sha256:{media.file_sha256}"
        else:
            source_fingerprint = f"media:{media_uuid}"

        page_spans = (
            list(extraction_result.page_spans)
            if extraction_result
            else list(media.pdf_page_text_spans)
        )
        page_spans = sorted(page_spans, key=lambda span: span.page_number)
        blocks = []
        for block_idx, page_span in enumerate(page_spans):
            page_text = plain_text[page_span.start_offset : page_span.end_offset]
            page_label = getattr(page_span, "page_label", None)
            text_quote = _text_quote(plain_text, page_span.start_offset, page_span.end_offset)
            locator = {
                "kind": "pdf_text",
                "version": 1,
                "source_fingerprint": source_fingerprint,
                "page_number": page_span.page_number,
                "physical_page_number": page_span.page_number,
                "page_label": page_label,
                "plain_text_start_offset": page_span.start_offset,
                "plain_text_end_offset": page_span.end_offset,
                "page_text_start_offset": 0,
                "page_text_end_offset": len(page_text),
                "text_quote": text_quote,
                "extraction": {
                    "method": extraction_result.extraction_method
                    if extraction_result
                    else "digital_text",
                    "ocr_engine": extraction_result.ocr_engine if extraction_result else None,
                    "ocr_engine_version": (
                        extraction_result.ocr_engine_version if extraction_result else None
                    ),
                    "ocr_confidence": extraction_result.ocr_confidence
                    if extraction_result
                    else None,
                },
            }
            page_width = getattr(page_span, "page_width", None)
            page_height = getattr(page_span, "page_height", None)
            if page_width and page_height:
                locator["geometry"] = {
                    "version": 1,
                    "coordinate_space": "pdf_points",
                    "page_width": page_width,
                    "page_height": page_height,
                    "page_rotation_degrees": getattr(page_span, "page_rotation_degrees", None) or 0,
                    "page_box": "crop",
                    "quads": [],
                }
            selector = {
                "kind": "pdf_text_quote",
                "version": 1,
                "source_fingerprint": source_fingerprint,
                "page_number": page_span.page_number,
                "physical_page_number": page_span.page_number,
                "page_label": page_label,
                "page_text_start_offset": 0,
                "page_text_end_offset": len(page_text),
                "text_quote": text_quote,
            }
            blocks.append(
                IndexableBlock(
                    media_id=media_uuid,
                    source_kind="pdf",
                    block_idx=block_idx,
                    block_kind="pdf_text_block",
                    canonical_text=page_text,
                    source_start_offset=page_span.start_offset,
                    source_end_offset=page_span.end_offset,
                    locator=locator,
                    selector=selector,
                    heading_path=(f"p. {page_label or page_span.page_number}",),
                    metadata={
                        "text_extract_version": TEXT_EXTRACT_VERSION,
                        "source_fingerprint": source_fingerprint,
                        "page_number": page_span.page_number,
                        "page_label": page_label,
                        "extraction_method": locator["extraction"]["method"],
                    },
                    extraction_confidence=extraction_result.ocr_confidence
                    if extraction_result
                    else None,
                )
            )

        index_result = rebuild_media_content_index(
            db,
            media_id=media_uuid,
            source_kind="pdf",
            source_snapshot=SourceSnapshotSpec(
                artifact_kind="pdf_text",
                artifact_ref=f"media:{media_uuid}:pdf_text",
                content_type="text/plain",
                byte_length=len(text_bytes),
                content_sha256=hashlib.sha256(text_bytes).hexdigest(),
                source_version=f"pdf_text_v{TEXT_EXTRACT_VERSION}",
                extractor_version=f"pymupdf_text_v{TEXT_EXTRACT_VERSION}",
                parent_snapshot_id=None,
                language=None,
                metadata={
                    "page_count": media.page_count or 0,
                    "source_fingerprint": source_fingerprint,
                    "has_text": bool(plain_text.strip()),
                    "ocr_required": not bool(plain_text.strip()),
                    "source_byte_length": extraction_result.source_byte_length
                    if extraction_result
                    else None,
                    "text_extract_version": TEXT_EXTRACT_VERSION,
                },
                source_fingerprint=source_fingerprint,
            ),
            blocks=blocks,
            reason="pdf_ingest",
        )
        if not plain_text.strip():
            _mark_pdf_ocr_required_index(db, media_uuid, index_result.run_id)
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


def _text_quote(text_value: str, start_offset: int, end_offset: int) -> dict[str, str]:
    return {
        "exact": text_value[start_offset:end_offset],
        "prefix": text_value[max(0, start_offset - 64) : start_offset],
        "suffix": text_value[end_offset : end_offset + 64],
    }


def _mark_pdf_ocr_required_index(db: Session, media_uuid: UUID, run_id: UUID) -> None:
    now = datetime.now(UTC)
    db.execute(
        text(
            """
            UPDATE content_index_runs
            SET state = 'ocr_required',
                finished_at = :now
            WHERE id = :run_id
            """
        ),
        {"run_id": run_id, "now": now},
    )
    db.execute(
        text(
            """
            UPDATE media_content_index_states
            SET status = 'ocr_required',
                status_reason = 'ocr_required',
                updated_at = :now
            WHERE media_id = :media_id
              AND latest_run_id = :run_id
            """
        ),
        {"media_id": media_uuid, "run_id": run_id, "now": now},
    )
