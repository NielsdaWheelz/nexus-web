"""PDF ingest + retry lifecycle orchestration (S6 PR-03).

Owns C3 lifecycle policy: dispatch, state transitions, retry guards, and
artifact cleanup/invalidation for PDF media. Routes call exactly one
function here. Mirrors the EPUB lifecycle split.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import (
    FailureStage,
    Media,
    MediaFile,
    ProcessingStatus,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.services.pdf_ingest import (
    delete_pdf_text_artifacts,
    invalidate_pdf_quote_match_metadata,
)
from nexus.services.upload import (
    confirm_ingest as _base_confirm_ingest,
)
from nexus.services.upload import (
    validate_source_integrity,
)
from nexus.storage import get_storage_client

logger = logging.getLogger(__name__)


def retry_for_viewer_unified(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """Unified retry entry point. Routes PDF to pdf_lifecycle, else to epub_lifecycle."""
    media = db.execute(select(Media).where(Media.id == media_id)).scalar()
    if media is not None and media.kind == "pdf":
        return retry_pdf_ingest_for_viewer(db, viewer_id, media_id, request_id=request_id)
    from nexus.services.epub_lifecycle import retry_epub_ingest_for_viewer

    return retry_epub_ingest_for_viewer(db, viewer_id, media_id, request_id=request_id)


def confirm_pdf_ingest(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """PDF-specific ingest confirm with dispatch.

    Called by the unified confirm_ingest_for_viewer when kind='pdf'.
    Validates via base confirm_ingest, then dispatches PDF extraction.
    """
    base_result = _base_confirm_ingest(db, viewer_id, media_id)
    actual_media_id = UUID(base_result["media_id"])

    if base_result["duplicate"]:
        winner = db.get(Media, actual_media_id)
        return {
            "media_id": base_result["media_id"],
            "duplicate": True,
            "processing_status": winner.processing_status.value if winner else "pending",
            "ingest_enqueued": False,
        }

    media = db.execute(select(Media).where(Media.id == actual_media_id).with_for_update()).scalar()

    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.processing_status != ProcessingStatus.pending:
        return {
            "media_id": str(media.id),
            "duplicate": False,
            "processing_status": media.processing_status.value,
            "ingest_enqueued": False,
        }

    media_file = media.media_file
    if not media_file:
        _mark_pdf_failed(
            db,
            media,
            "upload",
            ApiErrorCode.E_STORAGE_MISSING.value,
            "No media file record",
        )
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Upload not found. Please try again.",
        )

    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now
    db.flush()

    try:
        from nexus.tasks.ingest_pdf import ingest_pdf

        ingest_pdf.apply_async(
            args=[str(media.id)],
            kwargs={"request_id": request_id},
            queue="ingest",
        )
    except Exception as exc:
        db.rollback()
        logger.error(
            "pdf_dispatch_failed media_id=%s error=%s",
            media.id,
            exc,
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue extraction job.",
        ) from exc

    db.commit()

    return {
        "media_id": str(media.id),
        "duplicate": False,
        "processing_status": "extracting",
        "ingest_enqueued": True,
    }


def retry_pdf_ingest_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """Retry endpoint orchestration for failed PDF media.

    Implements S6-PR03-D11 precedence-ordered retry inference matrix:
    1. non-failed -> E_RETRY_INVALID_STATE
    2. E_PDF_PASSWORD_REQUIRED -> terminal E_RETRY_NOT_ALLOWED
    3. failure_stage='embed' -> embedding-only retry (no text rewrite)
    4. failure_stage in {upload,extract,other} -> text-rebuild retry
    5. failure_stage='transcribe' (impossible for PDF) -> fail closed
    """
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()

    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != "pdf":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Retry is only supported for PDF/EPUB media.",
        )

    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can retry extraction.",
        )

    if media.processing_status != ProcessingStatus.failed:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be in failed state to retry.",
        )

    if media.last_error_code == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Retry not allowed for password-protected PDF. Upload a new file.",
        )

    failure_stage = media.failure_stage

    if failure_stage == FailureStage.transcribe:
        logger.error(
            "pdf_retry_impossible_failure_stage media_id=%s failure_stage=transcribe",
            media_id,
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Internal integrity error: impossible failure stage for PDF.",
        )

    if failure_stage == FailureStage.embed:
        return _retry_pdf_embedding_only(db, media, request_id=request_id)
    else:
        return _retry_pdf_text_rebuild(db, media, request_id=request_id)


def _retry_pdf_embedding_only(
    db: Session,
    media: Media,
    *,
    request_id: str | None = None,
) -> dict:
    """Embedding/search-only retry. Does NOT rewrite text artifacts."""
    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now
    db.flush()

    try:
        from nexus.tasks.ingest_pdf import ingest_pdf

        ingest_pdf.apply_async(
            args=[str(media.id)],
            kwargs={"request_id": request_id, "embedding_only": True},
            queue="ingest",
        )
    except Exception as exc:
        db.rollback()
        logger.error("pdf_embed_retry_dispatch_failed media_id=%s error=%s", media.id, exc)
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue retry job.",
        ) from exc

    db.commit()
    return {
        "media_id": str(media.id),
        "processing_status": "extracting",
        "retry_enqueued": True,
    }


def _retry_pdf_text_rebuild(
    db: Session,
    media: Media,
    *,
    request_id: str | None = None,
) -> dict:
    """Text-rebuild retry. Invalidates quote-match metadata, deletes text artifacts,
    then re-dispatches full extraction."""
    media_file = db.execute(select(MediaFile).where(MediaFile.media_id == media.id)).scalar()
    if media_file is None:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Source file metadata missing.",
        )

    storage_client = get_storage_client()
    validate_source_integrity(
        storage_client,
        media_file,
        media.kind,
        expected_sha256=media.file_sha256,
    )

    invalidate_pdf_quote_match_metadata(db, media.id)
    delete_pdf_text_artifacts(db, media.id)

    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = now
    db.flush()

    try:
        from nexus.tasks.ingest_pdf import ingest_pdf

        ingest_pdf.apply_async(
            args=[str(media.id)],
            kwargs={"request_id": request_id},
            queue="ingest",
        )
    except Exception as exc:
        db.rollback()
        logger.error("pdf_text_rebuild_dispatch_failed media_id=%s error=%s", media.id, exc)
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue extraction job.",
        ) from exc

    db.commit()
    return {
        "media_id": str(media.id),
        "processing_status": "extracting",
        "retry_enqueued": True,
    }


def _mark_pdf_failed(
    db: Session,
    media: Media,
    stage: str,
    error_code: str,
    error_message: str,
) -> None:
    now = datetime.now(UTC)
    media.processing_status = ProcessingStatus.failed
    media.failure_stage = FailureStage(stage)
    media.last_error_code = error_code
    media.last_error_message = error_message
    media.failed_at = now
    media.updated_at = now
    db.commit()
