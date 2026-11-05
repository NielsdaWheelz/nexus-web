"""Upload sessions: bytes go browser -> storage directly (Vercel caps bodies at
4.5 MB) and become media only after the server verifies them.

One lifecycle for local PDF/EPUB uploads and browser captures (PDF, EPUB,
article packets). The client mints the session id. A session's intent never
changes (I5); each create of an unpublished, unrejected session advances its
generation, so a new staging path fences abandoned bytes and the signed url is
fresh. The initial destinations are a draft; confirmation freezes the removal fence
and the final destination ids, and persists those ids. A guard refusal keeps the
same generation and staged bytes reusable before its upload expiry.
Confirm copies the current generation's staged object to a fresh
candidate, verifies that candidate, and publishes it exactly once: publication
is the ``published_at`` write under the session row lock. An exact source target replaces its owned unreadable import; a ready item is
retained through library placement before upload. Target attempts and checked
no-match are fenced after the viewer and upload identity/session locks, then
carrier/article identities, ordered media and the complete library set.

Every capture route loads the session by viewer AND origin kind (I6): the
extension credential never reaches a local upload. Staged objects expire with
R2's ``uploads/`` rule; unreferenced candidates are the storage sweep's.
Published receipts answer identity plus current named placements (null when
unavailable), without reapplying admission effects or changing guards. They share
the media lifetime; normal hard teardown deletes the session and later confirms
are 404. Losing the live request owner requires reselection or recapture.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, cast, get_args
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import (
    Media,
    MediaFile,
    MediaUploadSession,
    MediaUploadSessionDestination,
    ProcessingStatus,
)
from nexus.db.retries import DatabaseBusyError, retry_read_committed, retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs.queue import supersede_unclaimed_job
from nexus.logging import get_logger
from nexus.schemas.extension_capture import (
    ARTICLE_PACKET_MAX_BYTES,
    ArticlePacket,
    BrowserCapture,
    BrowserSource,
    BrowserSourcePayload,
    CreateCaptureRequest,
    LocalFile,
    decode_article_packet,
)
from nexus.schemas.import_history import (
    UploadAccepted,
    UploadFailed,
    UploadPublished,
    UploadRecoveryAccepted,
    UploadVerificationFailureCode,
)
from nexus.schemas.import_refs import MediaImportRef, UploadImportRef, format_import_ref
from nexus.schemas.media_sources import (
    CreateUploadRequest,
    Published,
    Rejected,
    UploadRequired,
    UploadSessionOut,
)
from nexus.services import libraries, library_entries, source_targets, users
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.import_history import (
    append_upload_event,
    delete_upload_history_in_current_transaction,
)
from nexus.services.media_processing_state import mark_extracting
from nexus.services.reader_publication import lock_publication_generation
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.x_identity import (
    canonical_x_article_url,
    classify_x_article_carrier_url,
    x_article_provider_id,
)
from nexus.storage.client import StorageClient, StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
)

logger = get_logger(__name__)

OriginKind = Literal["LocalFile", "BrowserCapture"]
_EXTENSIONS = {"pdf": "pdf", "epub": "epub", "web_article": "json"}
_SOURCE_TYPES = {
    ("pdf", "LocalFile"): st.UPLOADED_PDF_FILE,
    ("epub", "LocalFile"): st.UPLOADED_EPUB_FILE,
    ("pdf", "BrowserCapture"): st.BROWSER_PDF_CAPTURE,
    ("epub", "BrowserCapture"): st.BROWSER_EPUB_CAPTURE,
    ("web_article", "BrowserCapture"): st.BROWSER_ARTICLE_CAPTURE,
}


@dataclass(frozen=True, slots=True)
class _Generation:
    """One generation's facts, carried out of its transaction so signing and
    verification run with none open."""

    session_id: UUID
    generation: int
    kind: str
    content_type: str
    size_bytes: int
    expires_at: datetime
    candidate_media_id: UUID
    capture: BrowserCapture | None

    @property
    def import_ref(self) -> str:
        if self.capture is not None and self.capture.source_binding.target is not None:
            return format_import_ref(
                MediaImportRef(media_id=self.capture.source_binding.target.media_id)
            )
        return format_import_ref(UploadImportRef(session_id=self.session_id))

    @classmethod
    def of(cls, session: MediaUploadSession) -> _Generation:
        origin = session.input_origin
        capture = None
        if origin["kind"] == "BrowserCapture":
            capture = BrowserCapture.model_validate(origin)
        return cls(
            session.id,
            session.upload_generation,
            session.kind,
            session.content_type,
            session.expected_size_bytes,
            session.upload_url_expires_at,
            session.candidate_media_id,
            capture,
        )

    @property
    def staging_path(self) -> str:
        return build_upload_session_staging_storage_path(
            self.session_id, self.generation, _EXTENSIONS[self.kind]
        )


def _lock_capture_target(
    db: Session, *, viewer_id: UUID, capture: BrowserCapture, kind: str
) -> Media | None:
    source = source_targets.source_for_url(
        capture.source_url, x_article_id=capture.source_binding.x_article_id
    )
    if (
        not isinstance(source, BrowserSource)
        or source.x_article_id != capture.source_binding.x_article_id
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X posts use source admission.")
    return source_targets.lock_target(
        db,
        viewer_id=viewer_id,
        source_url=capture.source_url,
        source=source,
        target=capture.source_binding.target,
        kind=kind,
    )


def create_session(
    db: Session,
    *,
    viewer_id: UUID,
    request: CreateUploadRequest | CreateCaptureRequest,
    origin: LocalFile | BrowserCapture,
) -> UploadSessionOut:
    """Accept an intent, or advance the same session's generation, and sign its PUT.

    Retry rule: the same id with the same intent advances an unpublished,
    unrejected session (a new staging path, a fresh url); a published session
    answers ``Published``, a rejected one ``Rejected``; the same id with another
    intent is 409 ``E_UPLOAD_INTENT_MISMATCH``; another user's id is 409
    ``E_RESOURCE_CONFLICT``. Local upload destinations are the first create's.
    """
    answer = _admit(db, viewer_id, request, origin, *_validated_intent(request, origin))
    if not isinstance(answer, _Generation):
        return answer
    try:
        upload_url = get_storage_client().sign_upload(
            answer.staging_path,
            content_type=answer.content_type,
            size_bytes=answer.size_bytes,
            expires_in=get_settings().signed_url_expiry_s,
        )
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_SIGN_UPLOAD_FAILED, "Failed to initialize upload.") from exc
    return UploadRequired(
        import_ref=answer.import_ref,
        session_id=answer.session_id,
        generation=answer.generation,
        upload_url=upload_url,
        content_type=answer.content_type,
        expires_at=answer.expires_at,
    )


def _admit(
    db: Session,
    viewer_id: UUID,
    request: CreateUploadRequest | CreateCaptureRequest,
    origin: LocalFile | BrowserCapture,
    kind: str,
    filename: str,
    content_type: str,
) -> UploadSessionOut | _Generation:
    with transaction(db):
        users.lock_viewer(db, viewer_id)
        # a racing first create of the same id waits here, then finds the row
        sa.lock_identity(db, f"upload_session:{request.id}")
        now = _now(db)
        expires_at = now + timedelta(seconds=get_settings().signed_url_expiry_s)
        session = db.get(
            MediaUploadSession, request.id, with_for_update=True, populate_existing=True
        )
        if session is not None:
            if session.created_by_user_id != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Upload session id is taken.")
            if (
                session.kind,
                session.filename,
                session.content_type,
                session.expected_size_bytes,
                session.input_origin,
            ) != (kind, filename, content_type, request.size_bytes, origin.model_dump(mode="json")):
                raise ConflictError(
                    ApiErrorCode.E_UPLOAD_INTENT_MISMATCH, "This file does not match the upload."
                )
            if session.published_at is not None:
                return _published(db, viewer_id, session)
            if session.verification_error_code is not None:
                return _rejected(session)
        if isinstance(origin, BrowserCapture):
            _lock_capture_target(db, viewer_id=viewer_id, capture=origin, kind=kind)
        if session is not None:
            session = db.get(
                MediaUploadSession, request.id, with_for_update=True, populate_existing=True
            )
        if session is None:
            library_ids = (
                sorted(set(request.library_ids)) if isinstance(request, CreateUploadRequest) else []
            )
            libraries.resolve_writable_destinations(db, viewer_id, library_ids)
            session = MediaUploadSession(
                id=request.id,
                created_by_user_id=viewer_id,
                candidate_media_id=new_uuid7(),
                kind=kind,
                filename=filename,
                content_type=content_type,
                expected_size_bytes=request.size_bytes,
                input_origin=origin.model_dump(mode="json"),
                upload_generation=1,
                upload_url_expires_at=expires_at,
                created_at=now,
                updated_at=now,
            )
            db.add(session)
            db.flush()
            db.add_all(
                MediaUploadSessionDestination(
                    upload_session_id=session.id, library_id=library_id, created_at=now
                )
                for library_id in library_ids
            )
            facts: UploadAccepted | UploadRecoveryAccepted = UploadAccepted(generation=1)
        else:
            if session.published_at is not None:
                return _published(db, viewer_id, session)
            if session.verification_error_code is not None:
                return _rejected(session)
            session.upload_generation += 1
            session.upload_url_expires_at = expires_at
            session.updated_at = now
            facts = UploadRecoveryAccepted(generation=session.upload_generation)
        append_upload_event(
            db, session_id=session.id, facts=facts, stage="Upload", failure_code=None
        )
        return _Generation.of(session)


def _validated_intent(
    request: CreateUploadRequest | CreateCaptureRequest, origin: LocalFile | BrowserCapture
) -> tuple[str, str, str]:
    """(kind, filename, content type), normalized; a refusal is a 400 before any write."""
    content_type = request.content_type.split(";", 1)[0].strip().lower()
    filename = request.filename.strip().replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not filename or len(filename) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid upload filename.")
    if request.kind == "web_article":
        if not isinstance(origin, BrowserCapture) or content_type != "application/json":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Article packets are browser captures."
            )
        if request.size_bytes > ARTICLE_PACKET_MAX_BYTES:
            raise InvalidRequestError(
                ApiErrorCode.E_CAPTURE_TOO_LARGE, "Article packet exceeds its size limit."
            )
        return request.kind, filename, content_type
    try:
        validate_file_ingest_request(request.kind, content_type, request.size_bytes)
    except InvalidRequestError as exc:
        if exc.code is ApiErrorCode.E_FILE_TOO_LARGE:
            raise
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Unsupported document type."
        ) from exc
    return request.kind, filename, content_type


# --- confirm -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Candidate:
    storage_path: str
    size_bytes: int
    sha256: str
    packet: ArticlePacket | None


def confirm_session(
    db: Session,
    *,
    viewer_id: UUID,
    origin_kind: OriginKind,
    session_id: UUID,
    generation: int,
    expected_removal_revision: int,
    destinations: list[UUID],
    request_id: str | None,
) -> Published:
    """Verify the current generation's bytes and publish them once.

    Retry rule: a published session answers ``Published`` whatever the generation;
    it includes fresh placements, never a new filing; an expired unpublished upload
    is 409 ``E_UPLOAD_CAPABILITY_EXPIRED``. A stale generation is 409 ``E_UPLOAD_GENERATION_STALE``; a recorded rejection
    answers its code again. Lock timeout or retry exhaustion is 503 ``E_DATABASE_BUSY``:
    it cannot resolve an earlier confirmation, so the client retains that command.
    """

    def read_current() -> Published | _Generation:
        session = _owned(db, viewer_id, origin_kind, session_id)
        if session.published_at is not None:
            return _published(db, viewer_id, session)
        _require_current(db, session, generation)
        return _Generation.of(session)

    try:
        current = retry_read_committed(db, "upload.confirm.read", read_current)
    except DatabaseBusyError as exc:
        logger.warning("db.resource_busy", exc_info=True)
        raise ApiError(
            ApiErrorCode.E_DATABASE_BUSY, "nexus is busy. wait a moment, then retry."
        ) from exc
    if isinstance(current, Published):
        return current
    client = get_storage_client()
    candidate_path = build_upload_verification_candidate_storage_path(
        current.candidate_media_id, new_uuid7(), _EXTENSIONS[current.kind]
    )
    try:
        try:
            client.copy_object(current.staging_path, candidate_path)
        except StorageError as exc:
            raise _storage_error(exc) from exc
        candidate = _measure(client, candidate_path, current)
    except ApiError as exc:
        if exc.code.value in get_args(UploadVerificationFailureCode):
            code = cast(UploadVerificationFailureCode, exc.code.value)
            _record_rejection(db, session_id, generation, code)
        logger.info(
            "upload_confirm_failed", upload_session_id=str(session_id), error_code=exc.code.value
        )
        raise

    def publish() -> Published:
        users.lock_viewer(db, viewer_id)
        sa.lock_identity(db, f"upload_session:{session_id}")
        session = _owned(db, viewer_id, origin_kind, session_id)
        if session.published_at is not None:
            return _published(db, viewer_id, session)
        _require_current(db, session, generation)
        now = _now(db)
        capture = current.capture
        media = None
        targeted_capture = False
        if capture is not None:
            media = _lock_capture_target(
                db, viewer_id=viewer_id, capture=capture, kind=current.kind
            )
            targeted_capture = media is not None
        session = _owned(db, viewer_id, origin_kind, session_id)
        _require_current(db, session, generation)
        if media is not None:
            library_entries.lock_media_rows_in_order(db, [media.id])
        library_entries.validate_acquisition_destinations(
            db,
            viewer_id=viewer_id,
            expected_removal_revision=expected_removal_revision,
            library_ids=destinations,
        )
        destination_ids = destinations
        if media is None:
            media = _new_media(db, session, current, candidate, now)
        prior = sa.latest_attempt(db, media.id, lock=False) if targeted_capture else None
        carrier_id = classify_x_article_carrier_url(capture.source_url) if capture else None
        attempt = sa.create_attempt(
            db,
            id=new_uuid7(),
            media=media,
            actor_id=viewer_id,
            source_type=_SOURCE_TYPES[(current.kind, "BrowserCapture" if capture else "LocalFile")],
            requested_url=capture.source_url if capture else media.requested_url,
            canonical_source_url=media.canonical_source_url,
            provider=media.provider,
            provider_target_ref=carrier_id or (prior.provider_target_ref if prior else None),
            payload=BrowserSourcePayload(
                source_binding=capture.source_binding,
                base_reader_generation=lock_publication_generation(db, media_id=media.id),
                storage_path=candidate.storage_path,
                content_type=current.content_type,
                size_bytes=candidate.size_bytes,
                sha256=candidate.sha256,
            ).model_dump(mode="json")
            if capture
            else {},
        )
        if prior is not None and prior.job_id is not None:
            supersede_unclaimed_job(db, job_id=prior.job_id, kind="ingest_media_source")
        mark_extracting(db, media)
        sa.enqueue_attempt(db, attempt, actor_id=viewer_id, request_id=request_id)
        published_attempt_id = attempt.id
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, destination_ids
        )
        db.execute(
            delete(MediaUploadSessionDestination).where(
                MediaUploadSessionDestination.upload_session_id == session.id
            )
        )
        db.add_all(
            MediaUploadSessionDestination(
                upload_session_id=session.id, library_id=library_id, created_at=now
            )
            for library_id in destination_ids
        )
        session.published_media_id = media.id
        session.published_source_attempt_id = published_attempt_id
        session.published_at = session.updated_at = now
        append_upload_event(
            db,
            session_id=session.id,
            facts=UploadPublished(generation=generation),
            stage="Upload",
            failure_code=None,
        )
        logger.info("upload_published", upload_session_id=str(session_id), media_id=str(media.id))
        result = _published(db, viewer_id, session)
        shared_viewers = db.scalars(
            text("SELECT DISTINCT user_id FROM memberships WHERE library_id=ANY(:ids)"),
            {"ids": destination_ids},
        ).all()
        projection.refresh_viewer_contributors(db, [viewer_id, *shared_viewers])
        record_input_change(db, owners=(f"media:{media.id}",))
        return result

    try:
        return retry_serializable(db, "upload.confirm", publish)
    except DatabaseBusyError as exc:
        logger.warning("db.resource_busy", exc_info=True)
        raise ApiError(
            ApiErrorCode.E_DATABASE_BUSY, "nexus is busy. wait a moment, then retry."
        ) from exc


def _new_media(
    db: Session,
    session: MediaUploadSession,
    current: _Generation,
    candidate: _Candidate,
    now: datetime,
) -> Media:
    capture = current.capture
    title = session.filename
    if candidate.packet is not None and capture is not None:
        # an article is titled by its packet, else its host: a url may carry signed
        # access parameters, kept as data and never displayed
        title = candidate.packet.title.strip()[:255] or (
            urlparse(capture.source_url).hostname or capture.source_url
        )
    article_id = capture.source_binding.x_article_id if capture else None
    media = Media(
        id=current.candidate_media_id,
        kind=current.kind,
        title=title,
        requested_url=capture.source_url if capture else None,
        canonical_source_url=canonical_x_article_url(article_id)
        if article_id
        else (normalize_url_for_display(capture.source_url) if capture else None),
        provider="x" if article_id else ("browser_capture" if capture else None),
        provider_id=x_article_provider_id(article_id) if article_id else None,
        browser_capture_sha256=capture.sha256 if capture else None,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=session.created_by_user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)
    if capture is None:
        db.add(
            MediaFile(
                media_id=media.id,
                storage_path=candidate.storage_path,
                content_type=current.content_type,
                size_bytes=candidate.size_bytes,
                source_sha256=candidate.sha256,
            )
        )
    db.flush()
    projection.refresh(db, "media", [media.id])
    return media


def _measure(client: StorageClient, path: str, current: _Generation) -> _Candidate:
    """Head, then stream, the candidate: size, content type, digest, and the file
    signature or the strict article packet. A packet that disagrees with its intent
    is an invalid object; a file that does is a source-integrity failure."""
    packet_kind = current.kind == "web_article"
    settings = get_settings()
    limit = (
        ARTICLE_PACKET_MAX_BYTES
        if packet_kind
        else settings.max_pdf_bytes
        if current.kind == "pdf"
        else settings.max_epub_bytes
    )
    too_large = ApiErrorCode.E_CAPTURE_TOO_LARGE if packet_kind else ApiErrorCode.E_FILE_TOO_LARGE
    mismatch = ApiErrorCode.E_INVALID_FILE_TYPE if packet_kind else ApiErrorCode.E_SOURCE_INTEGRITY
    try:
        head = client.head_object(path)
        if head is None:
            raise InvalidRequestError(ApiErrorCode.E_STORAGE_MISSING, "The upload never arrived.")
        if head.size_bytes > limit:
            raise InvalidRequestError(too_large, "Uploaded source exceeds its size limit.")
        if head.size_bytes != current.size_bytes:
            raise InvalidRequestError(mismatch, "Uploaded source size does not match its intent.")
        if head.content_type.split(";", 1)[0].strip().lower() != current.content_type:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source has another content type."
            )
        digest, body, measured = hashlib.sha256(), bytearray(), 0
        for chunk in client.stream_object(path):
            measured += len(chunk)
            if measured > limit:
                raise InvalidRequestError(too_large, "Uploaded source exceeds its size limit.")
            digest.update(chunk)
            if packet_kind or len(body) < 5:
                body.extend(chunk)
    except StorageError as exc:
        raise _storage_error(exc) from exc
    sha256 = digest.hexdigest()
    if measured != current.size_bytes or (
        current.capture is not None and sha256 != current.capture.sha256
    ):
        raise InvalidRequestError(mismatch, "Uploaded source does not match its intent.")
    packet = None
    if packet_kind:
        packet = decode_article_packet(bytes(body))
        if current.capture is None or packet.url != current.capture.source_url:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Article packet url does not match its intent."
            )
    elif not has_valid_file_signature(bytes(body[:5]), current.kind):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source has an invalid file signature."
        )
    return _Candidate(path, measured, sha256, packet)


def _record_rejection(
    db: Session, session_id: UUID, generation: int, code: UploadVerificationFailureCode
) -> None:
    """A deterministic refusal settles the session, fenced like publication: only
    the current generation of an unpublished session is rejected."""
    with transaction(db):
        session = db.get(
            MediaUploadSession, session_id, with_for_update=True, populate_existing=True
        )
        if (
            session is None
            or session.published_at is not None
            or session.upload_generation != generation
        ):
            return
        session.verification_error_code = code
        session.verification_failed_at = session.updated_at = _now(db)
        append_upload_event(
            db,
            session_id=session_id,
            facts=UploadFailed(generation=generation),
            stage="Validate",
            failure_code=code,
        )


# --- remove and support teardown -----------------------------------------------------


def delete_session(
    db: Session, *, viewer_id: UUID, origin_kind: OriginKind | None, session_id: UUID
) -> None:
    """Remove an unpublished session. Retry rule: absent is done; published is 409.

    ``origin_kind`` is the credential's scope: the extension names
    ``BrowserCapture``; the account passes ``None`` and removes either origin.
    """
    with transaction(db):
        try:
            session = _owned(db, viewer_id, origin_kind, session_id)
        except NotFoundError:
            return
        if session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
        _delete_rows(db, [session.id])


def delete_library_destination_support_in_current_transaction(
    db: Session, *, library_id: UUID
) -> None:
    """A deleted library leaves every upload intent that named it."""
    db.execute(
        delete(MediaUploadSessionDestination).where(
            MediaUploadSessionDestination.library_id == library_id
        )
    )


def delete_published_media_support_in_current_transaction(db: Session, *, media_id: UUID) -> None:
    """Remove published receipts and bound pending captures before media teardown."""
    session_ids = list(
        db.scalars(
            select(MediaUploadSession.id)
            .where(
                (MediaUploadSession.published_media_id == media_id)
                | (
                    MediaUploadSession.input_origin["source_binding"]["target"]["media_id"].astext
                    == str(media_id)
                )
            )
            .order_by(MediaUploadSession.id)
            .with_for_update()
        )
    )
    _delete_rows(db, session_ids)


def _delete_rows(db: Session, session_ids: list[UUID]) -> None:
    db.execute(
        delete(MediaUploadSessionDestination).where(
            MediaUploadSessionDestination.upload_session_id.in_(session_ids)
        )
    )
    for session_id in session_ids:
        delete_upload_history_in_current_transaction(db, session_id=session_id)
    db.execute(delete(MediaUploadSession).where(MediaUploadSession.id.in_(session_ids)))


# --- helpers -----------------------------------------------------------------------


def _owned(
    db: Session,
    viewer_id: UUID,
    origin_kind: OriginKind | None,
    session_id: UUID,
) -> MediaUploadSession:
    """The viewer's own session, row-locked, of the caller's origin when it has one;
    anything else (another origin included) is not found."""
    query = select(MediaUploadSession).where(
        MediaUploadSession.id == session_id, MediaUploadSession.created_by_user_id == viewer_id
    )
    if origin_kind is not None:
        query = query.where(MediaUploadSession.input_origin["kind"].astext == origin_kind)
    session = db.scalar(query.with_for_update().execution_options(populate_existing=True))
    if session is None:
        raise NotFoundError(ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND, "Upload session not found.")
    return session


def _require_current(db: Session, session: MediaUploadSession, generation: int) -> None:
    """Check the locked generation's deadline after any preceding lock waits."""
    if generation != session.upload_generation:
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_GENERATION_STALE, "Upload generation is no longer current."
        )
    if session.upload_url_expires_at <= db.execute(select(func.clock_timestamp())).scalar_one():
        raise ConflictError(
            ApiErrorCode.E_UPLOAD_CAPABILITY_EXPIRED, "Upload expired. Choose the file again."
        )
    if session.verification_error_code is not None:
        raise InvalidRequestError(
            ApiErrorCode(session.verification_error_code), "The upload was rejected."
        )


def _session_import_ref(session: MediaUploadSession) -> str:
    origin = session.input_origin
    if origin.get("kind") == "BrowserCapture":
        capture = BrowserCapture.model_validate(origin)
        target = capture.source_binding.target
        media_id = session.published_media_id or (target.media_id if target else None)
        if media_id is not None:
            return format_import_ref(MediaImportRef(media_id=media_id))
    return format_import_ref(UploadImportRef(session_id=session.id))


def _published(db: Session, viewer_id: UUID, session: MediaUploadSession) -> Published:
    assert (
        session.published_media_id is not None and session.published_source_attempt_id is not None
    )
    try:
        placements = library_entries.list_item_libraries(
            db, viewer_id=viewer_id, target=library_entries.media_target(session.published_media_id)
        )
    except NotFoundError as exc:
        if exc.code != ApiErrorCode.E_MEDIA_NOT_FOUND:
            raise
        placements = None
    return Published(
        import_ref=_session_import_ref(session),
        session_id=session.id,
        media_id=session.published_media_id,
        source_attempt_id=session.published_source_attempt_id,
        current_placements=placements,
        created=session.published_media_id == session.candidate_media_id,
    )


def _rejected(session: MediaUploadSession) -> Rejected:
    return Rejected(
        import_ref=_session_import_ref(session),
        session_id=session.id,
        code=cast(UploadVerificationFailureCode, session.verification_error_code),
    )


def _now(db: Session) -> datetime:
    return db.execute(select(func.now())).scalar_one()


def _storage_error(exc: StorageError) -> ApiError:
    if exc.code == ApiErrorCode.E_STORAGE_MISSING.value:
        return InvalidRequestError(ApiErrorCode.E_STORAGE_MISSING, "The upload never arrived.")
    return ApiError(ApiErrorCode.E_STORAGE_ERROR, "Upload storage is unavailable.")
