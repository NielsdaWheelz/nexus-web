"""Remote PDF/EPUB URL ingest."""

import logging
import posixpath
from datetime import UTC, datetime
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaFile, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.jobs.queue import enqueue_job
from nexus.schemas.media import FromUrlResponse
from nexus.services import library_entries
from nexus.services.file_ingest_validation import validate_file_ingest_request
from nexus.services.media_processing_state import begin_extraction
from nexus.services.remote_file_client import REMOTE_FILE_CONTENT_TYPES, fetch_to_storage
from nexus.services.url_normalize import normalize_url_for_display
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import build_storage_path, get_file_extension

logger = logging.getLogger(__name__)


def remote_file_kind_from_url(url: str) -> str | None:
    path = urlparse(url).path.lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith(".epub") or path.endswith(".epub.noimages") or path.endswith(".epub.images"):
        return "epub"
    return None


def create_file_media_from_remote_url(
    db: Session,
    viewer_id: UUID,
    url: str,
    kind: str,
    *,
    library_ids: list[UUID],
    request_id: str | None = None,
) -> FromUrlResponse:
    if kind not in REMOTE_FILE_CONTENT_TYPES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Remote URL must be a PDF or EPUB.")

    media_id = uuid4()
    storage_path = build_storage_path(media_id, get_file_extension(kind))
    storage_client = get_storage_client()
    fetched = fetch_to_storage(
        url=url,
        kind=kind,
        storage_path=storage_path,
        storage_client=storage_client,
    )
    validate_file_ingest_request(kind, fetched.content_type, fetched.size_bytes)

    try:
        existing = _find_existing_by_hash(db, viewer_id, kind, fetched.sha256)
        if existing is not None:
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, existing.id, library_ids
            )
            db.commit()
            _delete_remote_object(storage_client, storage_path, media_id, "duplicate_reused")
            return FromUrlResponse(
                media_id=existing.id,
                idempotency_outcome="reused",
                processing_status=_status_to_str(existing.processing_status),
                ingest_enqueued=False,
            )

        now = datetime.now(UTC)
        media = Media(
            id=media_id,
            kind=kind,
            title=_remote_file_name(url, kind)[:255],
            requested_url=url,
            canonical_source_url=normalize_url_for_display(fetched.final_url),
            file_sha256=fetched.sha256,
            processing_status=ProcessingStatus.pending,
            created_by_user_id=viewer_id,
            created_at=now,
            updated_at=now,
        )
        db.add(media)
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type=fetched.content_type,
                size_bytes=fetched.size_bytes,
            )
        )
        db.flush()
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media_id, library_ids
        )
        begin_extraction(db, media)
        _enqueue_extraction(db, media_id, kind, request_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _find_existing_by_hash(db, viewer_id, kind, fetched.sha256)
        if existing is None:
            _delete_remote_object(storage_client, storage_path, media_id, "integrity_failed")
            raise
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, existing.id, library_ids
        )
        db.commit()
        _delete_remote_object(storage_client, storage_path, media_id, "integrity_duplicate")
        return FromUrlResponse(
            media_id=existing.id,
            idempotency_outcome="reused",
            processing_status=_status_to_str(existing.processing_status),
            ingest_enqueued=False,
        )
    except Exception:
        db.rollback()
        _delete_remote_object(storage_client, storage_path, media_id, "db_failed")
        raise

    return FromUrlResponse(
        media_id=media_id,
        idempotency_outcome="created",
        processing_status=ProcessingStatus.extracting.value,
        ingest_enqueued=True,
    )


def _remote_file_name(url: str, kind: str) -> str:
    name = unquote(posixpath.basename(urlparse(url).path)).strip()
    return name or f"download.{get_file_extension(kind)}"


def _find_existing_by_hash(db: Session, user_id: UUID, kind: str, sha256: str) -> Media | None:
    return db.execute(
        select(Media).where(
            Media.created_by_user_id == user_id,
            Media.kind == kind,
            Media.file_sha256 == sha256,
        )
    ).scalar()


def _enqueue_extraction(
    db: Session,
    media_id: UUID,
    kind: str,
    request_id: str | None,
) -> None:
    try:
        if kind == "pdf":
            enqueue_job(
                db,
                kind="ingest_pdf",
                payload={
                    "media_id": str(media_id),
                    "request_id": request_id,
                    "embedding_only": False,
                },
            )
            return
        if kind == "epub":
            enqueue_job(
                db,
                kind="ingest_epub",
                payload={
                    "media_id": str(media_id),
                    "request_id": request_id,
                },
            )
            return
    except SQLAlchemyError as exc:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to enqueue extraction job.") from exc

    raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Remote URL must be a PDF or EPUB.")


def _delete_remote_object(storage_client, storage_path: str, media_id: UUID, reason: str) -> None:
    try:
        storage_client.delete_object(storage_path)
    except StorageError as exc:
        # justify-ignore-error: DB ownership has already moved to an existing media
        # row or failed before commit; the orphan object is unreachable and can be
        # removed by operational cleanup without changing caller behavior.
        logger.warning(
            "remote_file_storage_cleanup_failed media_id=%s storage_path=%s reason=%s error=%s",
            media_id,
            storage_path,
            reason,
            exc.message,
        )


def _status_to_str(value: object) -> str:
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)
