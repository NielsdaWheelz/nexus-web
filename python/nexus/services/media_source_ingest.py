"""Durable source-ingest lifecycle owner."""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import (
    Fragment,
    Media,
    MediaFile,
    MediaKind,
    MediaSourceAttempt,
    MediaSourceAttemptStatus,
    ProcessingStatus,
)
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import FromUrlResponse
from nexus.services import (
    library_entries,
    library_governance,
    web_article_indexing,
)
from nexus.services import (
    media_source_types as source_types,
)
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    build_observation,
)
from nexus.services.contributors import MediaTarget, replace_observed_role_slices
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.media_author_observation_seam import (
    attach_author_observation,
    take_author_observations,
)
from nexus.services.media_deletion import (
    delete_document_storage_objects,
    delete_duplicate_document_media,
)
from nexus.services.media_processing_state import (
    begin_extraction,
    mark_failed,
    mark_ready_for_reading,
    mark_source_queued,
    mark_stage_warning,
)
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.pdf_indexing import index_pdf_evidence
from nexus.services.pdf_ingest import PdfSourcePackageArtifact
from nexus.services.reader_apparatus import (
    attach_fragment_locators,
    replace_media_apparatus,
    source_fingerprint,
)
from nexus.services.remote_file_client import (
    REMOTE_FILE_CONTENT_TYPES,
    fetch_binary_to_storage,
    fetch_to_storage,
)
from nexus.services.remote_file_ingest import arxiv_pdf_source_from_url, remote_file_kind_from_url
from nexus.services.source_attempt_artifacts import (
    clone_source_payload_for_new_attempt,
    source_attempt_storage_paths,
)
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_ingest import materialize_web_article_source
from nexus.services.web_article_structure import (
    WEB_ARTICLE_HTML_MAX_BYTES,
    prepare_web_article_fragment,
)
from nexus.services.x_identity import classify_x_url, is_x_url
from nexus.services.youtube_identity import classify_youtube_url, is_youtube_url
from nexus.services.youtube_video_ingest import run_youtube_video_ingest
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.paths import (
    build_source_artifact_storage_path,
    build_storage_path,
    build_upload_staging_storage_path,
    get_file_extension,
)
from nexus.tasks.storage_object_cleanup import (
    finalize_storage_object_write,
    reserve_storage_object_write,
)

logger = get_logger(__name__)

_ATTEMPT_ACCEPTED = MediaSourceAttemptStatus.accepted.value
_ATTEMPT_QUEUED = MediaSourceAttemptStatus.queued.value
_ATTEMPT_RUNNING = MediaSourceAttemptStatus.running.value
_ATTEMPT_SUCCEEDED = MediaSourceAttemptStatus.succeeded.value
_ATTEMPT_FAILED = MediaSourceAttemptStatus.failed.value
_IN_FLIGHT_ATTEMPT_STATUSES = {
    _ATTEMPT_ACCEPTED,
    _ATTEMPT_QUEUED,
    _ATTEMPT_RUNNING,
}
_REFRESHABLE_STATUSES = {
    ProcessingStatus.ready_for_reading,
    ProcessingStatus.failed,
}
_NON_REACQUIRABLE_FILE_ERROR_CODES = {
    ApiErrorCode.E_SIGN_UPLOAD_FAILED.value,
    ApiErrorCode.E_STORAGE_MISSING.value,
    ApiErrorCode.E_STORAGE_ERROR.value,
    ApiErrorCode.E_INVALID_FILE_TYPE.value,
}
_TERMINAL_SOURCE_ERROR_CODES = {
    ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
    ApiErrorCode.E_ARCHIVE_UNSAFE.value,
}


@dataclass(frozen=True)
class SystemSourceRepairResult:
    media_id: UUID
    source_attempt_id: UUID | None
    action: str
    ingest_enqueued: bool
    processing_status: str


@dataclass(frozen=True)
class EmbeddedSourceAcceptance:
    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    source_attempt_status: str
    processing_status: str
    needs_enqueue: bool


def accept_url_source(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> FromUrlResponse:
    """Accept a URL source intent before any provider/network/storage work runs."""
    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)
    return _accept_url_source(
        db=db,
        viewer_id=viewer_id,
        url=url,
        library_ids=library_ids,
        request_id=request_id,
        idempotency_key=idempotency_key,
        assign_viewer_libraries=True,
    )


def accept_system_url_source(
    *,
    db: Session,
    actor_user_id: UUID,
    url: str,
    expected_kind: str,
    system_source: str,
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> FromUrlResponse:
    """Accept a system-owned URL source without attaching it to the actor's libraries.

    This is the durable source-ingest boundary for maintenance-owned media such as the
    Oracle Corpus. It creates the same media/source-attempt/job records as
    ``accept_url_source`` but intentionally skips default-library intrinsic membership;
    the owning system service must attach the media through its explicit library-entry
    command after acceptance.
    """
    return _accept_url_source(
        db=db,
        viewer_id=actor_user_id,
        url=url,
        library_ids=[],
        request_id=request_id,
        idempotency_key=idempotency_key,
        assign_viewer_libraries=False,
        expected_kind=expected_kind,
        source_payload_extra={"system_source": system_source},
    )


def _accept_url_source(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None,
    idempotency_key: str | None,
    assign_viewer_libraries: bool,
    expected_kind: str | None = None,
    source_payload_extra: dict[str, object] | None = None,
) -> FromUrlResponse:
    validate_requested_url(url)

    spec = _url_source_spec(url)
    if expected_kind is not None and str(spec["kind"]) != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            f"URL source produced {spec['kind']!r}; expected {expected_kind!r}.",
        )
    intent_key = build_intent_key(
        spec["source_type"],
        url,
        spec["provider_target_ref"],
        library_ids=library_ids if assign_viewer_libraries else None,
    )
    clean_idempotency_key = _clean_idempotency_key(idempotency_key)
    if clean_idempotency_key is not None:
        _lock_idempotency_key(db, viewer_id, clean_idempotency_key)
        existing_attempt = _find_idempotent_attempt(db, viewer_id, clean_idempotency_key)
        if existing_attempt is not None:
            if existing_attempt.intent_key != intent_key:
                raise ConflictError(
                    ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
                    "Idempotency key was reused for a different source ingest request.",
                )
            media = db.get(Media, existing_attempt.media_id)
            if media is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return FromUrlResponse(
                media_id=media.id,
                source_attempt_id=existing_attempt.id,
                source_type=existing_attempt.source_type,
                source_attempt_status=existing_attempt.status,
                idempotency_outcome="reused",
                processing_status=_status_to_str(media.processing_status),
                ingest_enqueued=existing_attempt.status in {_ATTEMPT_ACCEPTED, _ATTEMPT_QUEUED},
            )

    now = datetime.now(UTC)
    media = _find_reusable_url_media(db, viewer_id, spec)
    created = media is None
    if media is None:
        media = Media(
            kind=str(spec["kind"]),
            title=str(spec["title"])[:255],
            requested_url=url,
            canonical_url=spec["canonical_url"],
            canonical_source_url=spec["canonical_source_url"],
            external_playback_url=spec["external_playback_url"],
            provider=spec["provider"],
            provider_id=spec["provider_id"],
            processing_status=ProcessingStatus.pending,
            created_by_user_id=viewer_id,
            created_at=now,
            updated_at=now,
        )
        db.add(media)
        db.flush()

    if assign_viewer_libraries:
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, library_ids
        )
    attempt_status = _ATTEMPT_ACCEPTED if created else _reused_url_attempt_status(media)
    source_payload: dict[str, object] = {
        "url": url,
        "kind": spec["kind"],
        **dict(spec["source_payload"]),
    }
    if assign_viewer_libraries:
        source_payload["library_ids"] = [str(library_id) for library_id in library_ids]
    if source_payload_extra:
        source_payload.update(source_payload_extra)
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=str(spec["source_type"]),
        intent_key=intent_key,
        requested_url=url,
        canonical_source_url=spec["canonical_source_url"],
        provider=spec["provider"],
        provider_target_ref=spec["provider_target_ref"],
        source_payload=source_payload,
        request_id=request_id,
        idempotency_key=clean_idempotency_key,
        status=attempt_status,
    )
    if not created and attempt.status in {_ATTEMPT_FAILED, _ATTEMPT_SUCCEEDED}:
        attempt.finished_at = func.now()
        if attempt.status == _ATTEMPT_FAILED:
            attempt.error_code = media.last_error_code
            attempt.error_message = media.last_error_message

    db.commit()
    ingest_enqueued = False
    if created:
        ingest_enqueued = _enqueue_accepted_attempt(
            db,
            media_id=media.id,
            attempt_id=attempt.id,
            actor_user_id=viewer_id,
            request_id=request_id,
            failure_stage="extract",
        )
        media = db.get(Media, media.id) or media
        attempt = db.get(MediaSourceAttempt, attempt.id) or attempt

    return FromUrlResponse(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        source_attempt_status=attempt.status,
        idempotency_outcome="created" if created else "reused",
        processing_status=_status_to_str(media.processing_status),
        ingest_enqueued=ingest_enqueued,
    )


def accept_browser_article_capture(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    content_html: str,
    source_html: str,
    library_ids: list[UUID],
    title: str | None = None,
    byline: str | None = None,
    excerpt: str | None = None,
    site_name: str | None = None,
    published_time: str | None = None,
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> FromUrlResponse:
    """Accept a browser-rendered article capture before parsing or indexing."""
    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)
    validate_requested_url(url)
    html_bytes = content_html.encode("utf-8")
    source_html_bytes = source_html.encode("utf-8")
    if len(html_bytes) > WEB_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_CAPTURE_TOO_LARGE,
            "Captured article HTML is too large",
        )
    if len(source_html_bytes) > WEB_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(
            ApiErrorCode.E_CAPTURE_TOO_LARGE,
            "Captured article source HTML is too large",
        )

    source_type = source_types.BROWSER_ARTICLE_CAPTURE
    intent_key = build_intent_key(
        source_type,
        url,
        {"content_size_bytes": len(html_bytes), "source_size_bytes": len(source_html_bytes)},
        library_ids=library_ids,
    )
    clean_idempotency_key = _clean_idempotency_key(idempotency_key)
    if clean_idempotency_key is not None:
        _lock_idempotency_key(db, viewer_id, clean_idempotency_key)
        existing = _find_idempotent_attempt(db, viewer_id, clean_idempotency_key)
        if existing is not None:
            if existing.intent_key != intent_key:
                raise ConflictError(
                    ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
                    "Idempotency key was reused for a different source ingest request.",
                )
            media = db.get(Media, existing.media_id)
            if media is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return FromUrlResponse(
                media_id=media.id,
                source_attempt_id=existing.id,
                source_type=existing.source_type,
                source_attempt_status=existing.status,
                idempotency_outcome="reused",
                processing_status=_status_to_str(media.processing_status),
                ingest_enqueued=existing.status in {_ATTEMPT_ACCEPTED, _ATTEMPT_QUEUED},
            )

    now = datetime.now(UTC)
    media = Media(
        kind=MediaKind.web_article.value,
        title=(title or url).strip()[:255] or "Untitled",
        requested_url=url,
        canonical_url=None,
        canonical_source_url=normalize_url_for_display(url),
        provider="browser_capture",
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        description=excerpt.strip()[:2000] if excerpt and excerpt.strip() else None,
        publisher=site_name.strip()[:255] if site_name and site_name.strip() else None,
        published_date=published_time.strip()[:64]
        if published_time and published_time.strip()
        else None,
    )
    storage_client = get_storage_client()
    db.add(media)
    db.flush()
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=source_type,
        intent_key=intent_key,
        requested_url=url,
        canonical_source_url=media.canonical_source_url,
        provider=media.provider,
        provider_target_ref=None,
        source_payload={
            "url": url,
            "title": title,
            "byline": byline,
            "excerpt": excerpt,
            "site_name": site_name,
            "published_time": published_time,
            "library_ids": [str(library_id) for library_id in library_ids],
        },
        request_id=request_id,
        idempotency_key=clean_idempotency_key,
        status=_ATTEMPT_ACCEPTED,
    )
    storage_path = build_source_artifact_storage_path(media.id, attempt.id, "html")
    source_storage_path = build_source_artifact_storage_path(media.id, attempt.id, "source-html")
    attempt.source_payload = {
        **dict(attempt.source_payload or {}),
        "storage_path": storage_path,
        "source_storage_path": source_storage_path,
        "content_type": "text/html; charset=utf-8",
        "size_bytes": len(html_bytes),
        "source_size_bytes": len(source_html_bytes),
    }
    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media.id, library_ids
    )
    db.commit()

    # Reserve durable final-sweeps before the bounded writes (spec §3.1).
    reserve_storage_object_write(db, media_id=media.id, storage_path=storage_path)
    reserve_storage_object_write(db, media_id=media.id, storage_path=source_storage_path)
    try:
        storage_client.put_object(storage_path, html_bytes, "text/html; charset=utf-8")
        storage_client.put_object(
            source_storage_path, source_html_bytes, "text/html; charset=utf-8"
        )
        finalize_storage_object_write(
            db, media_id=media.id, storage_path=storage_path, storage_client=storage_client
        )
        finalize_storage_object_write(
            db,
            media_id=media.id,
            storage_path=source_storage_path,
            storage_client=storage_client,
        )
    except Exception as exc:
        _fail_source_attempt_and_media(
            db,
            media_id=media.id,
            attempt_id=attempt.id,
            exc=exc,
            stage="upload",
        )
        media = db.get(Media, media.id) or media
        attempt = db.get(MediaSourceAttempt, attempt.id) or attempt
        return FromUrlResponse(
            media_id=media.id,
            source_attempt_id=attempt.id,
            source_type=attempt.source_type,
            source_attempt_status=attempt.status,
            idempotency_outcome="created",
            processing_status=_status_to_str(media.processing_status),
            ingest_enqueued=False,
        )

    ingest_enqueued = _enqueue_accepted_attempt(
        db,
        media_id=media.id,
        attempt_id=attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage="extract",
    )
    media = db.get(Media, media.id) or media
    attempt = db.get(MediaSourceAttempt, attempt.id) or attempt

    return FromUrlResponse(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        source_attempt_status=attempt.status,
        idempotency_outcome="created",
        processing_status=_status_to_str(media.processing_status),
        ingest_enqueued=ingest_enqueued,
    )


def accept_embedded_source(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    parent_media_id: UUID,
    document_embed_key: str,
    library_ids: list[UUID],
    request_id: str | None = None,
) -> EmbeddedSourceAcceptance:
    """Create or reuse a child source for a trusted document embed. Flush-only."""
    validate_requested_url(url)
    spec = _url_source_spec(url)
    if spec["source_type"] == source_types.X_AUTHOR_THREAD:
        post_id = str(spec["provider_target_ref"] or "")
        spec = {
            **spec,
            "source_type": source_types.X_POST,
            "provider_id": f"post:{post_id}",
            "source_payload": {"post_id": post_id},
        }
    if spec["source_type"] not in {source_types.YOUTUBE_VIDEO, source_types.X_POST}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsupported embedded source provider.",
        )

    now = datetime.now(UTC)
    media = _find_reusable_url_media(db, viewer_id, spec)
    created = media is None
    if media is None:
        media = Media(
            kind=str(spec["kind"]),
            title=str(spec["title"])[:255],
            requested_url=url,
            canonical_url=spec["canonical_url"],
            canonical_source_url=spec["canonical_source_url"],
            external_playback_url=spec["external_playback_url"],
            provider=spec["provider"],
            provider_id=spec["provider_id"],
            processing_status=ProcessingStatus.pending,
            created_by_user_id=viewer_id,
            created_at=now,
            updated_at=now,
        )
        db.add(media)
        db.flush()

    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media.id, library_ids
    )
    status = _ATTEMPT_ACCEPTED if created else _reused_url_attempt_status(media)
    source_payload = {
        "url": url,
        "kind": spec["kind"],
        "parent_media_id": str(parent_media_id),
        "document_embed_key": document_embed_key,
        **dict(spec["source_payload"]),
        "library_ids": [str(library_id) for library_id in library_ids],
    }
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=str(spec["source_type"]),
        intent_key=build_intent_key(
            spec["source_type"],
            url,
            spec["provider_target_ref"],
            library_ids=library_ids,
        ),
        requested_url=url,
        canonical_source_url=spec["canonical_source_url"],
        provider=spec["provider"],
        provider_target_ref=spec["provider_target_ref"],
        source_payload=source_payload,
        request_id=request_id,
        idempotency_key=None,
        status=status,
    )
    if not created and attempt.status in {_ATTEMPT_FAILED, _ATTEMPT_SUCCEEDED}:
        attempt.finished_at = func.now()
        if attempt.status == _ATTEMPT_FAILED:
            attempt.error_code = media.last_error_code
            attempt.error_message = media.last_error_message
    return EmbeddedSourceAcceptance(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        source_attempt_status=attempt.status,
        processing_status=_status_to_str(media.processing_status),
        needs_enqueue=created,
    )


def enqueue_accepted_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> bool:
    enqueued = _enqueue_accepted_attempt(
        db,
        media_id=media_id,
        attempt_id=attempt_id,
        actor_user_id=actor_user_id,
        request_id=request_id,
        failure_stage="extract",
    )
    _sync_document_embed_targets(db, media_id)
    return enqueued


def accept_browser_file_capture(
    *,
    db: Session,
    viewer_id: UUID,
    payload: bytes,
    filename: str,
    content_type: str,
    library_ids: list[UUID],
    source_url: str | None = None,
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> FromUrlResponse:
    """Accept a browser-fetched PDF/EPUB through the shared source lifecycle."""
    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)

    cleaned_filename = (filename or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    lower_filename = cleaned_filename.lower()
    if normalized_content_type == "application/pdf":
        kind = MediaKind.pdf.value
    elif normalized_content_type == "application/epub+zip":
        kind = MediaKind.epub.value
    elif lower_filename.endswith(".pdf"):
        kind = MediaKind.pdf.value
        normalized_content_type = "application/pdf"
    elif lower_filename.endswith(".epub"):
        kind = MediaKind.epub.value
        normalized_content_type = "application/epub+zip"
    else:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_CONTENT_TYPE,
            "Captured files must be PDF or EPUB.",
        )

    if not payload:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Captured file is empty.")
    validate_file_ingest_request(kind, normalized_content_type, len(payload))

    clean_source_url = source_url.strip() if source_url and source_url.strip() else None
    if clean_source_url is not None:
        validate_requested_url(clean_source_url)

    source_type = f"browser_{kind}_capture"
    intent_key = build_intent_key(
        source_type,
        clean_source_url or cleaned_filename,
        len(payload),
        library_ids=library_ids,
    )
    clean_idempotency_key = _clean_idempotency_key(idempotency_key)
    if clean_idempotency_key is not None:
        _lock_idempotency_key(db, viewer_id, clean_idempotency_key)
        existing_attempt = _find_idempotent_attempt(db, viewer_id, clean_idempotency_key)
        if existing_attempt is not None:
            if existing_attempt.intent_key != intent_key:
                raise ConflictError(
                    ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
                    "Idempotency key was reused for a different source ingest request.",
                )
            media = db.get(Media, existing_attempt.media_id)
            if media is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return FromUrlResponse(
                media_id=media.id,
                source_attempt_id=existing_attempt.id,
                source_type=existing_attempt.source_type,
                source_attempt_status=existing_attempt.status,
                idempotency_outcome="reused",
                processing_status=_status_to_str(media.processing_status),
                ingest_enqueued=existing_attempt.status in {_ATTEMPT_ACCEPTED, _ATTEMPT_QUEUED},
            )

    title = cleaned_filename
    if not title and clean_source_url is not None:
        title = unquote(posixpath.basename(urlparse(clean_source_url).path)).strip()
    if not title:
        title = f"capture.{get_file_extension(kind)}"

    now = datetime.now(UTC)
    media = Media(
        kind=kind,
        title=title[:255],
        requested_url=clean_source_url,
        canonical_source_url=(
            normalize_url_for_display(clean_source_url) if clean_source_url is not None else None
        ),
        provider="browser_capture",
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)
    db.flush()
    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media.id, library_ids
    )
    valid_signature = has_valid_file_signature(payload, kind)
    storage_path = (
        build_storage_path(media.id, get_file_extension(kind)) if valid_signature else None
    )
    if valid_signature:
        db.add(
            MediaFile(
                media_id=media.id,
                storage_path=storage_path,
                content_type=normalized_content_type,
                size_bytes=len(payload),
            )
        )
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=source_type,
        intent_key=intent_key,
        requested_url=clean_source_url,
        canonical_source_url=media.canonical_source_url,
        provider=media.provider,
        provider_target_ref=None,
        source_payload={
            "filename": cleaned_filename,
            "content_type": normalized_content_type,
            "size_bytes": len(payload),
            "source_url": clean_source_url,
            "storage_path": storage_path,
            "library_ids": [str(library_id) for library_id in library_ids],
        },
        request_id=request_id,
        idempotency_key=clean_idempotency_key,
        status=_ATTEMPT_ACCEPTED,
    )
    if not valid_signature:
        _fail_source_attempt_and_media(
            db,
            media_id=media.id,
            attempt_id=attempt.id,
            exc=InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE,
                f"Captured file is not a valid {kind.upper()}.",
            ),
            stage="upload",
        )
        media = db.get(Media, media.id) or media
        attempt = db.get(MediaSourceAttempt, attempt.id) or attempt
        return FromUrlResponse(
            media_id=media.id,
            source_attempt_id=attempt.id,
            source_type=attempt.source_type,
            source_attempt_status=attempt.status,
            idempotency_outcome="created",
            processing_status=_status_to_str(media.processing_status),
            ingest_enqueued=False,
        )
    db.commit()

    storage_client = get_storage_client()
    try:
        if storage_path is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Missing browser file storage path.")
        # Reserve the durable final-sweep before the bounded write (spec §3.1).
        reserve_storage_object_write(db, media_id=media.id, storage_path=storage_path)
        storage_client.put_object(storage_path, payload, normalized_content_type)
        finalize_storage_object_write(
            db, media_id=media.id, storage_path=storage_path, storage_client=storage_client
        )
    except Exception as exc:
        _fail_source_attempt_and_media(
            db,
            media_id=media.id,
            attempt_id=attempt.id,
            exc=exc,
            stage="upload",
        )
        media = db.get(Media, media.id) or media
        attempt = db.get(MediaSourceAttempt, attempt.id) or attempt
        return FromUrlResponse(
            media_id=media.id,
            source_attempt_id=attempt.id,
            source_type=attempt.source_type,
            source_attempt_status=attempt.status,
            idempotency_outcome="created",
            processing_status=_status_to_str(media.processing_status),
            ingest_enqueued=False,
        )

    ingest_enqueued = _enqueue_accepted_attempt(
        db,
        media_id=media.id,
        attempt_id=attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage="extract",
    )
    media = db.get(Media, media.id) or media
    attempt = db.get(MediaSourceAttempt, attempt.id) or attempt

    return FromUrlResponse(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        source_attempt_status=attempt.status,
        idempotency_outcome="created",
        processing_status=_status_to_str(media.processing_status),
        ingest_enqueued=ingest_enqueued,
    )


def accept_uploaded_file_source(
    *,
    db: Session,
    viewer_id: UUID,
    kind: str,
    filename: str,
    content_type: str,
    size_bytes: int,
    library_ids: list[UUID],
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> dict[str, object]:
    """Accept an uploaded PDF/EPUB source and return a signed upload URL."""
    settings = get_settings()
    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)
    validate_file_ingest_request(kind, content_type, size_bytes)

    source_type = f"uploaded_{kind}_file"
    intent_key = _upload_intent_key(
        source_type=source_type,
        filename=filename,
        content_type=content_type,
        size_bytes=size_bytes,
        library_ids=library_ids,
    )
    clean_idempotency_key = _clean_idempotency_key(idempotency_key)
    if clean_idempotency_key is not None:
        _lock_idempotency_key(db, viewer_id, clean_idempotency_key)
        existing_attempt = _find_idempotent_attempt(db, viewer_id, clean_idempotency_key)
        if existing_attempt is not None:
            if existing_attempt.intent_key != intent_key:
                raise ConflictError(
                    ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
                    "Idempotency key was reused for a different source ingest request.",
                )
            media = db.get(Media, existing_attempt.media_id)
            if media is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return _upload_init_response(
                db=db,
                media=media,
                attempt=existing_attempt,
                content_type=content_type,
                size_bytes=size_bytes,
                expires_in_seconds=settings.signed_url_expiry_s,
                idempotency_outcome="reused",
            )

    ext = get_file_extension(kind)
    media_id = uuid4()
    storage_path = build_upload_staging_storage_path(media_id, ext)
    now = datetime.now(UTC)
    media = Media(
        id=media_id,
        kind=kind,
        title=filename,
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
            content_type=content_type,
            size_bytes=size_bytes,
        )
    )
    db.flush()
    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media_id, library_ids
    )
    attempt = record_upload_source_intent(
        db=db,
        media=media,
        viewer_id=viewer_id,
        filename=filename,
        content_type=content_type,
        size_bytes=size_bytes,
        request_id=request_id,
        idempotency_key=clean_idempotency_key,
        intent_key=intent_key,
        library_ids=library_ids,
    )
    db.commit()

    return _upload_init_response(
        db=db,
        media=media,
        attempt=attempt,
        content_type=content_type,
        size_bytes=size_bytes,
        expires_in_seconds=settings.signed_url_expiry_s,
        idempotency_outcome="created",
    )


def run_source_attempt(
    *,
    db: Session,
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    """Run one queued source attempt and persist the terminal attempt state."""
    attempt = (
        db.execute(
            select(MediaSourceAttempt).where(MediaSourceAttempt.id == attempt_id).with_for_update()
        )
        .scalars()
        .one_or_none()
    )
    if attempt is None:
        return {"status": "skipped", "reason": "attempt_not_found"}
    if attempt.media_id != media_id:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Source attempt media mismatch.")
    if attempt.status == _ATTEMPT_SUCCEEDED:
        return {"status": "skipped", "reason": "already_succeeded"}
    if attempt.status not in {_ATTEMPT_ACCEPTED, _ATTEMPT_QUEUED, _ATTEMPT_RUNNING}:
        return {"status": "skipped", "reason": f"attempt_{attempt.status}"}

    attempt.status = _ATTEMPT_RUNNING
    attempt.run_count = int(attempt.run_count or 0) + 1
    attempt.started_at = func.now()
    attempt.updated_at = func.now()
    db.commit()

    superseded_storage_paths: list[str] = []
    try:
        if attempt.source_type == source_types.GENERIC_WEB_URL:
            result = _run_generic_web_article(db, media_id, attempt, actor_user_id, request_id)
        elif attempt.source_type in {
            source_types.YOUTUBE_VIDEO,
            source_types.VIDEO_TRANSCRIPT,
        }:
            result = _run_youtube_video(db, media_id, attempt, actor_user_id, request_id)
        elif attempt.source_type == source_types.X_AUTHOR_THREAD:
            result = _run_x_author_thread(db, media_id, attempt, actor_user_id, request_id)
        elif attempt.source_type == source_types.X_POST:
            result = _run_x_post(db, media_id, attempt, actor_user_id, request_id)
        elif attempt.source_type in source_types.REMOTE_FILE_SOURCE_TYPES:
            result = _run_remote_file(db, media_id, attempt, request_id)
        elif attempt.source_type == source_types.BROWSER_ARTICLE_CAPTURE:
            result = _run_browser_article_capture(db, media_id, attempt, request_id)
        elif attempt.source_type == source_types.EMAIL_MESSAGE:
            result = _run_email_message(db, media_id, attempt, request_id)
        elif attempt.source_type in source_types.LOCAL_FILE_SOURCE_TYPES:
            result = _run_existing_file(db, media_id, request_id)
        elif attempt.source_type == source_types.PODCAST_EPISODE_TRANSCRIPT:
            result = _run_podcast_episode_transcript(
                db, media_id, attempt, actor_user_id, request_id
            )
        else:
            raise ApiError(
                ApiErrorCode.E_INVALID_KIND,
                f"Unsupported source attempt type: {attempt.source_type}",
            )
        result_media_id = _result_media_id(result)
        terminal_media_id = media_id
        if result_media_id is not None and result_media_id != media_id:
            superseded_storage_paths = _supersede_source_media(
                db,
                loser_media_id=media_id,
                winner_media_id=result_media_id,
                attempt_id=attempt_id,
            )
            terminal_media_id = result_media_id
    except Exception as exc:
        db.rollback()
        _finish_failed_attempt(db, attempt_id, media_id, exc)
        _sync_document_embed_targets(db, media_id)
        error_code, error_message = _source_error_fields(exc)
        return {
            "status": "failed",
            "error_code": error_code,
            "error_message": error_message,
        }

    # Drain the author observations the handler attached before touching the
    # result again: they hold credited names and must never reach the logged /
    # returned job result (D-43).
    observations = take_author_observations(result)

    db.expire_all()
    media = db.get(Media, terminal_media_id)
    attempt = db.get(MediaSourceAttempt, attempt_id)
    if attempt is None:
        return {"status": "success", "reason": "attempt_deleted_after_dedupe"}

    if media is None or media.processing_status != ProcessingStatus.failed:
        # Commit the source work WITHOUT crossing ready, then apply each author
        # observation through the facade in a fresh session (spec 2.4). A failure
        # here fails the attempt + media and the user-facing source refresh
        # retries; a crash instead leaves the attempt running and the job's
        # lease-expiry retry re-runs the source work (AC 9). Either path rebuilds
        # the observations, and the resolver's deterministic convergence +
        # no-DML-when-unchanged make re-application safe; ready is only crossed
        # after every author op commits.
        db.commit()
        try:
            for observed_media_id, observation, source in observations:
                replace_observed_role_slices(
                    target=MediaTarget(observed_media_id or terminal_media_id),
                    observation=observation,
                    source=source,
                )
        except Exception as exc:
            db.rollback()
            _finish_failed_attempt(db, attempt_id, terminal_media_id, exc)
            _sync_document_embed_targets(db, terminal_media_id)
            error_code, error_message = _source_error_fields(exc)
            return {
                "status": "failed",
                "error_code": error_code,
                "error_message": error_message,
            }
        # The author op committed on its own fresh session; refresh the media
        # state before crossing ready. ``attempt`` (already validated non-None
        # above) is untouched by the author op — reload it lazily on write.
        db.expire_all()
        media = db.get(Media, terminal_media_id)

    if media is not None and media.processing_status == ProcessingStatus.failed:
        attempt.status = _ATTEMPT_FAILED
        attempt.error_code = media.last_error_code
        attempt.error_message = media.last_error_message
        attempt.retry_after_seconds = None
    else:
        if media is not None and media.processing_status == ProcessingStatus.extracting:
            mark_ready_for_reading(db, media)
        attempt.status = _ATTEMPT_SUCCEEDED
        attempt.error_code = None
        attempt.error_message = None
        attempt.retry_after_seconds = None
    attempt.finished_at = func.now()
    attempt.updated_at = func.now()
    db.commit()
    _sync_document_embed_targets(db, terminal_media_id)
    _run_post_success_source_actions(
        db,
        media_id=terminal_media_id,
        result=result,
        request_id=request_id,
    )
    delete_document_storage_objects(superseded_storage_paths)
    return result


def retry_source_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    request_id: str | None,
    idempotency_key: str | None = None,
) -> dict[str, object]:
    """Retry failed source acquisition through the durable attempt owner."""
    media = _load_owned_media_for_source_action(db, viewer_id, media_id)
    clean_idempotency_key = _clean_idempotency_key(idempotency_key)
    if clean_idempotency_key is not None:
        _lock_idempotency_key(db, viewer_id, clean_idempotency_key)
        existing_attempt = _find_idempotent_source_action_attempt(
            db,
            viewer_id=viewer_id,
            idempotency_key=clean_idempotency_key,
            media_id=media.id,
            action="retry",
        )
        if existing_attempt is not None:
            return _source_action_attempt_response(
                db,
                viewer_id=viewer_id,
                media=media,
                attempt=existing_attempt,
                idempotency_outcome="reused",
            )
    attempt = _latest_source_attempt(db, media.id)
    if (
        media.processing_status == ProcessingStatus.extracting
        and attempt is not None
        and attempt.status in _IN_FLIGHT_ATTEMPT_STATUSES
    ):
        return _source_action_response_with_capabilities(
            db,
            viewer_id=viewer_id,
            media_id=media.id,
            payload={
                "media_id": str(media.id),
                "source_attempt_id": str(attempt.id),
                "source_type": attempt.source_type,
                "source_attempt_status": attempt.status,
                "idempotency_outcome": "retrying",
                "processing_status": _status_to_str(media.processing_status),
                "ingest_enqueued": False,
            },
        )
    if media.processing_status != ProcessingStatus.failed:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be in failed state to retry.",
        )
    if attempt is None:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source retry is not available for media without a source attempt.",
        )
    if attempt.status != _ATTEMPT_FAILED:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Latest source attempt is not retryable.",
        )
    _raise_if_source_action_not_reacquirable(media, attempt)
    retry_attempt = _clone_attempt_for_media(
        db,
        media=media,
        viewer_id=viewer_id,
        previous=attempt,
        request_id=request_id,
        intent_key=_source_action_intent_key(
            "retry", media_id=media.id, previous_attempt_id=attempt.id
        ),
        idempotency_key=clean_idempotency_key,
    )
    _mark_source_requeue_payload(retry_attempt)
    db.commit()
    ingest_enqueued = _dispatch_requeue_attempt(
        db,
        media_id=media.id,
        attempt_id=retry_attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage=_source_attempt_failure_stage(retry_attempt),
    )
    media = db.get(Media, media.id) or media
    retry_attempt = db.get(MediaSourceAttempt, retry_attempt.id) or retry_attempt
    return _source_action_response_with_capabilities(
        db,
        viewer_id=viewer_id,
        media_id=media.id,
        payload={
            "media_id": str(media.id),
            "source_attempt_id": str(retry_attempt.id),
            "source_type": retry_attempt.source_type,
            "source_attempt_status": retry_attempt.status,
            "idempotency_outcome": "retrying",
            "processing_status": _status_to_str(media.processing_status),
            "ingest_enqueued": ingest_enqueued,
        },
    )


def refresh_source_for_viewer(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    request_id: str | None,
    idempotency_key: str | None = None,
) -> dict[str, object]:
    """Refresh source-backed media through the durable attempt owner."""
    media = _load_owned_media_for_source_action(db, viewer_id, media_id)
    clean_idempotency_key = _clean_idempotency_key(idempotency_key)
    if clean_idempotency_key is not None:
        _lock_idempotency_key(db, viewer_id, clean_idempotency_key)
        existing_attempt = _find_idempotent_source_action_attempt(
            db,
            viewer_id=viewer_id,
            idempotency_key=clean_idempotency_key,
            media_id=media.id,
            action="refresh",
        )
        if existing_attempt is not None:
            return _source_action_attempt_response(
                db,
                viewer_id=viewer_id,
                media=media,
                attempt=existing_attempt,
                idempotency_outcome="reused",
            )
    if media.processing_status not in _REFRESHABLE_STATUSES:
        raise ConflictError(
            ApiErrorCode.E_MEDIA_NOT_READY,
            "Media source refresh is not available in the current processing state.",
        )
    attempt = _latest_source_attempt(db, media.id)
    if attempt is None:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source refresh is not available for media without a source attempt.",
        )
    if attempt.status in _IN_FLIGHT_ATTEMPT_STATUSES:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Source ingest is already queued or running.",
        )
    _raise_if_source_action_not_reacquirable(media, attempt)
    refresh_attempt = _clone_attempt_for_media(
        db,
        media=media,
        viewer_id=viewer_id,
        previous=attempt,
        request_id=request_id,
        intent_key=_source_action_intent_key(
            "refresh", media_id=media.id, previous_attempt_id=attempt.id
        ),
        idempotency_key=clean_idempotency_key,
    )
    _mark_source_requeue_payload(refresh_attempt)
    db.commit()
    ingest_enqueued = _dispatch_requeue_attempt(
        db,
        media_id=media.id,
        attempt_id=refresh_attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage=_source_attempt_failure_stage(refresh_attempt),
    )
    media = db.get(Media, media.id) or media
    refresh_attempt = db.get(MediaSourceAttempt, refresh_attempt.id) or refresh_attempt
    return _source_action_response_with_capabilities(
        db,
        viewer_id=viewer_id,
        media_id=media.id,
        payload={
            "media_id": str(media.id),
            "source_attempt_id": str(refresh_attempt.id),
            "source_type": refresh_attempt.source_type,
            "source_attempt_status": refresh_attempt.status,
            "idempotency_outcome": "refreshed",
            "processing_status": _status_to_str(media.processing_status),
            "ingest_enqueued": ingest_enqueued,
        },
    )


def repair_source_for_system_media(
    *,
    db: Session,
    actor_user_id: UUID,
    media_id: UUID,
    request_id: str | None,
    reason: str,
) -> SystemSourceRepairResult:
    """Repair source-backed system media through the durable attempt owner.

    System libraries such as the Oracle Corpus do not have an interactive viewer
    request, but they must still use the same retry/refresh substrate as user media:
    clone attempts for audit, enforce reacquirability, clear stale artifacts, and
    enqueue ``ingest_media_source`` through the canonical job owner.
    """
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != actor_user_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the source owner can repair system media.",
        )
    attempt = _latest_source_attempt(db, media.id)
    if attempt is None:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source repair is not available for media without a source attempt.",
        )

    if attempt.status in {_ATTEMPT_QUEUED, _ATTEMPT_RUNNING}:
        return SystemSourceRepairResult(
            media_id=media.id,
            source_attempt_id=attempt.id,
            action="already_in_flight",
            ingest_enqueued=False,
            processing_status=_status_to_str(media.processing_status),
        )

    if attempt.status == _ATTEMPT_ACCEPTED:
        ingest_enqueued = _dispatch_requeue_attempt(
            db,
            media_id=media.id,
            attempt_id=attempt.id,
            actor_user_id=actor_user_id,
            request_id=request_id,
            failure_stage=_source_attempt_failure_stage(attempt),
        )
        media = db.get(Media, media.id) or media
        attempt = db.get(MediaSourceAttempt, attempt.id) or attempt
        return SystemSourceRepairResult(
            media_id=media.id,
            source_attempt_id=attempt.id,
            action="queued",
            ingest_enqueued=ingest_enqueued,
            processing_status=_status_to_str(media.processing_status),
        )

    if media.processing_status != ProcessingStatus.failed and attempt.status != _ATTEMPT_FAILED:
        return SystemSourceRepairResult(
            media_id=media.id,
            source_attempt_id=attempt.id,
            action="not_needed",
            ingest_enqueued=False,
            processing_status=_status_to_str(media.processing_status),
        )

    if attempt.status != _ATTEMPT_FAILED:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Latest source attempt is not repairable.",
        )

    _raise_if_source_action_not_reacquirable(media, attempt)
    repair_attempt = _clone_attempt_for_media(
        db,
        media=media,
        viewer_id=actor_user_id,
        previous=attempt,
        request_id=request_id,
        intent_key=_source_action_intent_key(
            "system_repair", media_id=media.id, previous_attempt_id=attempt.id
        ),
        idempotency_key=None,
    )
    payload = dict(repair_attempt.source_payload or {})
    payload["system_repair_reason"] = reason
    repair_attempt.source_payload = payload
    _mark_source_requeue_payload(repair_attempt)
    db.commit()
    ingest_enqueued = _dispatch_requeue_attempt(
        db,
        media_id=media.id,
        attempt_id=repair_attempt.id,
        actor_user_id=actor_user_id,
        request_id=request_id,
        failure_stage=_source_attempt_failure_stage(repair_attempt),
    )
    media = db.get(Media, media.id) or media
    repair_attempt = db.get(MediaSourceAttempt, repair_attempt.id) or repair_attempt
    return SystemSourceRepairResult(
        media_id=media.id,
        source_attempt_id=repair_attempt.id,
        action="repair_queued",
        ingest_enqueued=ingest_enqueued,
        processing_status=_status_to_str(media.processing_status),
    )


def record_upload_source_intent(
    *,
    db: Session,
    media: Media,
    viewer_id: UUID,
    filename: str,
    content_type: str,
    size_bytes: int,
    request_id: str | None = None,
    idempotency_key: str | None = None,
    intent_key: str | None = None,
    library_ids: list[UUID] | None = None,
) -> MediaSourceAttempt:
    """Record the durable source intent created by upload init."""
    source_type = f"uploaded_{media.kind}_file"
    return create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=source_type,
        intent_key=intent_key or build_intent_key(source_type, str(media.id), None),
        requested_url=None,
        canonical_source_url=None,
        provider=None,
        provider_target_ref=None,
        source_payload={
            "filename": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "library_ids": [str(library_id) for library_id in library_ids or []],
        },
        request_id=request_id,
        idempotency_key=idempotency_key,
        status=_ATTEMPT_ACCEPTED,
    )


def confirm_uploaded_source(
    *,
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_ids: list[UUID],
    request_id: str | None,
) -> dict[str, object]:
    """Confirm uploaded bytes and enqueue the shared source attempt job."""
    from nexus.services import upload as upload_service

    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)
    try:
        result = upload_service.confirm_ingest(db, viewer_id, media_id)
    except Exception as exc:
        if _is_post_acceptance_source_failure(exc):
            _fail_latest_attempt_and_media(db, media_id, exc, stage="upload")
        raise

    actual_media_id = UUID(result["media_id"])
    library_entries.assign_libraries_for_media(db, viewer_id, actual_media_id, library_ids)
    media = db.execute(select(Media).where(Media.id == actual_media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if bool(result["duplicate"]) or media.processing_status != ProcessingStatus.pending:
        attempt = _latest_source_attempt(db, actual_media_id)
        if attempt is None:
            attempt = record_upload_source_intent(
                db=db,
                media=media,
                viewer_id=viewer_id,
                filename=str(media.title or ""),
                content_type=str(media.media_file.content_type if media.media_file else ""),
                size_bytes=int(media.media_file.size_bytes if media.media_file else 0),
                request_id=request_id,
            )
            attempt.status = _ATTEMPT_SUCCEEDED
            db.commit()
        return {
            "media_id": str(actual_media_id),
            "source_attempt_id": str(attempt.id),
            "source_type": attempt.source_type,
            "source_attempt_status": attempt.status,
            "idempotency_outcome": "reused" if bool(result["duplicate"]) else "created",
            "duplicate": bool(result["duplicate"]),
            "processing_status": _status_to_str(media.processing_status),
            "ingest_enqueued": False,
        }

    attempt = _latest_source_attempt(db, actual_media_id)
    if attempt is None or not attempt.source_type.startswith("uploaded_"):
        attempt = record_upload_source_intent(
            db=db,
            media=media,
            viewer_id=viewer_id,
            filename=str(media.title or ""),
            content_type=str(media.media_file.content_type if media.media_file else ""),
            size_bytes=int(media.media_file.size_bytes if media.media_file else 0),
            request_id=request_id,
        )
    mark_source_queued(db, media)
    attempt.updated_at = func.now()
    db.commit()
    ingest_enqueued = _enqueue_accepted_attempt(
        db,
        media_id=actual_media_id,
        attempt_id=attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage="extract",
    )
    media = db.get(Media, actual_media_id) or media
    attempt = db.get(MediaSourceAttempt, attempt.id) or attempt
    return {
        "media_id": str(actual_media_id),
        "source_attempt_id": str(attempt.id),
        "source_type": attempt.source_type,
        "source_attempt_status": attempt.status,
        "idempotency_outcome": "created",
        "duplicate": False,
        "processing_status": _status_to_str(media.processing_status),
        "ingest_enqueued": ingest_enqueued,
    }


def _url_source_spec(url: str) -> dict[str, object]:
    youtube_identity = classify_youtube_url(url)
    if youtube_identity is not None:
        return {
            "source_type": source_types.YOUTUBE_VIDEO,
            "kind": MediaKind.video.value,
            "title": f"YouTube Video {youtube_identity.provider_video_id}",
            "canonical_url": youtube_identity.watch_url,
            "canonical_source_url": youtube_identity.watch_url,
            "external_playback_url": youtube_identity.watch_url,
            "provider": youtube_identity.provider,
            "provider_id": youtube_identity.provider_video_id,
            "provider_target_ref": youtube_identity.provider_video_id,
            "source_payload": {"video_id": youtube_identity.provider_video_id},
        }
    if is_youtube_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "YouTube URL must include a valid video ID",
        )

    x_identity = classify_x_url(url)
    if x_identity is not None:
        return {
            "source_type": source_types.X_AUTHOR_THREAD,
            "kind": MediaKind.web_article.value,
            "title": f"X post {x_identity.provider_id}",
            "canonical_url": None,
            "canonical_source_url": x_identity.canonical_url,
            "external_playback_url": None,
            "provider": x_identity.provider,
            "provider_id": None,
            "provider_target_ref": x_identity.provider_id,
            "source_payload": {"post_id": x_identity.provider_id},
        }
    if is_x_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "X URL must include a valid post ID",
        )

    remote_kind = remote_file_kind_from_url(url)
    if remote_kind is not None:
        source_type = (
            source_types.REMOTE_PDF_URL
            if remote_kind == MediaKind.pdf.value
            else source_types.REMOTE_EPUB_URL
        )
        return {
            "source_type": source_type,
            "kind": remote_kind,
            "title": _remote_file_name(url, remote_kind),
            "canonical_url": None,
            "canonical_source_url": normalize_url_for_display(url),
            "external_playback_url": None,
            "provider": None,
            "provider_id": None,
            "provider_target_ref": None,
            "source_payload": {"remote_kind": remote_kind},
        }

    return {
        "source_type": source_types.GENERIC_WEB_URL,
        "kind": MediaKind.web_article.value,
        "title": url[:255] if url else "Untitled",
        "canonical_url": None,
        "canonical_source_url": normalize_url_for_display(url),
        "external_playback_url": None,
        "provider": None,
        "provider_id": None,
        "provider_target_ref": None,
        "source_payload": {},
    }


def _find_reusable_url_media(
    db: Session,
    viewer_id: UUID,
    spec: dict[str, object],
) -> Media | None:
    if spec["source_type"] == source_types.X_AUTHOR_THREAD:
        target_ref = str(spec["provider_target_ref"] or "")
        if not target_ref:
            return None
        return (
            db.execute(
                select(Media)
                .join(MediaSourceAttempt, MediaSourceAttempt.media_id == Media.id)
                .where(
                    MediaSourceAttempt.source_type == source_types.X_AUTHOR_THREAD,
                    MediaSourceAttempt.provider_target_ref == target_ref,
                    Media.provider == "x",
                )
                .order_by(MediaSourceAttempt.created_at.asc(), MediaSourceAttempt.id.asc())
                .limit(1)
            )
            .scalars()
            .one_or_none()
        )
    if spec["source_type"] == source_types.X_POST:
        provider_id = str(spec["provider_id"] or "")
        if not provider_id:
            return None
        return (
            db.execute(
                select(Media).where(
                    Media.provider == "x",
                    Media.provider_id == provider_id,
                )
            )
            .scalars()
            .one_or_none()
        )
    if spec["source_type"] != source_types.YOUTUBE_VIDEO:
        return None
    media = (
        db.execute(
            select(Media).where(
                Media.kind == MediaKind.video.value,
                Media.canonical_url == spec["canonical_url"],
            )
        )
        .scalars()
        .one_or_none()
    )
    if media is not None:
        media.provider = str(spec["provider"])
        media.provider_id = str(spec["provider_id"])
        if not media.external_playback_url:
            media.external_playback_url = str(spec["external_playback_url"])
        if not media.canonical_source_url:
            media.canonical_source_url = str(spec["canonical_source_url"])
        media.updated_at = datetime.now(UTC)
    return media


def _reused_url_attempt_status(media: Media) -> str:
    if media.processing_status == ProcessingStatus.failed:
        return _ATTEMPT_FAILED
    return _ATTEMPT_SUCCEEDED


def create_attempt(
    db: Session,
    *,
    media: Media,
    viewer_id: UUID,
    source_type: str,
    intent_key: str,
    requested_url: str | None,
    canonical_source_url: object,
    provider: object,
    provider_target_ref: object,
    source_payload: dict[str, object],
    request_id: str | None,
    idempotency_key: str | None,
    status: str,
) -> MediaSourceAttempt:
    attempt_no = (
        db.execute(
            select(func.coalesce(func.max(MediaSourceAttempt.attempt_no), 0) + 1).where(
                MediaSourceAttempt.media_id == media.id
            )
        ).scalar_one()
        or 1
    )
    attempt = MediaSourceAttempt(
        media_id=media.id,
        created_by_user_id=viewer_id,
        source_type=source_type,
        attempt_no=int(attempt_no),
        status=status,
        intent_key=intent_key,
        idempotency_key=idempotency_key,
        requested_url=requested_url,
        canonical_source_url=(
            str(canonical_source_url) if canonical_source_url is not None else None
        ),
        provider=str(provider) if provider is not None else None,
        provider_target_ref=str(provider_target_ref) if provider_target_ref is not None else None,
        source_payload=source_payload,
        request_id=request_id,
    )
    db.add(attempt)
    db.flush()
    return attempt


def _clone_attempt_for_media(
    db: Session,
    *,
    media: Media,
    viewer_id: UUID,
    previous: MediaSourceAttempt,
    request_id: str | None,
    intent_key: str | None = None,
    idempotency_key: str | None = None,
) -> MediaSourceAttempt:
    return create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=previous.source_type,
        intent_key=intent_key or previous.intent_key,
        requested_url=previous.requested_url,
        canonical_source_url=previous.canonical_source_url,
        provider=previous.provider,
        provider_target_ref=previous.provider_target_ref,
        source_payload=clone_source_payload_for_new_attempt(previous.source_payload),
        request_id=request_id,
        idempotency_key=idempotency_key,
        status=_ATTEMPT_ACCEPTED,
    )


def _mark_source_requeue_payload(attempt: MediaSourceAttempt) -> None:
    if attempt.source_type != source_types.PODCAST_EPISODE_TRANSCRIPT:
        return
    payload = dict(attempt.source_payload or {})
    payload["request_reason"] = "operator_requeue"
    attempt.source_payload = payload


def _prepare_source_requeue_domain_state(
    db: Session,
    media: Media,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
) -> tuple[list[str], StorageClientBase | None]:
    cleanup_storage_client = _source_requeue_storage_client_if_required(media, attempt)
    if attempt.source_type in source_types.WEB_ARTICLE_ARTIFACT_SOURCE_TYPES:
        delete_web_article_artifacts(
            db,
            owner_user_id=media.created_by_user_id or actor_user_id,
            media_id=media.id,
            include_content_index=True,
        )
        return [], cleanup_storage_client
    if media.kind == MediaKind.pdf.value:
        from nexus.services.pdf_ingest import delete_pdf_text_artifacts

        delete_pdf_text_artifacts(db, media.id)
        return [], cleanup_storage_client
    if media.kind == MediaKind.epub.value:
        from nexus.services.epub_lifecycle import delete_extraction_artifacts

        return delete_extraction_artifacts(db, media.id), cleanup_storage_client
    if attempt.source_type != source_types.PODCAST_EPISODE_TRANSCRIPT:
        return [], cleanup_storage_client
    from nexus.services.podcasts.transcription import (
        prepare_podcast_transcription_for_source_attempt,
    )

    prepare_podcast_transcription_for_source_attempt(
        db,
        media_id=media.id,
        requested_by_user_id=actor_user_id,
        request_reason=_podcast_request_reason(
            dict(attempt.source_payload or {}).get("request_reason")
        ),
    )
    return [], cleanup_storage_client


def _source_requeue_storage_client_if_required(
    media: Media,
    attempt: MediaSourceAttempt,
) -> StorageClientBase | None:
    source_path: str | None = None
    if attempt.source_type in source_types.LOCAL_FILE_SOURCE_TYPES:
        media_file = media.media_file
        if media_file is None or not media_file.storage_path:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING,
                "Source file metadata is missing.",
            )
        source_path = str(media_file.storage_path)
    elif attempt.source_type == source_types.BROWSER_ARTICLE_CAPTURE:
        source_path = str((attempt.source_payload or {}).get("storage_path") or "")
        if not source_path:
            raise InvalidRequestError(
                ApiErrorCode.E_STORAGE_MISSING,
                "Captured article source artifact is missing.",
            )

    if source_path is None:
        return None

    storage_client = get_storage_client()
    try:
        metadata = storage_client.head_object(source_path)
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Failed to verify source storage before retry.",
        ) from exc
    if metadata is None:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING,
            "Source storage object is missing.",
        )
    return storage_client


def _podcast_request_reason(value: object) -> str:
    reason = str(value or "").strip()
    if reason in {
        "episode_open",
        "search",
        "highlight",
        "quote",
        "background_warming",
        "operator_requeue",
        "rss_feed",
    }:
        return reason
    return "operator_requeue"


def _source_attempt_failure_stage(attempt: MediaSourceAttempt | None) -> str:
    if attempt is not None and attempt.source_type in source_types.TRANSCRIPT_SOURCE_TYPES:
        return "transcribe"
    return "extract"


def _raise_if_source_action_not_reacquirable(
    media: Media,
    attempt: MediaSourceAttempt,
) -> None:
    error_code = str(media.last_error_code or attempt.error_code or "")
    if error_code in _TERMINAL_SOURCE_ERROR_CODES:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source retry is not available for this terminal failure. Provide a new source.",
        )
    if (
        attempt.source_type in source_types.NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES
        and error_code in _NON_REACQUIRABLE_FILE_ERROR_CODES
    ):
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source retry is not available because the original source bytes cannot be reacquired.",
        )


def _latest_source_attempt(db: Session, media_id: UUID) -> MediaSourceAttempt | None:
    return (
        db.execute(
            select(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == media_id)
            .order_by(
                MediaSourceAttempt.attempt_no.desc(),
                MediaSourceAttempt.created_at.desc(),
                MediaSourceAttempt.id.desc(),
            )
            .limit(1)
        )
        .scalars()
        .one_or_none()
    )


def _result_media_id(result: dict[str, object]) -> UUID | None:
    value = result.get("media_id")
    if isinstance(value, UUID):
        return value
    if isinstance(value, str) and value:
        try:
            return UUID(value)
        except ValueError:
            return None
    return None


def _sync_document_embed_targets(db: Session, media_id: UUID) -> None:
    from nexus.services.document_embeds import sync_document_embed_targets_for_media

    if sync_document_embed_targets_for_media(db, target_media_id=media_id):
        db.commit()


def _supersede_source_media(
    db: Session,
    *,
    loser_media_id: UUID,
    winner_media_id: UUID,
    attempt_id: UUID,
) -> list[str]:
    attempt = (
        db.execute(
            select(MediaSourceAttempt).where(MediaSourceAttempt.id == attempt_id).with_for_update()
        )
        .scalars()
        .one_or_none()
    )
    if attempt is not None:
        _raise_if_artifact_bearing_attempt_transfer(attempt)
        if attempt.created_by_user_id is not None:
            library_entries.assign_libraries_for_media_in_current_transaction(
                db,
                attempt.created_by_user_id,
                winner_media_id,
                _library_ids_from_payload(attempt.source_payload),
            )
        next_attempt_no = (
            db.execute(
                select(func.coalesce(func.max(MediaSourceAttempt.attempt_no), 0) + 1).where(
                    MediaSourceAttempt.media_id == winner_media_id
                )
            ).scalar_one()
            or 1
        )
        attempt.media_id = winner_media_id
        attempt.attempt_no = int(next_attempt_no)
        attempt.updated_at = func.now()
        db.flush()
    return delete_duplicate_document_media(db, loser_media_id)


def transfer_source_attempts_to_media(
    db: Session,
    *,
    loser_media_id: UUID,
    winner_media_id: UUID,
    terminal_status: str | None = None,
) -> None:
    """Move durable source attempts before deleting a duplicate media loser."""
    attempts = list(
        db.execute(
            select(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == loser_media_id)
            .order_by(MediaSourceAttempt.attempt_no.asc(), MediaSourceAttempt.created_at.asc())
            .with_for_update()
        ).scalars()
    )
    if not attempts:
        return
    for attempt in attempts:
        _raise_if_artifact_bearing_attempt_transfer(attempt)

    next_attempt_no = int(
        db.execute(
            select(func.coalesce(func.max(MediaSourceAttempt.attempt_no), 0) + 1).where(
                MediaSourceAttempt.media_id == winner_media_id
            )
        ).scalar_one()
        or 1
    )
    now = func.now()
    for attempt in attempts:
        attempt.media_id = winner_media_id
        attempt.attempt_no = next_attempt_no
        next_attempt_no += 1
        if terminal_status is not None:
            attempt.status = terminal_status
            attempt.finished_at = now
        attempt.updated_at = now
    db.flush()


def _raise_if_artifact_bearing_attempt_transfer(attempt: MediaSourceAttempt) -> None:
    if not source_attempt_storage_paths(attempt.source_payload):
        return
    raise RuntimeError(
        "Source attempt storage artifacts must be rehomed before transferring media ownership."
    )


def enqueue_podcast_episode_transcript_source_attempt(
    *,
    db: Session,
    media_id: UUID,
    viewer_id: UUID,
    request_reason: str,
    request_id: str | None,
) -> bool:
    """Create and enqueue the source-owner attempt for podcast transcript acquisition."""
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.podcast_episode.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Podcast transcript source attempts must target podcast episode media.",
        )

    latest = _latest_source_attempt(db, media_id)
    if latest is not None and latest.status in _IN_FLIGHT_ATTEMPT_STATUSES:
        return True

    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=source_types.PODCAST_EPISODE_TRANSCRIPT,
        intent_key=build_intent_key(source_types.PODCAST_EPISODE_TRANSCRIPT, str(media.id), None),
        requested_url=media.requested_url,
        canonical_source_url=media.canonical_source_url,
        provider=media.provider,
        provider_target_ref=media.provider_id,
        source_payload={
            "media_kind": media.kind,
            "request_reason": _podcast_request_reason(request_reason),
        },
        request_id=request_id,
        idempotency_key=None,
        status=_ATTEMPT_ACCEPTED,
    )
    mark_source_queued(db, media)
    db.flush()
    return _enqueue_accepted_attempt(
        db,
        media_id=media_id,
        attempt_id=attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage="transcribe",
    )


def requeue_latest_source_attempt_for_media(
    *,
    db: Session,
    media: Media,
    request_id: str | None,
) -> None:
    """Requeue the latest source attempt for stale media recovery."""
    if media.created_by_user_id is None:
        raise ValueError(f"Missing source actor for stale media: {media.id}")

    attempt = (
        db.execute(
            select(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == media.id)
            .order_by(
                MediaSourceAttempt.attempt_no.desc(),
                MediaSourceAttempt.created_at.desc(),
                MediaSourceAttempt.id.desc(),
            )
            .limit(1)
            .with_for_update()
        )
        .scalars()
        .one_or_none()
    )
    if attempt is None:
        raise ValueError(f"Missing source attempt for stale media: {media.id}")

    job = enqueue_job(
        db,
        kind="ingest_media_source",
        payload={
            "media_id": str(media.id),
            "attempt_id": str(attempt.id),
            "actor_user_id": str(media.created_by_user_id),
            "request_id": request_id,
        },
    )
    attempt.status = _ATTEMPT_QUEUED
    attempt.job_id = job.id
    attempt.retry_after_seconds = None
    attempt.updated_at = func.now()
    db.flush()


def mark_latest_source_attempt_failed(
    *,
    db: Session,
    media_id: UUID,
    error_code: str,
    error_message: str,
) -> None:
    """Fail the latest in-flight source attempt for stale media recovery."""
    attempt = (
        db.execute(
            select(MediaSourceAttempt)
            .where(MediaSourceAttempt.media_id == media_id)
            .order_by(
                MediaSourceAttempt.attempt_no.desc(),
                MediaSourceAttempt.created_at.desc(),
                MediaSourceAttempt.id.desc(),
            )
            .limit(1)
            .with_for_update()
        )
        .scalars()
        .one_or_none()
    )
    if attempt is None or attempt.status not in _IN_FLIGHT_ATTEMPT_STATUSES:
        return
    attempt.status = _ATTEMPT_FAILED
    attempt.error_code = error_code
    attempt.error_message = error_message[:1000]
    attempt.finished_at = func.now()
    attempt.updated_at = func.now()
    db.flush()


def mark_source_attempt_and_media_failed(
    *,
    db: Session,
    media_id: UUID,
    attempt_id: UUID | None,
    stage: str,
    error_code: str,
    error_message: str,
    retry_after_seconds: int | None = None,
) -> None:
    """Fail one source attempt and its owning media through the source owner."""
    attempt = db.get(MediaSourceAttempt, attempt_id) if attempt_id is not None else None
    if attempt is not None:
        attempt.status = _ATTEMPT_FAILED
        attempt.error_code = error_code
        attempt.error_message = error_message[:1000]
        attempt.retry_after_seconds = retry_after_seconds
        attempt.finished_at = func.now()
        attempt.updated_at = func.now()
    media = db.get(Media, media_id)
    if media is None:
        db.commit()
        return
    mark_failed(
        db,
        media,
        stage=stage,
        error_code=error_code,
        error_message=error_message[:1000],
    )


def _load_owned_media_for_source_action(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> Media:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can retry or refresh source content.",
        )
    return media


def _enqueue_source_job(
    db: Session,
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
):
    try:
        return enqueue_job(
            db,
            kind="ingest_media_source",
            payload={
                "media_id": str(media_id),
                "attempt_id": str(attempt_id),
                "actor_user_id": str(actor_user_id),
                "request_id": request_id,
            },
        )
    except SQLAlchemyError as exc:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to enqueue source ingest job.") from exc


def _dispatch_requeue_attempt(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
    failure_stage: str,
) -> bool:
    cleanup_storage_paths: list[str] = []
    cleanup_storage_client: StorageClientBase | None = None
    try:
        media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
        attempt = (
            db.execute(
                select(MediaSourceAttempt)
                .where(MediaSourceAttempt.id == attempt_id)
                .with_for_update()
            )
            .scalars()
            .one_or_none()
        )
        if media is None or attempt is None:
            db.rollback()
            return False
        if attempt.media_id != media_id:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Source attempt media mismatch.")
        if attempt.status == _ATTEMPT_FAILED:
            db.commit()
            return False

        cleanup_storage_paths, cleanup_storage_client = _prepare_source_requeue_domain_state(
            db, media, attempt, actor_user_id
        )
        mark_source_queued(db, media)
        job = _enqueue_source_job(db, media_id, attempt_id, actor_user_id, request_id)
        attempt.job_id = job.id
        attempt.status = _ATTEMPT_QUEUED
        attempt.retry_after_seconds = None
        attempt.updated_at = func.now()
        db.commit()
    except Exception as exc:
        if isinstance(exc, ApiError) and exc.code in {
            ApiErrorCode.E_BILLING_REQUIRED,
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
        }:
            _fail_source_attempt_and_media(
                db,
                media_id=media_id,
                attempt_id=attempt_id,
                exc=exc,
                stage=failure_stage,
            )
            raise
        db.rollback()
        _fail_source_attempt_and_media(
            db,
            media_id=media_id,
            attempt_id=attempt_id,
            exc=exc,
            stage=failure_stage,
        )
        return False

    delete_document_storage_objects(cleanup_storage_paths, cleanup_storage_client)
    return True


def _enqueue_accepted_attempt(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
    failure_stage: str,
) -> bool:
    try:
        job = _enqueue_source_job(db, media_id, attempt_id, actor_user_id, request_id)
        attempt = db.get(MediaSourceAttempt, attempt_id)
        if attempt is None:
            db.rollback()
            return False
        if attempt.status == _ATTEMPT_FAILED:
            db.commit()
            return False
        attempt.job_id = job.id
        attempt.status = _ATTEMPT_QUEUED
        attempt.retry_after_seconds = None
        attempt.updated_at = func.now()
        db.commit()
        return True
    except Exception as exc:
        db.rollback()
        _fail_source_attempt_and_media(
            db,
            media_id=media_id,
            attempt_id=attempt_id,
            exc=exc,
            stage=failure_stage,
        )
        return False


def _run_generic_web_article(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.web_article.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Generic web source attempts must target web_article media.",
        )
    begin_extraction(db, media)
    db.commit()
    return materialize_web_article_source(
        db,
        media_id,
        actor_user_id,
        request_id,
        source_attempt_id=attempt.id,
    )


def _run_x_author_thread(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    from nexus.services import x_ingest

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    post_id = str(attempt.provider_target_ref or attempt.source_payload.get("post_id") or "")
    if not post_id:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing X source target.")
    begin_extraction(db, media)
    db.commit()
    return x_ingest.materialize_x_author_thread_media(
        db,
        viewer_id=actor_user_id,
        media=media,
        post_id=post_id,
        source_attempt_id=attempt.id,
        request_id=request_id,
    )


def _run_x_post(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    from nexus.services import x_ingest

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.web_article.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "X post source attempts must target web_article media.",
        )
    post_id = str(attempt.provider_target_ref or attempt.source_payload.get("post_id") or "")
    if not post_id:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing X post source target.")
    begin_extraction(db, media)
    db.commit()
    return x_ingest.materialize_x_post_media(
        db,
        viewer_id=actor_user_id,
        media=media,
        post_id=post_id,
        source_attempt_id=attempt.id,
        request_id=request_id,
    )


def _run_youtube_video(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.video.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "YouTube source attempts must target video media.",
        )

    payload = dict(attempt.source_payload or {})
    target_ref = str(attempt.provider_target_ref or payload.get("video_id") or "").strip()
    identity = (
        classify_youtube_url(f"https://www.youtube.com/watch?v={target_ref}")
        if target_ref
        else None
    )
    if identity is None:
        identity = classify_youtube_url(
            str(
                attempt.canonical_source_url
                or attempt.requested_url
                or media.canonical_source_url
                or media.canonical_url
                or media.requested_url
                or ""
            ).strip()
        )
    if identity is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing YouTube source target.")

    media.provider = identity.provider
    media.provider_id = identity.provider_video_id
    media.canonical_url = identity.watch_url
    media.canonical_source_url = identity.watch_url
    media.external_playback_url = identity.watch_url
    media.updated_at = datetime.now(UTC)
    db.flush()
    begin_extraction(db, media)
    db.commit()
    return run_youtube_video_ingest(
        db,
        media_id,
        actor_user_id,
        request_id,
        mark_media_ready=False,
        dispatch_metadata_enrichment=False,
    )


def _run_podcast_episode_transcript(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    from nexus.services.podcasts.transcription import run_podcast_transcription_now

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.podcast_episode.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Podcast transcript source attempts must target podcast episode media.",
        )

    begin_extraction(db, media)
    db.commit()

    result = asdict(
        run_podcast_transcription_now(
            db,
            media_id=media_id,
            requested_by_user_id=actor_user_id,
            request_id=request_id,
            mark_media_ready=False,
            mark_media_failed=False,
            dispatch_metadata_enrichment=False,
        )
    )
    result["source_type"] = source_types.PODCAST_EPISODE_TRANSCRIPT
    result["media_id"] = str(media_id)
    if result.get("status") == "completed":
        result["metadata_enrichment"] = True
    elif result.get("status") == "failed":
        error_code = _coerce_api_error_code(
            str(result.get("error_code") or ApiErrorCode.E_TRANSCRIPTION_FAILED.value),
            fallback=ApiErrorCode.E_TRANSCRIPTION_FAILED,
        )
        raise ApiError(error_code, str(result.get("reason") or "Transcription failed"))
    elif result.get("status") != "skipped":
        raise ApiError(ApiErrorCode.E_INTERNAL, "Unexpected podcast transcription result.")
    elif result.get("reason") != "already_ready":
        raise ApiError(ApiErrorCode.E_INTERNAL, "Podcast transcription job was not runnable.")
    return result


def _run_prepared_html_article(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    *,
    source_storage_path: str | None,
    extract_embeds: bool,
    request_id: str | None,
) -> tuple[str, UUID, UUID, list[tuple[UUID, UUID]]]:
    """Shared HTML-in-storage body path for browser-capture and email.

    Streams derived HTML from ``storage_path`` in the attempt payload, sanitises,
    fragments, and persists apparatus. Does NOT commit and does NOT mark ready —
    the caller commits its caller-specific writes, and the source-attempt runner
    crosses ready only after the attached author observation applies in a fresh
    session (spec 2.4). Returns
    ``(canonical_text, fragment_id, owner_user_id, queued_children)``.

    Caller-specific concerns are NOT included here:
    - Fetching ``source_storage_path`` (browser only; ``None`` skips the R2 read).
    - ``extract_embeds`` / ``replace_document_embed_artifact`` (browser ``True``,
      email ``False``).
    - ``_persist_browser_article_metadata`` / title update (browser only).
    """
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    payload = dict(attempt.source_payload or {})
    storage_path = str(payload.get("storage_path") or "")
    if not storage_path:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing article source artifact.")

    begin_extraction(db, media)
    db.commit()

    storage_client = get_storage_client()
    try:
        content_html = b"".join(storage_client.stream_object(storage_path)).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_SANITIZATION_FAILED,
            "Article source is not valid UTF-8.",
        ) from exc
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR,
            "Article source is missing from storage.",
        ) from exc

    source_html: str | None = None
    if source_storage_path:
        try:
            source_html = b"".join(storage_client.stream_object(source_storage_path)).decode(
                "utf-8"
            )
        except UnicodeDecodeError as exc:
            raise InvalidRequestError(
                ApiErrorCode.E_SANITIZATION_FAILED,
                "Article source markup is not valid UTF-8.",
            ) from exc
        except StorageError as exc:
            raise ApiError(
                ApiErrorCode.E_STORAGE_ERROR,
                "Article source markup is missing from storage.",
            ) from exc

    try:
        prepared = prepare_web_article_fragment(
            html=content_html,
            embed_source_html=source_html,
            base_url=str(attempt.requested_url or media.requested_url or ""),
            fragment_idx=0,
            media_title=str(payload.get("title") or media.title or ""),
            extract_embeds=extract_embeds,
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED,
            "Article could not be sanitized.",
        ) from exc

    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Article has no readable text.",
        )

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    owner_user_id = attempt.created_by_user_id or media.created_by_user_id
    if owner_user_id is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Article attempt is missing an owner.")
    delete_web_article_artifacts(
        db,
        owner_user_id=owner_user_id,
        media_id=media_id,
        include_content_index=False,
    )
    fragment = Fragment(
        media_id=media_id,
        idx=0,
        html_sanitized=prepared.html_sanitized,
        canonical_text=canonical_text,
        created_at=datetime.now(UTC),
    )
    db.add(fragment)
    db.flush()
    insert_fragment_blocks(db, fragment.id, prepared.fragment_blocks)

    if extract_embeds:
        from nexus.services.document_embeds import replace_document_embed_artifact

        queued_children = replace_document_embed_artifact(
            db,
            owner_user_id=owner_user_id,
            media_id=media_id,
            source_attempt_id=attempt.id,
            fragment_id=fragment.id,
            document_embeds=prepared.document_embeds,
            extraction_error_code=prepared.document_embed_extraction_error_code,
            extraction_error_message=prepared.document_embed_extraction_error_message,
            request_id=request_id,
        )
    else:
        queued_children = []

    replace_media_apparatus(
        db,
        media_id=media_id,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint(
            "web_article",
            attempt.requested_url or media.requested_url,
            storage_path,
            hashlib.sha256(content_html.encode("utf-8")).hexdigest(),
            canonical_text,
        ),
        items=attach_fragment_locators(
            media_id=media_id,
            fragment_id=fragment.id,
            media_kind="web_article",
            canonical_text=prepared.canonical_text,
            items=prepared.apparatus_items,
            html_sanitized=prepared.html_sanitized,
        ),
        edges=prepared.apparatus_edges,
    )
    fragment_id = fragment.id
    # No commit and no mark_ready here: the caller commits its writes (browser
    # title + byline/excerpt/site_name) with the body/apparatus, the runner then
    # applies the attached author observation in a fresh session, and only after
    # that success does the runner terminal block cross ready (spec 2.4). A crash
    # in between leaves the attempt running + media extracting, and the
    # lease-expiry re-run repeats this source work and converges (AC 9).
    # Child-embed enqueue also runs post-commit in the caller.
    return canonical_text, fragment_id, owner_user_id, queued_children


def _enqueue_prepared_html_children(
    db: Session,
    queued_children: list[tuple[UUID, UUID]],
    owner_user_id: UUID,
    request_id: str | None,
) -> None:
    """Enqueue child-media ingest jobs for promoted document embeds (post-commit)."""
    for child_media_id, child_attempt_id in queued_children:
        enqueue_accepted_source_attempt(
            db,
            media_id=child_media_id,
            attempt_id=child_attempt_id,
            actor_user_id=owner_user_id,
            request_id=request_id,
        )


def _run_browser_article_capture(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    request_id: str | None,
) -> dict[str, object]:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.web_article.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Browser article capture must target web_article media.",
        )
    payload = dict(attempt.source_payload or {})
    storage_path = str(payload.get("storage_path") or "")
    if not storage_path:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing browser article source artifact.")
    source_storage_path = str(payload.get("source_storage_path") or "")
    if not source_storage_path:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing browser article source markup artifact.")

    _canonical_text, fragment_id, owner_user_id, queued_children = _run_prepared_html_article(
        db,
        media_id,
        attempt,
        source_storage_path=source_storage_path,
        extract_embeds=True,
        request_id=request_id,
    )

    # Browser-only: title + byline/excerpt/site_name from payload. These persist in
    # the same commit as the body/apparatus; the runner crosses ready afterwards,
    # once the attached author observation has applied (spec 2.4).
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    title = str(payload.get("title") or "").strip()
    if title:
        media.title = title[:255]
    observation = _persist_browser_article_metadata(db, media, payload)
    db.commit()
    _enqueue_prepared_html_children(db, queued_children, owner_user_id, request_id)

    result: dict[str, object] = {
        "status": "success",
        "source_type": source_types.BROWSER_ARTICLE_CAPTURE,
        "post_success_index": "web_article",
        "fragment_id": str(fragment_id),
        "metadata_enrichment": True,
    }
    attach_author_observation(result, observation=observation, source="web_article_capture")
    return result


def _run_email_message(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    request_id: str | None,
) -> dict[str, object]:
    """Run the email_message source attempt via the shared HTML pipeline.

    ``source_storage_path=None`` skips the second R2 read; ``extract_embeds=False``
    means no child media are created (D-9). Sender credit was written at accept
    time — ``_persist_browser_article_metadata`` is not called.
    """
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.web_article.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Email message must target web_article media.",
        )
    payload = dict(attempt.source_payload or {})
    if not payload.get("has_content"):
        # No text content was available at accept time; mark failed at extract.
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Email has no readable text content.",
        )

    _canonical_text, fragment_id, owner_user_id, queued_children = _run_prepared_html_article(
        db,
        media_id,
        attempt,
        source_storage_path=None,
        extract_embeds=False,
        request_id=request_id,
    )
    db.commit()
    _enqueue_prepared_html_children(db, queued_children, owner_user_id, request_id)

    return {
        "status": "success",
        "source_type": source_types.EMAIL_MESSAGE,
        "post_success_index": "web_article",
        "fragment_id": str(fragment_id),
        "metadata_enrichment": False,
    }


def _run_remote_file(
    db: Session,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    request_id: str | None,
) -> dict[str, object]:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    kind = str(media.kind)
    if kind not in REMOTE_FILE_CONTENT_TYPES:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Remote URL must be a PDF or EPUB.")
    requested_url = attempt.requested_url
    if not requested_url:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Missing remote file URL.")

    begin_extraction(db, media)
    db.commit()

    storage_path = build_storage_path(media.id, get_file_extension(kind))
    storage_client = get_storage_client()
    fetched = fetch_to_storage(
        url=requested_url,
        kind=kind,
        storage_path=storage_path,
        storage_client=storage_client,
    )
    validate_file_ingest_request(kind, fetched.content_type, fetched.size_bytes)
    source_package, source_package_diagnostics, source_package_storage_path = (
        _try_fetch_arxiv_source_package(
            media_id=media.id,
            attempt_id=attempt.id,
            requested_url=requested_url,
            kind=kind,
            storage_client=storage_client,
        )
    )

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        _delete_storage_object(storage_client, storage_path)
        if source_package_storage_path:
            _delete_storage_object(storage_client, source_package_storage_path)
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media.canonical_source_url = normalize_url_for_display(fetched.final_url)
    media.updated_at = func.now()
    media_file = db.get(MediaFile, media_id)
    if media_file is None:
        db.add(
            MediaFile(
                media_id=media_id,
                storage_path=storage_path,
                content_type=fetched.content_type,
                size_bytes=fetched.size_bytes,
            )
        )
    else:
        media_file.storage_path = storage_path
        media_file.content_type = fetched.content_type
        media_file.size_bytes = fetched.size_bytes
    attempt = db.get(MediaSourceAttempt, attempt.id)
    if attempt is not None and (source_package is not None or source_package_diagnostics):
        source_payload = dict(attempt.source_payload or {})
        source_payload["arxiv_source_package"] = source_package_diagnostics or {
            "status": "fetched",
            "source_url": source_package.source_url,
            "storage_path": source_package.storage_path,
            "content_type": source_package.content_type,
            "size_bytes": source_package.size_bytes,
            "sha256_hex": source_package.sha256_hex,
        }
        attempt.source_payload = source_payload
    db.commit()

    return _materialize_existing_file_source(
        db,
        media_id,
        kind,
        request_id,
        source_package=source_package,
        source_package_diagnostics=source_package_diagnostics,
    )


def _try_fetch_arxiv_source_package(
    *,
    media_id: UUID,
    attempt_id: UUID,
    requested_url: str,
    kind: str,
    storage_client: StorageClientBase,
) -> tuple[PdfSourcePackageArtifact | None, dict[str, object] | None, str | None]:
    if kind != MediaKind.pdf.value:
        return None, None, None
    arxiv_source = arxiv_pdf_source_from_url(requested_url)
    if arxiv_source is None:
        return None, None, None

    storage_path = build_source_artifact_storage_path(media_id, attempt_id, "tar")
    try:
        fetched = fetch_binary_to_storage(
            url=arxiv_source.source_url,
            storage_path=storage_path,
            storage_client=storage_client,
            content_type="application/x-tar",
            max_bytes=get_settings().max_arxiv_source_bytes,
            accept="application/e-print,application/x-tar,application/gzip,application/octet-stream,*/*;q=0.8",
        )
    except Exception as exc:
        error_code, error_message = _source_error_fields(exc)
        return (
            None,
            {
                "status": "fetch_failed",
                "arxiv_id": arxiv_source.arxiv_id,
                "source_url": arxiv_source.source_url,
                "error_code": error_code,
                "error_message": error_message,
            },
            None,
        )

    artifact = PdfSourcePackageArtifact(
        storage_path=storage_path,
        content_type=fetched.content_type,
        size_bytes=fetched.size_bytes,
        sha256_hex=fetched.sha256_hex,
        source_url=fetched.final_url,
        source_kind="arxiv_source",
        source_ref={
            "arxiv_id": arxiv_source.arxiv_id,
            "requested_pdf_url": requested_url,
        },
    )
    return (
        artifact,
        {
            "status": "fetched",
            "arxiv_id": arxiv_source.arxiv_id,
            "source_url": artifact.source_url,
            "storage_path": artifact.storage_path,
            "content_type": artifact.content_type,
            "size_bytes": artifact.size_bytes,
            "sha256_hex": artifact.sha256_hex,
        },
        storage_path,
    )


def _run_existing_file(
    db: Session,
    media_id: UUID,
    request_id: str | None,
) -> dict[str, object]:
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind not in {MediaKind.pdf.value, MediaKind.epub.value}:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be PDF or EPUB.")
    if media.media_file is None:
        raise InvalidRequestError(ApiErrorCode.E_STORAGE_MISSING, "Source file metadata missing.")

    begin_extraction(db, media)
    db.commit()

    return _materialize_existing_file_source(db, media_id, str(media.kind), request_id)


def _materialize_existing_file_source(
    db: Session,
    media_id: UUID,
    kind: str,
    request_id: str | None,
    *,
    source_package: PdfSourcePackageArtifact | None = None,
    source_package_diagnostics: dict[str, object] | None = None,
) -> dict[str, object]:
    if kind == MediaKind.pdf.value:
        from nexus.services.pdf_lifecycle import materialize_pdf_source

        return materialize_pdf_source(
            db,
            media_id=media_id,
            request_id=request_id,
            source_package=source_package,
            source_package_diagnostics=source_package_diagnostics,
        )
    if kind == MediaKind.epub.value:
        from nexus.services.epub_lifecycle import materialize_epub_source

        return materialize_epub_source(db, media_id=media_id)
    raise InvalidRequestError(ApiErrorCode.E_INVALID_KIND, "Source file must be PDF or EPUB.")


def _persist_browser_article_metadata(
    db: Session,
    media: Media,
    payload: dict[str, object],
) -> ContributorObservationBatch:
    """Persist captured article metadata and build the ``author`` observation.

    Returns the observation for the runner to apply through the author facade in
    a fresh session; the byline split keeps today's ``[,;]`` + ``and`` rule
    (D-31 reverses only the PDF delimiter, not the web byline lanes).
    """
    excerpt = str(payload.get("excerpt") or "").strip()
    site_name = str(payload.get("site_name") or "").strip()
    published_time = str(payload.get("published_time") or "").strip()
    byline = str(payload.get("byline") or "").strip()
    if excerpt:
        media.description = excerpt[:2000]
    if site_name:
        media.publisher = site_name[:255]
    if published_time:
        media.published_date = published_time[:64]
    if not byline:
        return NOT_OBSERVED

    clean_byline = re.sub(r"^by\s+", "", byline, flags=re.IGNORECASE)
    names = [
        name.strip()
        for name in re.split(r"\s*[,;]\s*|\s+and\s+", clean_byline, flags=re.IGNORECASE)
        if name.strip()
    ]
    observation, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=name) for name in names]}
    )
    if truncated:
        logger.info(
            "web_article_capture_author_truncated",
            media_id=str(media.id),
            truncated=truncated,
        )
    return observation


def _finish_failed_attempt(
    db: Session,
    attempt_id: UUID,
    media_id: UUID,
    exc: Exception,
) -> None:
    attempt = db.get(MediaSourceAttempt, attempt_id)
    _fail_source_attempt_and_media(
        db,
        media_id=media_id,
        attempt_id=attempt_id,
        exc=exc,
        stage=_source_attempt_failure_stage(attempt),
    )


def _run_post_success_source_actions(
    db: Session,
    *,
    media_id: UUID,
    result: dict[str, object],
    request_id: str | None,
) -> None:
    if result.get("warning_error_code") == "E_PDF_TEXT_UNAVAILABLE":
        media = db.get(Media, media_id)
        if media is not None:
            mark_stage_warning(
                db,
                media,
                stage="extract",
                error_code="E_PDF_TEXT_UNAVAILABLE",
                error_message="PDF text is unavailable; OCR is required.",
            )
            db.commit()

    if result.get("post_success_index") == "pdf":
        index_pdf_evidence(db, media_id, request_id, None)

    if result.get("post_success_index") == "web_article":
        fragment_id_value = result.get("fragment_id")
        fragment_id = None
        if isinstance(fragment_id_value, str) and fragment_id_value:
            try:
                fragment_id = UUID(fragment_id_value)
            except ValueError:
                fragment_id = None
        fragments = list(
            db.execute(
                select(Fragment)
                .where(Fragment.media_id == media_id)
                .order_by(Fragment.idx.asc(), Fragment.id.asc())
            ).scalars()
        )
        first_fragment = next(
            (
                fragment
                for fragment in fragments
                if fragment_id is None or fragment.id == fragment_id
            ),
            None,
        )
        if first_fragment is not None:
            media = db.get(Media, media_id)
            web_article_indexing.index_web_article_evidence(
                db,
                media_id=media_id,
                fragment_id=first_fragment.id,
                fragments=fragments,
                reason="web_article_ingest",
                language=media.language if media is not None else None,
                request_id=request_id,
            )

    if bool(result.get("metadata_enrichment")):
        if try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id):
            db.commit()


def _fail_latest_attempt_for_media(db: Session, media_id: UUID, exc: Exception) -> None:
    attempt = _latest_source_attempt(db, media_id)
    if attempt is None or attempt.status == _ATTEMPT_FAILED:
        return
    error_code = exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INGEST_FAILED.value
    error_message = exc.message if isinstance(exc, ApiError) else str(exc)
    attempt.status = _ATTEMPT_FAILED
    attempt.error_code = error_code
    attempt.error_message = error_message[:1000]
    attempt.retry_after_seconds = _source_retry_after_seconds(exc)
    attempt.finished_at = func.now()
    attempt.updated_at = func.now()
    db.commit()


def _fail_latest_attempt_and_media(
    db: Session,
    media_id: UUID,
    exc: Exception,
    *,
    stage: str,
) -> None:
    attempt = _latest_source_attempt(db, media_id)
    _fail_source_attempt_and_media(
        db,
        media_id=media_id,
        attempt_id=attempt.id if attempt is not None else None,
        exc=exc,
        stage=stage,
    )


def _fail_source_attempt_and_media(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID | None,
    exc: Exception,
    stage: str,
) -> None:
    error_code, error_message = _source_error_fields(exc)
    mark_source_attempt_and_media_failed(
        db=db,
        media_id=media_id,
        attempt_id=attempt_id,
        stage=stage,
        error_code=error_code,
        error_message=error_message,
        retry_after_seconds=_source_retry_after_seconds(exc),
    )


def _source_error_fields(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, ApiError):
        return exc.code.value, exc.message
    if isinstance(exc, StorageError):
        return exc.code, exc.message
    return ApiErrorCode.E_INGEST_FAILED.value, str(exc)


def _coerce_api_error_code(value: str, *, fallback: ApiErrorCode) -> ApiErrorCode:
    try:
        return ApiErrorCode(value)
    except ValueError:
        return fallback


def _source_retry_after_seconds(exc: Exception) -> int | None:
    retry_after = getattr(exc, "retry_after_seconds", None)
    if retry_after is None:
        return None
    try:
        retry_after_int = int(retry_after)
    except (TypeError, ValueError):
        return None
    return max(0, retry_after_int)


def _is_post_acceptance_source_failure(exc: Exception) -> bool:
    return not isinstance(exc, (NotFoundError, ForbiddenError, ConflictError))


def _find_idempotent_attempt(
    db: Session,
    viewer_id: UUID,
    idempotency_key: str,
) -> MediaSourceAttempt | None:
    return (
        db.execute(
            select(MediaSourceAttempt)
            .where(
                MediaSourceAttempt.created_by_user_id == viewer_id,
                MediaSourceAttempt.idempotency_key == idempotency_key,
            )
            .limit(1)
        )
        .scalars()
        .one_or_none()
    )


def _find_idempotent_source_action_attempt(
    db: Session,
    *,
    viewer_id: UUID,
    idempotency_key: str,
    media_id: UUID,
    action: str,
) -> MediaSourceAttempt | None:
    attempt = _find_idempotent_attempt(db, viewer_id, idempotency_key)
    if attempt is None:
        return None
    intent = _parse_source_action_intent_key(attempt.intent_key)
    if intent is None or intent.get("media_id") != str(media_id) or intent.get("action") != action:
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Idempotency key was reused for a different source ingest request.",
        )
    return attempt


def _lock_idempotency_key(db: Session, viewer_id: UUID, idempotency_key: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"media_source:{viewer_id}:{idempotency_key}"},
    )


def _source_action_intent_key(
    action: str,
    *,
    media_id: UUID,
    previous_attempt_id: UUID,
) -> str:
    return json.dumps(
        {
            "source_type": "media_source_action",
            "action": action,
            "media_id": str(media_id),
            "previous_attempt_id": str(previous_attempt_id),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _parse_source_action_intent_key(intent_key: str) -> dict[str, str] | None:
    try:
        payload = json.loads(intent_key)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("source_type") != "media_source_action":
        return None
    action = payload.get("action")
    media_id = payload.get("media_id")
    previous_attempt_id = payload.get("previous_attempt_id")
    if not all(
        isinstance(value, str) and value for value in (action, media_id, previous_attempt_id)
    ):
        return None
    return {
        "action": action,
        "media_id": media_id,
        "previous_attempt_id": previous_attempt_id,
    }


def build_intent_key(
    source_type: object,
    url: str,
    target_ref: object,
    *,
    library_ids: list[UUID] | None = None,
) -> str:
    payload: dict[str, object] = {
        "source_type": source_type,
        "url": url,
        "target_ref": target_ref,
    }
    if library_ids is not None:
        payload["library_ids"] = sorted(str(library_id) for library_id in library_ids)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _upload_intent_key(
    *,
    source_type: str,
    filename: str,
    content_type: str,
    size_bytes: int,
    library_ids: list[UUID],
) -> str:
    return json.dumps(
        {
            "source_type": source_type,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "library_ids": sorted(str(library_id) for library_id in library_ids),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _library_ids_from_payload(payload: dict[str, object] | None) -> list[UUID]:
    raw_ids = (payload or {}).get("library_ids")
    if not isinstance(raw_ids, list):
        return []
    library_ids: list[UUID] = []
    for raw_id in raw_ids:
        try:
            library_ids.append(UUID(str(raw_id)))
        except (TypeError, ValueError):
            continue
    return library_ids


def _clean_idempotency_key(value: str | None) -> str | None:
    clean = (value or "").strip()
    if not clean:
        return None
    if len(clean) > 255:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Idempotency-Key is too long.",
        )
    return clean


def _upload_init_response(
    *,
    db: Session,
    media: Media,
    attempt: MediaSourceAttempt,
    content_type: str,
    size_bytes: int,
    expires_in_seconds: int,
    idempotency_outcome: str,
) -> dict[str, object]:
    # Browser direct upload TTL is capped at 300s and by signed_url_expiry_s: the
    # server cannot post-write-check a browser PUT, so the signed expiry (persisted
    # below) + the R2 lifecycle + the orphan sweep are the durable backstops (spec §3.1).
    capped_ttl = min(int(expires_in_seconds), 300, int(get_settings().signed_url_expiry_s))
    expires_at = datetime.now(UTC) + timedelta(seconds=capped_ttl)
    media_file = media.media_file or db.get(MediaFile, media.id)
    upload_url: str | None = None
    can_sign_upload = (
        media_file is not None
        and media.processing_status == ProcessingStatus.pending
        and media.processing_started_at is None
        and attempt.status in {_ATTEMPT_ACCEPTED, _ATTEMPT_QUEUED}
    )
    if can_sign_upload:
        # Lock the media row, reject a teardown intent, and persist
        # signed_upload_expires_at BEFORE signing (spec §3.1). A replayed init extends
        # the timestamp; nothing can sign after a claim. Own short transaction.
        with transaction(db):
            locked = db.execute(
                text("SELECT 1 FROM media WHERE id = :m FOR UPDATE"), {"m": media.id}
            ).first()
            if locked is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            if db.execute(
                text("SELECT 1 FROM media_teardown_intents WHERE media_id = :m"),
                {"m": media.id},
            ).first():
                raise ConflictError(ApiErrorCode.E_MEDIA_DELETING, "Media is being deleted")
            db.execute(
                text(
                    """
                    UPDATE media_source_attempts
                    SET signed_upload_expires_at = now() + (CAST(:ttl AS integer) * interval '1 second'),
                        updated_at = now()
                    WHERE id = :attempt_id
                    """
                ),
                {"ttl": capped_ttl, "attempt_id": attempt.id},
            )
        try:
            signed_upload = get_storage_client().sign_upload(
                media_file.storage_path,
                content_type=content_type,
                size_bytes=size_bytes,
                expires_in=capped_ttl,
            )
            upload_url = signed_upload.upload_url
        except StorageError:
            mark_source_attempt_and_media_failed(
                db=db,
                media_id=media.id,
                attempt_id=attempt.id,
                stage="upload",
                error_code=ApiErrorCode.E_SIGN_UPLOAD_FAILED.value,
                error_message="Failed to initialize upload",
            )
            db.expire_all()
            media = db.get(Media, media.id) or media
            attempt = db.get(MediaSourceAttempt, attempt.id) or attempt

    return {
        "media_id": str(media.id),
        "source_attempt_id": str(attempt.id),
        "source_type": attempt.source_type,
        "source_attempt_status": attempt.status,
        "idempotency_outcome": idempotency_outcome,
        "processing_status": _status_to_str(media.processing_status),
        "ingest_enqueued": False,
        "upload_url": upload_url,
        "expires_at": expires_at.isoformat(),
    }


def _source_action_response_with_capabilities(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    payload: dict[str, object],
) -> dict[str, object]:
    from nexus.services.media import get_media_for_viewer

    media = get_media_for_viewer(db, viewer_id, media_id)
    return {
        **payload,
        "capabilities": media.capabilities.model_dump(),
    }


def _source_action_attempt_response(
    db: Session,
    *,
    viewer_id: UUID,
    media: Media,
    attempt: MediaSourceAttempt,
    idempotency_outcome: str,
) -> dict[str, object]:
    return _source_action_response_with_capabilities(
        db,
        viewer_id=viewer_id,
        media_id=media.id,
        payload={
            "media_id": str(media.id),
            "source_attempt_id": str(attempt.id),
            "source_type": attempt.source_type,
            "source_attempt_status": attempt.status,
            "idempotency_outcome": idempotency_outcome,
            "processing_status": _status_to_str(media.processing_status),
            "ingest_enqueued": attempt.status in {_ATTEMPT_ACCEPTED, _ATTEMPT_QUEUED},
        },
    )


def _remote_file_name(url: str, kind: str) -> str:
    name = unquote(posixpath.basename(urlparse(url).path)).strip()
    return name or f"download.{get_file_extension(kind)}"


def _delete_storage_object(storage_client, storage_path: str) -> None:
    try:
        storage_client.delete_object(storage_path)
    except StorageError:
        pass


def _status_to_str(value: object) -> str:
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)
