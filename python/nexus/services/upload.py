"""Upload and ingest service layer.

Handles file upload initialization, ingest confirmation, and signed URL generation.
All media-domain upload logic lives here.

Key invariants:
- Upload initialization creates pending media without dispatching extraction
- SHA-256 computed synchronously at ingest time
- Deduplication via (created_by_user_id, kind, file_sha256) constraint
- Storage operations happen after DB transaction commits
"""

import hashlib
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import (
    FailureStage,
    Library,
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
from nexus.services import libraries as libraries_service
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import (
    build_storage_path,
    build_upload_staging_storage_path,
    get_file_extension,
)

logger = logging.getLogger(__name__)

# Content type validation
VALID_CONTENT_TYPES = {
    "pdf": {"application/pdf"},
    "epub": {"application/epub+zip"},
}

# Magic bytes for file type validation
MAGIC_BYTES = {
    "pdf": b"%PDF-",
    "epub": b"PK\x03\x04",  # ZIP header (EPUB is a ZIP file)
}


def _validate_upload_request(kind: str, content_type: str, size_bytes: int) -> None:
    """Validate upload init request parameters.

    Raises:
        InvalidRequestError: If validation fails.
    """
    settings = get_settings()

    if kind not in ("pdf", "epub"):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            f"Invalid kind '{kind}'. Upload is only supported for pdf, epub.",
        )

    valid_types = VALID_CONTENT_TYPES.get(kind, set())
    if content_type not in valid_types:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_CONTENT_TYPE,
            f"Invalid content type '{content_type}' for {kind}. "
            f"Expected one of: {', '.join(valid_types)}",
        )

    max_size = settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes
    if size_bytes > max_size:
        raise InvalidRequestError(
            ApiErrorCode.E_FILE_TOO_LARGE,
            f"File size {size_bytes} bytes exceeds maximum {max_size} bytes for {kind}.",
        )


def _get_default_library_id(db: Session, user_id: UUID) -> UUID:
    """Get the user's default library ID.

    Raises:
        NotFoundError: If user has no default library (shouldn't happen).
    """
    result = db.execute(
        select(Library.id).where(
            Library.owner_user_id == user_id,
            Library.is_default.is_(True),
        )
    )
    library_id = result.scalar()

    if not library_id:
        raise NotFoundError(
            ApiErrorCode.E_NOT_FOUND,
            "Default library not found",
        )

    return library_id


def init_upload(
    db: Session,
    viewer_id: UUID,
    kind: str,
    filename: str,
    content_type: str,
    size_bytes: int,
    library_ids: list[UUID],
) -> dict:
    """Initialize a file upload.

    Creates media stub and returns signed upload URL.
    Ordering: Mint signed URL before persisting rows to avoid orphans on signing failure.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer (will be created_by_user_id).
        kind: Media kind (pdf, epub).
        filename: Original filename.
        content_type: MIME content type.
        size_bytes: File size in bytes.
        library_ids: Additional libraries to attach the new media to. The viewer's
            default library is always implicit; this list adds non-default libraries
            on top. Empty list means default-only.

    Returns:
        Dict with media_id, upload_url, and expires_at.

    Raises:
        InvalidRequestError: If validation fails.
        ForbiddenError: If any id in library_ids is inaccessible to the viewer.
        ApiError: If signing fails.
    """
    settings = get_settings()

    libraries_service.validate_libraries_accessible(db, viewer_id, library_ids)

    # Validate request
    _validate_upload_request(kind, content_type, size_bytes)

    # Get file extension
    ext = get_file_extension(kind)

    # Generate media_id before persisting
    media_id = uuid4()
    storage_path = build_upload_staging_storage_path(media_id, ext)

    # Mint signed upload URL FIRST (before DB writes)
    storage_client = get_storage_client()
    try:
        signed_upload = storage_client.sign_upload(
            storage_path,
            content_type=content_type,
            size_bytes=size_bytes,
            expires_in=settings.signed_url_expiry_s,
        )
    except StorageError as e:
        logger.error(
            "Failed to sign upload: media_id=%s, path=%s, error=%s",
            media_id,
            storage_path,
            e.message,
        )
        raise ApiError(ApiErrorCode.E_SIGN_UPLOAD_FAILED, "Failed to initialize upload") from e

    # Now persist to DB in a single transaction
    now = datetime.now(UTC)
    expires_at = now + timedelta(seconds=settings.signed_url_expiry_s)

    # Create media row
    media = Media(
        id=media_id,
        kind=kind,
        title=filename,  # Use filename as initial title
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)

    # Create media_file row
    media_file = MediaFile(
        media_id=media_id,
        storage_path=storage_path,
        content_type=content_type,
        size_bytes=size_bytes,
    )
    db.add(media_file)

    # Flush media + media_file first so FK on closure tables is satisfied
    db.flush()

    # Attach to viewer's default library + every additional library in library_ids.
    # Raises ForbiddenError(E_LIBRARY_FORBIDDEN) atomically if any id is inaccessible.
    libraries_service.assign_libraries_for_media(db, viewer_id, media_id, library_ids)

    db.commit()

    return {
        "media_id": str(media_id),
        "upload_url": signed_upload.upload_url,
        "expires_at": expires_at.isoformat(),
    }


def _validate_magic_bytes(content: bytes, kind: str) -> bool:
    """Validate file content by checking magic bytes.

    Args:
        content: First bytes of the file.
        kind: Expected media kind.

    Returns:
        True if magic bytes match expected pattern.
    """
    expected = MAGIC_BYTES.get(kind)
    if expected is None:
        return True  # No magic bytes defined for this kind

    return content.startswith(expected)


def _find_existing_by_hash(db: Session, user_id: UUID, kind: str, sha256: str) -> Media | None:
    """Find existing media by hash for deduplication."""
    result = db.execute(
        select(Media).where(
            Media.created_by_user_id == user_id,
            Media.kind == kind,
            Media.file_sha256 == sha256,
        )
    )
    return result.scalar()


def confirm_ingest(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> dict:
    """Confirm upload and process file.

    Validates file, computes hash, handles deduplication.
    Extraction dispatch is owned by the media-kind lifecycle layer.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The media ID to ingest.

    Returns:
        Dict with media_id and duplicate flag.

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

    if media.file_sha256 is not None:
        return {
            "media_id": str(media.id),
            "duplicate": False,
        }

    media_file = media.media_file
    if not media_file:
        _mark_failed(
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

    storage_path = media_file.storage_path
    declared_size = int(media_file.size_bytes or 0)
    kind = str(media.kind)
    ext = get_file_extension(kind)
    final_storage_path = build_storage_path(media_id, ext)
    expected_staging_path = build_upload_staging_storage_path(media_id, ext)
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
        computed_sha, total_bytes = _read_validated_upload_object(
            storage_client,
            storage_path,
            kind,
            declared_size,
            max_size=settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes,
        )
    except InvalidRequestError as exc:
        _mark_failed_and_delete_upload_by_id(
            db,
            media_id,
            storage_client,
            storage_path,
            "upload",
            exc.code.value,
            exc.message,
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

    if media.file_sha256 is not None:
        db.commit()
        _delete_upload_object(storage_client, storage_path, media_id, "already_confirmed")
        return {
            "media_id": str(media.id),
            "duplicate": False,
        }

    media_file = media.media_file
    if not media_file:
        _delete_upload_object(storage_client, storage_path, media_id, "missing_media_file")
        _mark_failed(
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
        final_sha, final_size = _read_validated_upload_object(
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
    except InvalidRequestError as exc:
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "final_validation_failed"
        )
        _mark_failed_and_delete_upload_by_id(
            db,
            media_id,
            storage_client,
            storage_path,
            "upload",
            exc.code.value,
            exc.message,
        )
        raise

    if final_sha != computed_sha or final_size != total_bytes:
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "final_integrity_mismatch"
        )
        _mark_failed_and_delete_upload_by_id(
            db,
            media_id,
            storage_client,
            storage_path,
            "upload",
            ApiErrorCode.E_INVALID_REQUEST.value,
            "Uploaded object changed while it was being finalized",
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

    if media.file_sha256 is not None:
        db.commit()
        _delete_upload_object(
            storage_client, storage_path, media_id, "already_confirmed_after_copy"
        )
        return {
            "media_id": str(media.id),
            "duplicate": False,
        }

    media_file = media.media_file
    if not media_file:
        _delete_upload_object(storage_client, storage_path, media_id, "missing_file_after_copy")
        _delete_upload_object(
            storage_client, final_storage_path, media_id, "missing_file_after_copy"
        )
        _mark_failed(
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

    existing = _find_existing_by_hash(db, created_by_user_id, kind, computed_sha)

    if existing and existing.id != media.id:
        db.execute(
            text("DELETE FROM user_media_deletions WHERE media_id = :media_id"),
            {"media_id": media.id},
        )
        db.delete(media)
        _ensure_in_default_library(db, viewer_id, existing.id)
        db.commit()

        _delete_upload_object(storage_client, storage_path, media_id, "duplicate_loser")
        _delete_upload_object(storage_client, final_storage_path, media_id, "duplicate_loser")

        return {
            "media_id": str(existing.id),
            "duplicate": True,
        }

    try:
        media.file_sha256 = computed_sha
        media.updated_at = datetime.now(UTC)
        media_file.size_bytes = total_bytes
        media_file.storage_path = final_storage_path
        db.flush()
    except IntegrityError:
        db.rollback()
        winner = _find_existing_by_hash(db, created_by_user_id, kind, computed_sha)
        if winner:
            db.execute(select(Media).where(Media.id == media_id).with_for_update())
            result = db.execute(select(Media).where(Media.id == media_id))
            media_to_delete = result.scalar()
            if media_to_delete:
                db.execute(
                    text("DELETE FROM user_media_deletions WHERE media_id = :media_id"),
                    {"media_id": media_to_delete.id},
                )
                db.delete(media_to_delete)

            _ensure_in_default_library(db, viewer_id, winner.id)
            db.commit()

            _delete_upload_object(
                storage_client, storage_path, media_id, "integrity_duplicate_loser"
            )
            _delete_upload_object(
                storage_client, final_storage_path, media_id, "integrity_duplicate_loser"
            )

            return {
                "media_id": str(winner.id),
                "duplicate": True,
            }

        _delete_upload_object(storage_client, final_storage_path, media_id, "dedupe_failed")
        raise ApiError(ApiErrorCode.E_INTERNAL, "Unexpected error during deduplication") from None

    db.commit()
    _delete_upload_object(storage_client, storage_path, media_id, "confirmed")

    return {
        "media_id": str(media.id),
        "duplicate": False,
    }


def _mark_failed(
    db: Session,
    media: Media,
    stage: str,
    error_code: str,
    error_message: str,
) -> None:
    """Mark media as failed.

    Args:
        db: Database session.
        media: Media instance (must be in session).
        stage: Failure stage (upload, extract, transcribe, embed, other).
        error_code: Error code string.
        error_message: Human-readable error message.
    """
    media.processing_status = ProcessingStatus.failed
    media.failure_stage = FailureStage(stage)
    media.last_error_code = error_code
    media.last_error_message = error_message
    media.failed_at = datetime.now(UTC)
    media.updated_at = datetime.now(UTC)
    db.commit()


def _clear_upload_confirmation_claim(db: Session, media_id: UUID) -> None:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is not None and media.file_sha256 is None:
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


def _mark_failed_and_delete_upload_by_id(
    db: Session,
    media_id: UUID,
    storage_client,
    storage_path: str,
    stage: str,
    error_code: str,
    error_message: str,
) -> None:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is not None and media.file_sha256 is None:
        _mark_failed(db, media, stage, error_code, error_message)
    else:
        db.commit()
    _delete_upload_object(storage_client, storage_path, media_id, "failed_upload")


def _read_validated_upload_object(
    storage_client,
    storage_path: str,
    kind: str,
    declared_size: int,
    *,
    max_size: int,
) -> tuple[str, int]:
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

    hasher = hashlib.sha256()
    total_bytes = 0
    first_chunk = True
    for chunk in storage_client.stream_object(storage_path):
        if first_chunk:
            if not _validate_magic_bytes(chunk, kind):
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
        hasher.update(chunk)

    if total_bytes <= 0 or total_bytes != metadata.size_bytes or total_bytes != declared_size:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Uploaded file size does not match the stored object. Please upload the file again.",
        )
    return hasher.hexdigest(), total_bytes


def _ensure_in_default_library(db: Session, user_id: UUID, media_id: UUID) -> None:
    """Ensure media is in user's default library with intrinsic provenance.

    Idempotent: no-op if already present. Delegates to shared closure helper.
    """
    from nexus.services.default_library_closure import ensure_default_intrinsic
    from nexus.services.media_deletion import clear_user_media_deletion

    default_library_id = _get_default_library_id(db, user_id)
    ensure_default_intrinsic(db, default_library_id, media_id)
    clear_user_media_deletion(db, user_id, media_id)


def validate_source_integrity(
    storage_client,
    media_file: MediaFile,
    kind: str,
    *,
    expected_sha256: str | None = None,
) -> None:
    """Validate stored file integrity for retry/re-extraction source preconditions.

    Checks object exists, magic bytes match, size within limits, and optionally
    that stored hash matches expected.  Raises on any failure — caller can rely
    on deterministic error semantics with zero side-effects on the media row.
    """
    settings = get_settings()

    try:
        metadata = storage_client.head_object(media_file.storage_path)
        if metadata is None:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING,
                "Source file not found in storage.",
            )
    except StorageError as e:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, f"Failed to read source file: {e.message}"
        ) from e

    max_size = settings.max_pdf_bytes if kind == "pdf" else settings.max_epub_bytes
    try:
        hasher = hashlib.sha256()
        total_bytes = 0
        first_chunk = True

        for chunk in storage_client.stream_object(media_file.storage_path):
            if first_chunk:
                if not _validate_magic_bytes(chunk, kind):
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
            hasher.update(chunk)

        if expected_sha256 is not None:
            computed = hasher.hexdigest()
            if computed != expected_sha256:
                raise InvalidRequestError(
                    ApiErrorCode.E_STORAGE_MISSING,
                    "Source integrity mismatch: stored hash does not match source bytes.",
                )

    except StorageError as e:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, f"Failed to read source file: {e.message}"
        ) from e


def get_signed_download_url(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> dict:
    """Get a signed download URL for a media file.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        media_id: The media ID.

    Returns:
        Dict with url and expires_at.

    Raises:
        NotFoundError: If media doesn't exist or viewer can't read.
    """
    settings = get_settings()

    # Check visibility
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    # Get media_file
    result = db.execute(select(MediaFile).where(MediaFile.media_id == media_id))
    media_file = result.scalar()

    if not media_file:
        raise NotFoundError(
            ApiErrorCode.E_MEDIA_NOT_FOUND,
            "No file available for this media",
        )

    # Sign download URL
    storage_client = get_storage_client()
    try:
        url = storage_client.sign_download(
            media_file.storage_path,
            expires_in=settings.signed_url_expiry_s,
        )
    except StorageError as e:
        logger.error("Failed to sign download: %s", e.message)
        raise ApiError(
            ApiErrorCode.E_SIGN_DOWNLOAD_FAILED, "Failed to generate download URL"
        ) from e

    expires_at = datetime.now(UTC) + timedelta(seconds=settings.signed_url_expiry_s)

    return {
        "url": url,
        "expires_at": expires_at.isoformat(),
    }
