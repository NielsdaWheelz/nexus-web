"""EPUB ingest + retry lifecycle orchestration (S5 PR-03).

Owns C4 lifecycle policy: dispatch, state transitions, retry guards, and
artifact cleanup for EPUB media.  Routes call exactly one function here.
Non-EPUB kinds fall through to existing upload-confirm behavior.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    EpubTocNode,
    FailureStage,
    Fragment,
    FragmentBlock,
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
from nexus.services.epub_ingest import check_archive_safety
from nexus.services.upload import (
    confirm_ingest as _base_confirm_ingest,
)
from nexus.services.upload import (
    validate_source_integrity,
)
from nexus.storage import get_storage_client

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EpubIngestConfirmOut:
    media_id: str
    duplicate: bool
    processing_status: str
    ingest_enqueued: bool


@dataclass(frozen=True)
class EpubRetryOut:
    media_id: str
    processing_status: str
    retry_enqueued: bool


def confirm_ingest_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """Unified ingest-confirm entry point called by the route.

    For EPUB: validates, hashes, deduplicates via base confirm_ingest, then
    runs preflight archive safety and dispatches extraction.
    For non-EPUB: delegates to base confirm_ingest (S1 behavior).
    """
    media = db.execute(select(Media).where(Media.id == media_id)).scalar()

    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != "epub":
        result = _base_confirm_ingest(db, viewer_id, media_id)
        return {
            "media_id": result["media_id"],
            "duplicate": result["duplicate"],
            "processing_status": "pending",
            "ingest_enqueued": False,
        }

    return _confirm_epub_ingest(db, viewer_id, media_id, request_id=request_id)


def _confirm_epub_ingest(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """EPUB-specific ingest confirm with preflight and dispatch."""
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

    storage_client = get_storage_client()
    media_file = media.media_file
    if not media_file:
        _mark_epub_failed(
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

    try:
        epub_bytes = b"".join(storage_client.stream_object(media_file.storage_path))
    except Exception as exc:
        _mark_epub_failed(
            db,
            media,
            "upload",
            ApiErrorCode.E_STORAGE_ERROR.value,
            "Failed to read EPUB from storage",
        )
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Failed to read uploaded file.",
        ) from exc

    safety_err = check_archive_safety(epub_bytes)
    if safety_err is not None:
        _mark_epub_failed(
            db,
            media,
            "extract",
            safety_err.error_code,
            safety_err.error_message,
        )
        raise InvalidRequestError(
            ApiErrorCode.E_ARCHIVE_UNSAFE,
            safety_err.error_message,
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
        from nexus.tasks.ingest_epub import ingest_epub

        ingest_epub.apply_async(
            args=[str(media.id)],
            kwargs={"request_id": request_id},
            queue="ingest",
        )
    except Exception as exc:
        db.rollback()
        logger.error(
            "epub_dispatch_failed media_id=%s error=%s",
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


def retry_epub_ingest_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """Retry endpoint orchestration for failed EPUB media."""
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()

    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind != "epub":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Retry is only supported for EPUB media.",
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

    if media.last_error_code == ApiErrorCode.E_ARCHIVE_UNSAFE.value:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Retry not allowed for terminal archive failure. Upload a new file.",
        )

    media_file = db.execute(select(MediaFile).where(MediaFile.media_id == media_id)).scalar()
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

    _delete_extraction_artifacts(db, media_id)

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
        from nexus.tasks.ingest_epub import ingest_epub

        ingest_epub.apply_async(
            args=[str(media.id)],
            kwargs={"request_id": request_id},
            queue="ingest",
        )
    except Exception as exc:
        db.rollback()
        logger.error(
            "epub_retry_dispatch_failed media_id=%s error=%s",
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
        "processing_status": "extracting",
        "retry_enqueued": True,
    }


def _delete_extraction_artifacts(db: Session, media_id: UUID) -> None:
    """Delete all extraction and chunk/embedding artifacts for a media row."""
    db.execute(delete(EpubTocNode).where(EpubTocNode.media_id == media_id))

    fragment_ids = (
        db.execute(select(Fragment.id).where(Fragment.media_id == media_id)).scalars().all()
    )

    if fragment_ids:
        db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(fragment_ids)))

    db.execute(delete(Fragment).where(Fragment.media_id == media_id))

    db.flush()


def _mark_epub_failed(
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
