"""Worker job handler for PDF extraction (S6 PR-03).

Owns async completion-state transitions for PDF extraction:
extracting -> ready_for_reading (success) or extracting -> failed (error).

On successful extraction, performs explicit handoff to the existing
embedding pipeline so downstream failures surface as failure_stage='embed'.
"""

import hashlib
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.pdf_ingest import (
    TEXT_EXTRACT_VERSION,
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

        _index_pdf_evidence(db, media_uuid, request_id, result)
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

    names: list[str] = []
    if result.pdf_author:
        for sep in [";", ","]:
            if sep in result.pdf_author:
                names = [n.strip() for n in result.pdf_author.split(sep) if n.strip()]
                break
        else:
            names = [result.pdf_author.strip()]
    replace_media_contributor_credits(
        db,
        media_id=media.id,
        source="pdf_metadata",
        credits=[
            {
                "name": name[:255],
                "role": "author",
                "ordinal": i,
                "source": "pdf_metadata",
            }
            for i, name in enumerate(names)
            if name
        ],
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

    _index_pdf_evidence(db, media_uuid, request_id, None)

    return {"status": "success", "embedding_only": True}


def _index_pdf_evidence(
    db,
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
        try:
            from nexus.services.content_indexing import mark_content_index_failed

            media = db.get(Media, media_uuid)
            if media:
                now = datetime.now(UTC)
                media.failure_stage = FailureStage.embed
                media.last_error_code = "E_INGEST_FAILED"
                media.last_error_message = f"PDF evidence index failed: {exc}"[:1000]
                media.failed_at = now
                media.updated_at = now
                mark_content_index_failed(
                    db,
                    media_id=media_uuid,
                    failure_code="E_INGEST_FAILED",
                    failure_message=media.last_error_message,
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


def _mark_pdf_ocr_required_index(db, media_uuid: UUID, run_id: UUID) -> None:
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
