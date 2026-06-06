"""Upload and ingest service layer.

Handles file upload initialization, ingest confirmation, and signed URL generation.
All media-domain upload logic lives here.

Key invariants:
- Upload initialization creates pending media without dispatching extraction
- Upload confirmation validates the staged object and moves it to the final owner path
- Storage operations happen after DB transaction commits
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import (
    Media,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.services.file_ingest_validation import has_valid_file_signature
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import (
    build_storage_path,
    build_upload_staging_storage_path,
    get_file_extension,
)

logger = logging.getLogger(__name__)


def init_upload(
    db: Session,
    viewer_id: UUID,
    kind: str,
    filename: str,
    content_type: str,
    size_bytes: int,
    library_ids: list[UUID],
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """Initialize a file upload through the durable source owner."""
    from nexus.services.media_source_ingest import accept_uploaded_file_source

    return accept_uploaded_file_source(
        db=db,
        viewer_id=viewer_id,
        kind=kind,
        filename=filename,
        content_type=content_type,
        size_bytes=size_bytes,
        library_ids=library_ids,
        request_id=request_id,
        idempotency_key=idempotency_key,
    )


def confirm_ingest(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> dict:
    """Confirm upload and process file.

    Validates the staged file and promotes it to the current storage object.
    Extraction dispatch is owned by the media-kind lifecycle layer.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The media ID to ingest.

    Returns:
        Dict with media_id and a false duplicate flag retained by the API contract.

    Raises:
        NotFoundError: If media doesn't exist.
        ForbiddenError: If viewer is not creator.
        InvalidRequestError: If validation fails.
    """
    settings = get_settings()
    storage_client = get_storage_client()

    result = db.execute(select(Media).where(Media.id == media_id).with_for_update())
    media = result.scalar()

    if not media:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    created_by_user_id = media.created_by_user_id
    if created_by_user_id is None or created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can confirm upload",
        )

    media_file = media.media_file
    if not media_file:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Upload not found. Please try again.",
        )

    storage_path = media_file.storage_path
    declared_size = int(media_file.size_bytes or 0)
    kind = str(media.kind)
    ext = get_file_extension(kind)
    final_storage_path = build_storage_path(media_id, ext)
    expected_staging_path = build_upload_staging_storage_path(media_id, ext)
    if storage_path == final_storage_path:
        if media.processing_status == "pending":
            db.rollback()
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_CONFLICT,
                "Upload state is not staged for confirmation.",
            )
        return {
            "media_id": str(media.id),
            "duplicate": False,
        }
    if storage_path != expected_staging_path:
        db.rollback()
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_CONFLICT,
            "Upload state is not staged for confirmation.",
        )
    if media.processing_started_at is not None:
        db.rollback()
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_CONFLICT,
            "Upload confirmation is already in progress.",
        )
    now = db.execute(text("SELECT now()")).scalar_one()
    media.processing_started_at = now
    media.updated_at = now
    db.commit()

    try:
        total_bytes = _read_validated_upload_object(
            storage_client,
            storage_path,
            kind,
            declared_size,
            max_size=settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes,
        )
    except InvalidRequestError:
        _clear_upload_confirmation_claim_and_delete_upload(
            db,
            media_id,
            storage_client,
            storage_path,
        )
        raise
    except StorageError as exc:
        _clear_upload_confirmation_claim(db, media_id)
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Failed to read uploaded file.",
        ) from exc

    result = db.execute(select(Media).where(Media.id == media_id).with_for_update())
    media = result.scalar()
    if not media:
        _delete_upload_object(storage_client, storage_path, media_id, "missing_media")
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    created_by_user_id = media.created_by_user_id
    if created_by_user_id is None or created_by_user_id != viewer_id:
        _delete_upload_object(storage_client, storage_path, media_id, "forbidden_confirm")
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can confirm upload",
        )

    media_file = media.media_file
    if not media_file:
        _delete_upload_object(storage_client, storage_path, media_id, "missing_media_file")
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Upload not found. Please try again.",
        )

    if media_file.storage_path == final_storage_path:
        db.commit()
        _delete_upload_object(storage_client, storage_path, media_id, "already_confirmed")
        return {
            "media_id": str(media.id),
            "duplicate": False,
        }

    if media_file.storage_path != storage_path or int(media_file.size_bytes or 0) != declared_size:
        db.rollback()
        _delete_upload_object(storage_client, storage_path, media_id, "changed_upload_state")
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_CONFLICT,
            "Upload state changed while it was being confirmed.",
        )
    if media.processing_started_at is None:
        db.rollback()
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_CONFLICT,
            "Upload confirmation state was cleared while it was being confirmed.",
        )

    db.commit()

    try:
        storage_client.copy_object(storage_path, final_storage_path)
        final_size = _read_validated_upload_object(
            storage_client,
            final_storage_path,
            kind,
            declared_size,
            max_size=settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes,
        )
    except StorageError as exc:
        _delete_upload_object(storage_client, final_storage_path, media_id, "finalize_failed")
        _clear_upload_confirmation_claim(db, media_id)
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Failed to finalize uploaded file.",
        ) from exc
    except InvalidRequestError:
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "final_validation_failed"
        )
        _clear_upload_confirmation_claim_and_delete_upload(
            db,
            media_id,
            storage_client,
            storage_path,
        )
        raise

    if final_size != total_bytes:
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "final_integrity_mismatch"
        )
        _clear_upload_confirmation_claim_and_delete_upload(
            db,
            media_id,
            storage_client,
            storage_path,
        )
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Uploaded file changed while it was being finalized. Please upload the file again.",
        )

    result = db.execute(select(Media).where(Media.id == media_id).with_for_update())
    media = result.scalar()
    if not media:
        _delete_upload_object(storage_client, storage_path, media_id, "missing_media_after_copy")
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "missing_media_after_copy"
        )
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    created_by_user_id = media.created_by_user_id
    if created_by_user_id is None or created_by_user_id != viewer_id:
        _delete_upload_object(storage_client, storage_path, media_id, "forbidden_after_copy")
        _delete_upload_object(storage_client, final_storage_path, media_id, "forbidden_after_copy")
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can confirm upload",
        )

    media_file = media.media_file
    if media_file is not None and media_file.storage_path == final_storage_path:
        db.commit()
        _delete_upload_object(
            storage_client, storage_path, media_id, "already_confirmed_after_copy"
        )
        return {
            "media_id": str(media.id),
            "duplicate": False,
        }

    if not media_file:
        _delete_upload_object(storage_client, storage_path, media_id, "missing_file_after_copy")
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "missing_file_after_copy"
        )
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Upload not found. Please try again.",
        )

    if media_file.storage_path != storage_path or int(media_file.size_bytes or 0) != declared_size:
        db.rollback()
        _delete_upload_object(storage_client, storage_path, media_id, "changed_state_after_copy")
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "changed_state_after_copy"
        )
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_CONFLICT,
            "Upload state changed while it was being confirmed.",
        )

    media.updated_at = datetime.now(UTC)
    media_file.size_bytes = total_bytes
    media_file.storage_path = final_storage_path
    db.flush()

    db.commit()
    _delete_upload_object(storage_client, storage_path, media_id, "confirmed")

    return {
        "media_id": str(media.id),
        "duplicate": False,
    }


def _clear_upload_confirmation_claim(db: Session, media_id: UUID) -> None:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is not None:
        media.processing_started_at = None
        media.updated_at = db.execute(text("SELECT now()")).scalar_one()
    db.commit()


def _delete_upload_object(storage_client, storage_path: str, media_id: UUID, reason: str) -> None:
    try:
        storage_client.delete_object(storage_path)
    except StorageError as exc:
        # justify-ignore-error: storage cleanup is secondary to the already
        # committed media state or the primary typed API error being returned.
        logger.warning(
            "upload_storage_cleanup_failed media_id=%s storage_path=%s reason=%s error=%s",
            media_id,
            storage_path,
            reason,
            exc.message,
        )


def _clear_upload_confirmation_claim_and_delete_upload(
    db: Session,
    media_id: UUID,
    storage_client,
    storage_path: str,
) -> None:
    _clear_upload_confirmation_claim(db, media_id)
    _delete_upload_object(storage_client, storage_path, media_id, "failed_upload")


def _read_validated_upload_object(
    storage_client,
    storage_path: str,
    kind: str,
    declared_size: int,
    *,
    max_size: int,
) -> int:
    metadata = storage_client.head_object(storage_path)
    if metadata is None:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Upload not found in storage. Please try again.",
        )
    if metadata.size_bytes <= 0 or declared_size <= 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Uploaded file is empty. Please upload the file again.",
        )
    if metadata.size_bytes != declared_size:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Uploaded file size does not match the upload request. Please upload the file again.",
        )

    total_bytes = 0
    first_chunk = True
    for chunk in storage_client.stream_object(storage_path):
        if first_chunk:
            if not has_valid_file_signature(chunk, kind):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_FILE_TYPE,
                    f"Invalid file type. Expected {kind}.",
                )
            first_chunk = False

        total_bytes += len(chunk)
        if total_bytes > max_size:
            raise InvalidRequestError(
                ApiErrorCode.E_FILE_TOO_LARGE,
                f"File size exceeds maximum {max_size} bytes for {kind}.",
            )
    if total_bytes <= 0 or total_bytes != metadata.size_bytes or total_bytes != declared_size:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Uploaded file size does not match the stored object. Please upload the file again.",
        )
    return total_bytes
