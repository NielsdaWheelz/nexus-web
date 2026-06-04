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

from nexus.config import get_settings
from nexus.db.models import (
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
from nexus.services import library_entries, library_governance
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.media_deletion import delete_duplicate_document_media
from nexus.services.media_processing_state import mark_failed
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

    library_governance.validate_libraries_accessible(db, viewer_id, library_ids)

    # Validate request
    validate_file_ingest_request(kind, content_type, size_bytes)

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
    library_entries.assign_libraries_for_media(db, viewer_id, media_id, library_ids)

    db.commit()

    return {
        "media_id": str(media_id),
        "upload_url": signed_upload.upload_url,
        "expires_at": expires_at.isoformat(),
    }


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
        mark_failed(
            db,
            media,
            stage="upload",
            error_code=ApiErrorCode.E_STORAGE_MISSING.value,
            error_message="No media file record",
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
        mark_failed(
            db,
            media,
            stage="upload",
            error_code=ApiErrorCode.E_STORAGE_MISSING.value,
            error_message="No media file record",
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
        mark_failed(
            db,
            media,
            stage="upload",
            error_code=ApiErrorCode.E_STORAGE_MISSING.value,
            error_message="No media file record",
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
        library_entries.ensure_media_in_default_library(db, viewer_id, existing.id)
        _delete_duplicate_upload_loser(
            db,
            storage_client,
            media_id,
            [storage_path, final_storage_path],
            "duplicate_loser",
        )

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
            library_entries.ensure_media_in_default_library(db, viewer_id, winner.id)
            _delete_duplicate_upload_loser(
                db,
                storage_client,
                media_id,
                [storage_path, final_storage_path],
                "integrity_duplicate_loser",
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


def _delete_duplicate_upload_loser(
    db: Session,
    storage_client,
    media_id: UUID,
    storage_paths: list[str],
    reason: str,
) -> None:
    db_storage_paths = delete_duplicate_document_media(db, media_id)
    db.commit()
    cleanup_paths: list[str] = []
    seen_paths: set[str] = set()
    for storage_path in [*storage_paths, *db_storage_paths]:
        if storage_path in seen_paths:
            continue
        cleanup_paths.append(storage_path)
        seen_paths.add(storage_path)
    for storage_path in cleanup_paths:
        _delete_upload_object(storage_client, storage_path, media_id, reason)


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
        mark_failed(db, media, stage=stage, error_code=error_code, error_message=error_message)
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
        hasher.update(chunk)

    if total_bytes <= 0 or total_bytes != metadata.size_bytes or total_bytes != declared_size:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Uploaded file size does not match the stored object. Please upload the file again.",
        )
    return hasher.hexdigest(), total_bytes

