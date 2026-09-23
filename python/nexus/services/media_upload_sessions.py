"""Durable upload-session lifecycle and atomic media publication owner.

One lifecycle for local PDF/EPUB uploads and browser captures (PDF, EPUB and
article packets). A session's intent, including its ``input_origin``, is
immutable; every capture mutation (status, transport failure, retry, confirm)
loads the session by viewer AND origin kind, so an extension credential never
reaches a local upload and vice versa. Removal is not a capture mutation: the
account credential removes the viewer's own unpublished session of either
origin, because a browser capture's bytes live in the extension and only the
extension can retry it, while the web can still discard it. Publication
verifies a fresh per-confirmation candidate object and records exactly that
object, and every success or failure write is fenced by the generation it
inspected.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Literal, cast, get_args
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.models import (
    Media,
    MediaFile,
    MediaUploadSession,
    MediaUploadSessionDestination,
    ProcessingStatus,
)
from nexus.db.retries import admit_serializable
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.logging import get_logger
from nexus.schemas.extension_capture import (
    ARTICLE_PACKET_MAX_BYTES,
    INPUT_ORIGIN_ADAPTER,
    ArticlePacket,
    BrowserCapture,
    BrowserCaptureIntent,
    InputOriginKind,
    LocalFile,
    decode_article_packet,
)
from nexus.schemas.import_history import (
    SafeFailureCode,
    UploadAccepted,
    UploadFacts,
    UploadFailed,
    UploadPublished,
    UploadRecoveryAccepted,
)
from nexus.schemas.media import (
    CapabilityExpired,
    CreateUploadSessionRequest,
    NeedsAttention,
    Published,
    RetryUploadSessionRequest,
    TransportFailed,
    UploadHttpRejectedFailureRequest,
    UploadRequired,
    UploadRequiredHeaders,
    UploadSessionCapabilities,
    UploadSessionResponse,
    UploadTransportFailureRequest,
    VerificationFailed,
)
from nexus.schemas.presence import Presence, absent, present
from nexus.schemas.upload_failures import (
    UploadTransportAbortedFailure,
    UploadTransportHttpRejectedFailure,
    UploadTransportNetworkFailure,
    UploadTransportTimeoutFailure,
    UploadVerificationFailureCode,
)
from nexus.services import library_entries, library_governance, media_source_ingest
from nexus.services import media_source_types as source_types
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.import_history import (
    append_upload_event,
    delete_upload_history_in_current_transaction,
)
from nexus.services.media_processing_state import mark_source_queued
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.sealed_handles import seal_upload_session, unseal_upload_session
from nexus.services.source_publication import latest_source_attempt_id
from nexus.services.url_normalize import normalize_url_for_display
from nexus.storage.client import StorageClient, StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
)
from nexus.tasks.storage_object_cleanup import (
    StoragePathCleanupInFlight,
    finalize_upload_session_storage_object_write,
    reserve_upload_session_storage_object_write_in_current_transaction,
)

logger = get_logger(__name__)

_STAGED_RETENTION = timedelta(hours=24)
_CAPABILITY_MIN_LIFE = timedelta(seconds=1)
"""A live capability with less life than this is reported expired, not re-signed:
``expires_in`` is whole seconds, so it would be minted already dead."""
_TERMINAL_VERIFICATION_CODES: frozenset[str] = frozenset(get_args(UploadVerificationFailureCode))
_STORAGE_EXTENSIONS = {"pdf": "pdf", "epub": "epub", "web_article": "json"}
_SOURCE_TYPES = {
    ("web_article", False): source_types.BROWSER_ARTICLE_CAPTURE,
    ("pdf", False): source_types.BROWSER_PDF_CAPTURE,
    ("epub", False): source_types.BROWSER_EPUB_CAPTURE,
    ("pdf", True): source_types.UPLOADED_PDF_FILE,
    ("epub", True): source_types.UPLOADED_EPUB_FILE,
}
"""The attempt's source type by ``(kind, local file)``; a local ``web_article`` does not exist."""

UPLOAD_SESSION_DERIVED_STATE_SQL = """
        CASE
            WHEN published_at IS NOT NULL THEN 'Published'
            WHEN verification_error_code IS NOT NULL THEN 'VerificationFailed'
            WHEN verification_token IS NOT NULL AND verification_expires_at > now()
                THEN 'Verifying'
            WHEN transport_failed_at IS NOT NULL THEN 'TransportFailed'
            WHEN upload_url_expires_at <= now() THEN 'CapabilityExpired'
            ELSE 'AwaitingBytes'
        END"""
"""The one set-wise expression of the derived-session-state precedence.

The per-row surfaces below project the same order, so no consumer re-derives
the rule independently. The ``Verifying`` branch and the ``verification_token``
columns remain in the 0236 baseline and in the Imports read model; nothing in
the confirm path writes them any more.
"""

UPLOAD_SESSION_ATTENTION_STATES = ("VerificationFailed", "TransportFailed", "CapabilityExpired")
"""Derived states that are an unresolved user obligation."""


@dataclass(frozen=True, slots=True)
class _Intent:
    kind: Literal["pdf", "epub", "web_article"]
    filename: str
    content_type: str
    size_bytes: int
    library_ids: tuple[UUID, ...]
    input_origin: LocalFile | BrowserCapture

    def canonical_bytes(self) -> bytes:
        return _intent_bytes(
            kind=self.kind,
            filename=self.filename,
            content_type=self.content_type,
            size_bytes=self.size_bytes,
            library_ids=self.library_ids,
            input_origin=self.input_origin.model_dump(mode="json"),
        )


def _intent_bytes(
    *,
    kind: str,
    filename: str,
    content_type: str,
    size_bytes: int,
    library_ids: tuple[UUID, ...],
    input_origin: dict[str, object],
) -> bytes:
    """The one comparison form of an intent: same key, different bytes is a conflict."""
    return canonical_json_bytes(
        {
            "kind": kind,
            "filename": filename,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "library_ids": [str(library_id) for library_id in library_ids],
            "input_origin": input_origin,
        }
    )


@dataclass(frozen=True, slots=True)
class _Capability:
    """One generation's immutable facts, carried out of the transaction that
    admitted it so the signed URL is minted with no transaction open."""

    session_id: UUID
    generation: int
    kind: str
    content_type: str
    expected_size_bytes: int
    expires_at: datetime

    @classmethod
    def of(cls, session: MediaUploadSession) -> _Capability:
        return cls(
            session_id=session.id,
            generation=session.upload_generation,
            kind=session.kind,
            content_type=session.content_type,
            expected_size_bytes=session.expected_size_bytes,
            expires_at=session.upload_url_expires_at,
        )

    def staging_path(self) -> str:
        return build_upload_session_staging_storage_path(
            self.session_id, self.generation, _STORAGE_EXTENSIONS[self.kind]
        )


@dataclass(frozen=True, slots=True)
class _Candidate:
    """One verified candidate object: exactly what publication records."""

    storage_path: str
    size_bytes: int
    sha256: str
    packet: ArticlePacket | None


# =============================================================================
# Create
# =============================================================================


def create_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    request: CreateUploadSessionRequest | BrowserCaptureIntent,
    input_origin: LocalFile | BrowserCapture,
    request_id: str | None,
    idempotency_key: str | None,
    storage_client: StorageClient | None = None,
) -> UploadSessionResponse:
    """Accept one upload intent and mint the capability for its current generation.

    The idempotency key identifies the intent, not one capability: a live
    generation is re-signed and its expiry extended, while a transport failure
    or a lapsed capability advances the generation instead, fencing abandoned
    bytes behind a new staging path.
    """
    intent = _normalize_intent(request, input_origin)
    clean_key = _require_key(idempotency_key, "Idempotency-Key")
    clean_request_id = _require_key(request_id, "Request ID")[:255]
    created = False
    with transaction(db):
        media_source_ingest.lock_identity(db, f"media_upload:{viewer_id}:{clean_key}")
        session = db.execute(
            select(MediaUploadSession)
            .where(
                MediaUploadSession.created_by_user_id == viewer_id,
                MediaUploadSession.idempotency_key == clean_key,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        now = _db_now(db)
        if session is None:
            library_governance.validate_writable_library_destinations(
                db, viewer_id, list(intent.library_ids)
            )
            session = MediaUploadSession(
                id=new_uuid7(),
                created_by_user_id=viewer_id,
                candidate_media_id=new_uuid7(),
                kind=intent.kind,
                filename=intent.filename,
                content_type=intent.content_type,
                expected_size_bytes=intent.size_bytes,
                input_origin=intent.input_origin.model_dump(mode="json"),
                idempotency_key=clean_key,
                request_id=clean_request_id,
                upload_generation=1,
                upload_url_expires_at=now + timedelta(seconds=get_settings().signed_url_expiry_s),
                created_at=now,
                updated_at=now,
            )
            db.add(session)
            db.flush()
            db.add_all(
                MediaUploadSessionDestination(
                    upload_session_id=session.id, library_id=library_id, created_at=now
                )
                for library_id in intent.library_ids
            )
            created = True
            _record_event(db, session.id, UploadAccepted(generation=1), stage="Upload")
        else:
            stored = _intent_bytes(
                kind=session.kind,
                filename=session.filename,
                content_type=session.content_type,
                size_bytes=session.expected_size_bytes,
                library_ids=_destinations(db, session.id),
                input_origin=session.input_origin,
            )
            if stored != intent.canonical_bytes():
                raise ConflictError(
                    ApiErrorCode.E_IDEMPOTENCY_CONFLICT,
                    "Idempotency key was reused for a different upload intent.",
                )
            if session.published_at is not None:
                return _published(session, "Reused")
            if session.verification_error_code is not None:
                return _verification_failed(session)
            if session.transport_failed_at is not None or session.upload_url_expires_at <= now:
                _advance_generation(session, now)
                _record_event(
                    db,
                    session.id,
                    UploadRecoveryAccepted(generation=session.upload_generation),
                    stage="Upload",
                )
            else:
                session.upload_url_expires_at = now + timedelta(
                    seconds=get_settings().signed_url_expiry_s
                )
                session.updated_at = now
        capability = _Capability.of(session)
        _reserve_staged_bytes(db, capability)
    logger.info(
        "IntentAccepted",
        upload_session_id=str(capability.session_id),
        generation=capability.generation,
        request_id=clean_request_id,
    )
    return _sign(
        capability,
        outcome="Created" if created else "Reused",
        expires_in=get_settings().signed_url_expiry_s,
        storage_client=storage_client or get_storage_client(),
    )


# =============================================================================
# Status
# =============================================================================


def read_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    origin_kind: InputOriginKind,
    session_handle: str,
    storage_client: StorageClient | None = None,
) -> UploadSessionResponse:
    """The session's current projection. A live capability is re-signed for its
    remaining lifetime only; reading never extends or advances anything."""
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, origin_kind, session_handle)
        now = _db_now(db)
        if session.published_at is not None:
            return _published(session, "Reused")
        if session.verification_error_code is not None:
            return _verification_failed(session)
        if session.transport_failed_at is not None:
            return NeedsAttention(
                session_handle=seal_upload_session(session.id),
                failure=_transport_failure(session),
                capabilities=UploadSessionCapabilities(can_retry_upload=True, can_remove=True),
            )
        if session.upload_url_expires_at <= now + _CAPABILITY_MIN_LIFE:
            return _capability_expired(session.id, session.upload_url_expires_at)
        capability = _Capability.of(session)
    return _sign(
        capability,
        outcome="Reused",
        expires_in=int((capability.expires_at - now).total_seconds()),
        storage_client=storage_client or get_storage_client(),
    )


# =============================================================================
# Transport failure and retry
# =============================================================================


def record_transport_failure(
    db: Session,
    *,
    viewer_id: UUID,
    origin_kind: InputOriginKind,
    session_handle: str,
    failure: UploadTransportFailureRequest,
) -> None:
    """Record a browser phase report. Telemetry the caller can never be refused."""
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, origin_kind, session_handle)
        if failure.generation != session.upload_generation or session.published_at is not None:
            return
        now = _db_now(db)
        session.transport_failure_kind = failure.kind
        session.transport_http_status = (
            failure.status if isinstance(failure, UploadHttpRejectedFailureRequest) else None
        )
        session.transport_failed_at = now
        session.updated_at = now
        _record_event(
            db,
            session.id,
            UploadFailed(
                generation=session.upload_generation,
                transport=present(_transport_failure(session).reason),
            ),
            stage="Upload",
            failure_code=present("E_UPLOAD_TRANSPORT_FAILED"),
        )


@dataclass(frozen=True, slots=True)
class _AdmittedRetry:
    """The memoized receipt of one admitted retry: a generation and its expiry."""

    generation: int
    expires_at: datetime


def retry_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    origin_kind: InputOriginKind,
    session_handle: str,
    request: RetryUploadSessionRequest,
    storage_client: StorageClient | None = None,
) -> UploadRequired | NeedsAttention:
    """Admit one new upload generation, exactly once per ``client_mutation_id``.

    A replay re-mints the admitted generation for its remaining life and never
    extends it, so a replayed retry can report ``CapabilityExpired`` where a
    fresh create would still hand back a usable capability.
    """
    filename = _normalize_filename(request.filename)
    content_type = _normalize_content_type(request.content_type)
    session_id = unseal_upload_session(session_handle)
    scope = f"media_upload_retry:{session_id}"
    request_bytes = canonical_json_bytes(request.model_dump(mode="json"))

    def admit() -> tuple[_Capability, _AdmittedRetry]:
        session = _owned_session_for_update(db, viewer_id, origin_kind, session_handle)
        memo = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        if session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
        if session.verification_error_code is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_INTENT_MISMATCH,
                "A rejected upload session cannot be retried.",
            )
        if memo is not None:
            admitted = _AdmittedRetry(
                generation=int(str(memo["generation"])),
                expires_at=datetime.fromisoformat(str(memo["expires_at"])),
            )
            if session.upload_generation != admitted.generation:
                raise ConflictError(
                    ApiErrorCode.E_UPLOAD_GENERATION_STALE,
                    "Upload generation is no longer current.",
                )
            db.commit()
            return replace(_Capability.of(session), expires_at=admitted.expires_at), admitted
        # Intent is compared before any content-type judgement, so picking the
        # wrong file reads as a mismatch the user can repair. The persisted
        # intent was validated on create and is immutable.
        if (filename, content_type, request.size_bytes) != (
            session.filename,
            session.content_type,
            session.expected_size_bytes,
        ):
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_INTENT_MISMATCH,
                "Retry request does not match the upload intent.",
            )
        if request.expected_generation != session.upload_generation:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected upload generation is no longer current.",
                details={"current": {"generation": session.upload_generation}},
            )
        _advance_generation(session, _db_now(db))
        _record_event(
            db,
            session.id,
            UploadRecoveryAccepted(generation=session.upload_generation),
            stage="Upload",
        )
        capability = _Capability.of(session)
        _reserve_staged_bytes(db, capability)
        admitted = _AdmittedRetry(
            generation=capability.generation, expires_at=capability.expires_at
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json={
                "generation": admitted.generation,
                "expires_at": admitted.expires_at.isoformat(),
            },
        )
        db.commit()
        return capability, admitted

    capability, admitted = admit_serializable(db, "retry_upload_session", admit)
    now = _db_now(db)
    db.rollback()
    if admitted.expires_at <= now + _CAPABILITY_MIN_LIFE:
        return _capability_expired(session_id, admitted.expires_at)
    return _sign(
        capability,
        outcome="Reused",
        expires_in=int((admitted.expires_at - now).total_seconds()),
        storage_client=storage_client or get_storage_client(),
    )


# =============================================================================
# Confirm
# =============================================================================


def confirm_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    origin_kind: InputOriginKind,
    session_handle: str,
    generation: int,
    request_id: str | None,
    storage_client: StorageClient | None = None,
) -> Published:
    """Copy the staged object to a fresh candidate, verify that candidate, publish it.

    Every confirmation owns its own candidate path, so a delayed confirmation
    can never overwrite bytes another one published. Publication is the
    ``published_at`` write under the session row lock: a concurrent confirm
    blocks on that lock and converges on the same ``Published``. A browser
    capture whose exact bytes the account already holds reuses that media and
    adds only placements and a receipt.
    """
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, origin_kind, session_handle)
        if session.published_at is not None:
            return _published(session, "Reused")
        if generation != session.upload_generation:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_GENERATION_STALE,
                "Upload generation is no longer current.",
            )
        if session.verification_error_code is not None:
            raise InvalidRequestError(
                ApiErrorCode(session.verification_error_code),
                "Uploaded source was rejected during verification.",
            )
        capability = _Capability.of(session)
        candidate_media_id = session.candidate_media_id
        input_origin = INPUT_ORIGIN_ADAPTER.validate_python(session.input_origin)
    capture = input_origin if isinstance(input_origin, BrowserCapture) else None

    client = storage_client or get_storage_client()
    session_id = capability.session_id
    staging_path = capability.staging_path()
    candidate_path = build_upload_verification_candidate_storage_path(
        candidate_media_id, new_uuid7(), _STORAGE_EXTENSIONS[capability.kind]
    )
    logger.info(
        "ConfirmStarted",
        upload_session_id=str(session_id),
        generation=generation,
        request_id=request_id,
    )
    try:
        _reserve_candidate_bytes(db, session_id=session_id, candidate_path=candidate_path)
        try:
            client.copy_object(staging_path, candidate_path)
        except StorageError as exc:
            raise _storage_error(exc) from exc
        candidate = _measure_candidate(
            client,
            storage_path=candidate_path,
            kind=capability.kind,
            expected_content_type=capability.content_type,
            expected_size_bytes=capability.expected_size_bytes,
            capture=capture,
        )
    except ApiError as exc:
        if exc.code.value in _TERMINAL_VERIFICATION_CODES:
            _record_terminal_verification_failure(
                db, session_id=session_id, generation=generation, error_code=exc.code
            )
        logger.info(
            "ConfirmFailed",
            upload_session_id=str(session_id),
            generation=generation,
            request_id=request_id,
            error_code=exc.code.value,
        )
        raise

    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, origin_kind, session_handle)
        now = _db_now(db)
        if session.published_at is not None:
            return _published(session, "Reused")
        if generation != session.upload_generation:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_GENERATION_STALE,
                "Upload generation is no longer current.",
            )
        media = None
        if capture is not None:
            media_source_ingest.lock_identity(
                db, f"browser_capture:{viewer_id}:{capability.kind}:{capture.sha256}"
            )
            media = _readable_browser_capture(
                db, viewer_id=viewer_id, kind=capability.kind, sha256=capture.sha256
            )
        destination_ids = list(_destinations(db, session.id))
        library_governance.validate_writable_library_destinations(db, viewer_id, destination_ids)
        created = media is None
        if media is None:
            media = Media(
                id=candidate_media_id,
                kind=capability.kind,
                title=_new_media_title(session, candidate, capture),
                requested_url=None if capture is None else capture.source_url,
                canonical_source_url=(
                    None if capture is None else normalize_url_for_display(capture.source_url)
                ),
                provider=None if capture is None else "browser_capture",
                browser_capture_sha256=None if capture is None else capture.sha256,
                processing_status=ProcessingStatus.pending,
                created_by_user_id=viewer_id,
                created_at=now,
                updated_at=now,
            )
            db.add(media)
            if capability.kind != "web_article":
                db.add(
                    MediaFile(
                        media_id=media.id,
                        storage_path=candidate.storage_path,
                        content_type=capability.content_type,
                        size_bytes=candidate.size_bytes,
                        source_sha256=candidate.sha256,
                    )
                )
            db.flush()
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, destination_ids
        )
        if created:
            attempt = media_source_ingest.create_attempt(
                db,
                media=media,
                viewer_id=viewer_id,
                source_type=_SOURCE_TYPES[(capability.kind, capture is None)],
                intent_key=f"upload_session:{session.id}",
                requested_url=media.requested_url,
                canonical_source_url=media.canonical_source_url,
                provider=media.provider,
                provider_target_ref=None,
                source_payload=_source_payload(session, candidate, capture, destination_ids),
                request_id=request_id,
                idempotency_key=None,
                status="accepted",
            )
            mark_source_queued(db, media)
            media_source_ingest.enqueue_accepted_source_attempt_in_transaction(
                db,
                media_id=media.id,
                attempt_id=attempt.id,
                actor_user_id=viewer_id,
                request_id=request_id,
            )
            published_attempt_id = attempt.id
        else:
            published_attempt_id = latest_source_attempt_id(db, media.id)
            if published_attempt_id is None:
                raise ApiError(ApiErrorCode.E_INTERNAL, "Reused capture has no source attempt.")
        published_media_id = media.id
        session.published_media_id = published_media_id
        session.published_source_attempt_id = published_attempt_id
        session.published_at = now
        session.transport_failure_kind = None
        session.transport_http_status = None
        session.transport_failed_at = None
        session.updated_at = now
        _record_event(
            db,
            session.id,
            UploadPublished(
                generation=generation,
                media_id=published_media_id,
                source_attempt_id=published_attempt_id,
            ),
            stage="Upload",
        )

    # A candidate the published media references is retained; a reused media
    # references none, so the finalizer rejects and reclaims it.
    finalize_upload_session_storage_object_write(
        db, upload_session_id=session_id, storage_path=candidate.storage_path, storage_client=client
    )
    logger.info(
        "Published",
        upload_session_id=str(session_id),
        generation=generation,
        request_id=request_id,
        media_id=str(published_media_id),
        source_attempt_id=str(published_attempt_id),
    )
    return Published(
        session_handle=seal_upload_session(session_id),
        media_id=published_media_id,
        source_attempt_id=published_attempt_id,
        idempotency_outcome="Created",
    )


def _measure_candidate(
    storage_client: StorageClient,
    *,
    storage_path: str,
    kind: str,
    expected_content_type: str,
    expected_size_bytes: int,
    capture: BrowserCapture | None,
) -> _Candidate:
    """Head, then stream the candidate object: size, content type, digest, and the
    file signature or the strict article packet. A packet's disagreement with its
    intent is an invalid object; a file's is a source-integrity failure."""
    if kind == "web_article":
        max_bytes = ARTICLE_PACKET_MAX_BYTES
        too_large = ApiErrorCode.E_CAPTURE_TOO_LARGE
        mismatch = ApiErrorCode.E_INVALID_FILE_TYPE
    else:
        max_bytes = get_settings().max_pdf_bytes if kind == "pdf" else get_settings().max_epub_bytes
        too_large = ApiErrorCode.E_FILE_TOO_LARGE
        mismatch = ApiErrorCode.E_SOURCE_INTEGRITY
    try:
        metadata = storage_client.head_object(storage_path)
    except StorageError as exc:
        raise _storage_error(exc) from exc
    if metadata is None:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING, "Uploaded source is missing from storage."
        )
    if metadata.size_bytes > max_bytes:
        raise InvalidRequestError(too_large, "Uploaded source exceeds its size limit.")
    if metadata.size_bytes != expected_size_bytes:
        raise InvalidRequestError(mismatch, "Uploaded source size does not match its intent.")
    if _normalize_content_type(metadata.content_type) != expected_content_type:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source has an invalid content type."
        )
    digest = hashlib.sha256()
    body = bytearray()
    measured = 0
    try:
        for chunk in storage_client.stream_object(storage_path):
            measured += len(chunk)
            if measured > max_bytes:
                raise InvalidRequestError(too_large, "Uploaded source exceeds its size limit.")
            digest.update(chunk)
            if kind == "web_article" or len(body) < 5:
                body.extend(chunk)
    except StorageError as exc:
        raise _storage_error(exc) from exc
    if measured != expected_size_bytes:
        raise InvalidRequestError(mismatch, "Uploaded source changed while being verified.")
    sha256 = digest.hexdigest()
    if capture is not None and sha256 != capture.sha256:
        raise InvalidRequestError(mismatch, "Uploaded source does not match its intent digest.")
    packet = None
    if kind == "web_article":
        packet = decode_article_packet(bytes(body))
        if capture is None or packet.url != capture.source_url:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Article packet url does not match its intent."
            )
    elif not has_valid_file_signature(bytes(body[:5]), kind):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source has an invalid file signature."
        )
    return _Candidate(storage_path=storage_path, size_bytes=measured, sha256=sha256, packet=packet)


def _readable_browser_capture(
    db: Session, *, viewer_id: UUID, kind: str, sha256: str
) -> Media | None:
    """The oldest media of this account holding exactly these captured bytes that
    the viewer can still read, row-locked so teardown cannot claim it
    mid-publication. Only the chosen row is locked, never a twin the viewer
    cannot read (deleted, tearing down); the lock may have waited behind a
    teardown, so readability is decided again on the locked row."""
    for media_id in db.scalars(
        select(Media.id)
        .where(
            Media.created_by_user_id == viewer_id,
            Media.kind == kind,
            Media.browser_capture_sha256 == sha256,
        )
        .order_by(Media.created_at, Media.id)
    ).all():
        if not can_read_media(db, viewer_id, media_id):
            continue
        media = db.get(Media, media_id, with_for_update=True)
        if media is not None and can_read_media(db, viewer_id, media_id):
            return media
    return None


def _new_media_title(
    session: MediaUploadSession, candidate: _Candidate, capture: BrowserCapture | None
) -> str:
    """A file is titled by its filename; an article by its packet title, else by
    its source host: the url may carry signed access parameters, which are
    retained as data and never displayed."""
    if candidate.packet is None or capture is None:
        return session.filename
    return candidate.packet.title.strip()[:255] or (
        urlparse(capture.source_url).hostname or capture.source_url
    )


def _source_payload(
    session: MediaUploadSession,
    candidate: _Candidate,
    capture: BrowserCapture | None,
    destination_ids: list[UUID],
) -> dict[str, object]:
    library_ids = [str(library_id) for library_id in destination_ids]
    if candidate.packet is not None and capture is not None:
        return {
            "storage_path": candidate.storage_path,
            "content_type": session.content_type,
            "size_bytes": candidate.size_bytes,
            "sha256": candidate.sha256,
            "source_url": capture.source_url,
            "library_ids": library_ids,
        }
    payload: dict[str, object] = {
        "filename": session.filename,
        "content_type": session.content_type,
        "size_bytes": candidate.size_bytes,
        "source_sha256": candidate.sha256,
        "storage_path": candidate.storage_path,
        "library_ids": library_ids,
    }
    if capture is not None:
        payload["source_url"] = capture.source_url
    return payload


def _record_terminal_verification_failure(
    db: Session, *, session_id: UUID, generation: int, error_code: ApiErrorCode
) -> None:
    """A deterministic rejection settles the session: only removal remains.

    Fenced like success: only an unpublished session whose current generation is
    still the inspected one is settled, so a stale result cannot reject bytes a
    newer generation is about to deliver.
    """
    with transaction(db):
        session = db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if (
            session is None
            or session.published_at is not None
            or session.upload_generation != generation
        ):
            return
        now = _db_now(db)
        _record_event(
            db,
            session.id,
            UploadFailed(generation=generation, transport=absent()),
            stage="Validate",
            failure_code=present(error_code.value),
        )
        session.verification_error_code = error_code.value
        session.verification_failed_at = now
        session.transport_failure_kind = None
        session.transport_http_status = None
        session.transport_failed_at = None
        session.updated_at = now


def _reserve_candidate_bytes(db: Session, *, session_id: UUID, candidate_path: str) -> None:
    """Hold the candidate object well past this confirm's own lifetime."""
    retain_until = _db_now(db) + _STAGED_RETENTION
    try:
        with transaction(db):
            reserve_upload_session_storage_object_write_in_current_transaction(
                db,
                upload_session_id=session_id,
                storage_path=candidate_path,
                retain_until=retain_until,
            )
    except StoragePathCleanupInFlight as exc:
        # The sweep for this exact candidate is already deleting it: nothing
        # deterministic was rejected, so the confirm stays transient.
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, "Uploaded source storage is unavailable."
        ) from exc


# =============================================================================
# Delete and support teardown
# =============================================================================


def delete_upload_session(
    db: Session, *, viewer_id: UUID, origin_kind: InputOriginKind | None, session_handle: str
) -> None:
    """Remove an unpublished session, handing every staged generation to the sweeper.

    ``origin_kind`` is the caller's credential scope: the extension bearer names
    ``BrowserCapture``; the account credential passes ``None`` and removes its
    own session of either origin.
    """
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, origin_kind, session_handle)
        if session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
        now = _db_now(db)
        write_margin = timedelta(seconds=get_settings().storage_object_cleanup_write_window_seconds)
        delete_not_before = max(now, session.upload_url_expires_at) + write_margin
        for generation in range(1, session.upload_generation + 1):
            try:
                reserve_upload_session_storage_object_write_in_current_transaction(
                    db,
                    upload_session_id=session.id,
                    storage_path=build_upload_session_staging_storage_path(
                        session.id, generation, _STORAGE_EXTENSIONS[session.kind]
                    ),
                    retain_until=delete_not_before,
                )
            # justify-ignore-error: a claimed sweep of this exact staged path is
            # already the durable cleanup intent a 204 requires, and strictly
            # stronger evidence than a freshly armed reservation.
            except StoragePathCleanupInFlight:
                logger.info(
                    "upload_staged_cleanup_already_in_flight",
                    upload_session_id=str(session.id),
                    generation=generation,
                )
        db.execute(
            delete(MediaUploadSessionDestination).where(
                MediaUploadSessionDestination.upload_session_id == session.id
            )
        )
        delete_upload_history_in_current_transaction(db, session_id=session.id)
        db.delete(session)


def delete_library_destination_support_in_current_transaction(
    db: Session, *, library_id: UUID
) -> None:
    """Remove upload-intent references to a library being deleted by its owner."""
    db.execute(
        delete(MediaUploadSessionDestination).where(
            MediaUploadSessionDestination.library_id == library_id
        )
    )


def delete_published_media_support_in_current_transaction(db: Session, *, media_id: UUID) -> None:
    """Remove every capture receipt of a media before its media and source attempts."""
    session_ids = list(
        db.execute(
            select(MediaUploadSession.id)
            .where(MediaUploadSession.published_media_id == media_id)
            .order_by(MediaUploadSession.id)
            .with_for_update()
        ).scalars()
    )
    for session_id in session_ids:
        db.execute(
            delete(MediaUploadSessionDestination).where(
                MediaUploadSessionDestination.upload_session_id == session_id
            )
        )
        delete_upload_history_in_current_transaction(db, session_id=session_id)
    db.execute(delete(MediaUploadSession).where(MediaUploadSession.id.in_(session_ids)))


# =============================================================================
# Projections and helpers
#
# ``UPLOAD_SESSION_DERIVED_STATE_SQL`` is the set-wise owner of the derived-state
# precedence; the per-row surfaces below project the same order — published,
# then a terminal verification failure, then transport failure or a lapsed
# capability.
# =============================================================================


def _verification_failed(session: MediaUploadSession) -> NeedsAttention:
    if session.verification_failed_at is None or session.verification_error_code is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Terminal verification has no recorded failure.")
    return NeedsAttention(
        session_handle=seal_upload_session(session.id),
        failure=VerificationFailed(
            code=cast(UploadVerificationFailureCode, session.verification_error_code),
            failed_at=session.verification_failed_at,
        ),
        capabilities=UploadSessionCapabilities(can_retry_upload=False, can_remove=True),
    )


def _capability_expired(session_id: UUID, expired_at: datetime) -> NeedsAttention:
    return NeedsAttention(
        session_handle=seal_upload_session(session_id),
        failure=CapabilityExpired(expired_at=expired_at),
        capabilities=UploadSessionCapabilities(can_retry_upload=True, can_remove=True),
    )


def _transport_failure(session: MediaUploadSession) -> TransportFailed:
    if session.transport_failed_at is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Transport failure has no timestamp.")
    match session.transport_failure_kind:
        case "Network":
            reason = UploadTransportNetworkFailure()
        case "Timeout":
            reason = UploadTransportTimeoutFailure()
        case "HttpRejected":
            reason = UploadTransportHttpRejectedFailure(status=session.transport_http_status or 0)
        case _:
            reason = UploadTransportAbortedFailure()
    return TransportFailed(reason=reason, failed_at=session.transport_failed_at)


def _published(session: MediaUploadSession, outcome: Literal["Created", "Reused"]) -> Published:
    if session.published_media_id is None or session.published_source_attempt_id is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Published upload has no publication identity.")
    return Published(
        session_handle=seal_upload_session(session.id),
        media_id=session.published_media_id,
        source_attempt_id=session.published_source_attempt_id,
        idempotency_outcome=outcome,
    )


def _sign(
    capability: _Capability,
    *,
    outcome: Literal["Created", "Reused"],
    expires_in: int,
    storage_client: StorageClient,
) -> UploadRequired:
    try:
        signed = storage_client.sign_upload(
            capability.staging_path(),
            content_type=capability.content_type,
            size_bytes=capability.expected_size_bytes,
            expires_in=expires_in,
        )
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_SIGN_UPLOAD_FAILED, "Failed to initialize upload.") from exc
    return UploadRequired(
        session_handle=seal_upload_session(capability.session_id),
        generation=capability.generation,
        upload_url=signed.upload_url,
        required_headers=UploadRequiredHeaders.model_validate(
            {"Content-Type": capability.content_type}
        ),
        expires_at=capability.expires_at,
        idempotency_outcome=outcome,
    )


def _advance_generation(session: MediaUploadSession, now: datetime) -> None:
    """A new generation fences abandoned bytes behind a new staging path."""
    session.upload_generation += 1
    session.upload_url_expires_at = now + timedelta(seconds=get_settings().signed_url_expiry_s)
    session.transport_failure_kind = None
    session.transport_http_status = None
    session.transport_failed_at = None
    session.updated_at = now


def _reserve_staged_bytes(db: Session, capability: _Capability) -> None:
    reserve_upload_session_storage_object_write_in_current_transaction(
        db,
        upload_session_id=capability.session_id,
        storage_path=capability.staging_path(),
        retain_until=(
            capability.expires_at
            + _STAGED_RETENTION
            - timedelta(seconds=get_settings().signed_url_expiry_s)
        ),
    )


def _owned_session_for_update(
    db: Session, viewer_id: UUID, origin_kind: InputOriginKind | None, session_handle: str
) -> MediaUploadSession:
    """The one session loader: the viewer's own session, row-locked, of the caller's
    provenance when the caller has one (``None`` admits either origin). Anything
    else, including another origin's session, is not found."""
    query = select(MediaUploadSession).where(
        MediaUploadSession.id == unseal_upload_session(session_handle),
        MediaUploadSession.created_by_user_id == viewer_id,
    )
    if origin_kind is not None:
        query = query.where(MediaUploadSession.input_origin["kind"].astext == origin_kind)
    session = db.execute(
        query.with_for_update().execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if session is None:
        raise NotFoundError(ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND, "Upload session not found.")
    return session


def _destinations(db: Session, session_id: UUID) -> tuple[UUID, ...]:
    return tuple(
        db.execute(
            select(MediaUploadSessionDestination.library_id)
            .where(MediaUploadSessionDestination.upload_session_id == session_id)
            .order_by(MediaUploadSessionDestination.library_id)
        ).scalars()
    )


def _record_event(
    db: Session,
    session_id: UUID,
    facts: UploadFacts,
    *,
    stage: Literal["Upload", "Validate"],
    failure_code: Presence[SafeFailureCode] | None = None,
) -> None:
    append_upload_event(
        db,
        session_id=session_id,
        facts=facts,
        stage=present(stage),
        failure_code=absent() if failure_code is None else failure_code,
    )


def _normalize_intent(
    request: CreateUploadSessionRequest | BrowserCaptureIntent,
    input_origin: LocalFile | BrowserCapture,
) -> _Intent:
    kind = cast(Literal["pdf", "epub", "web_article"], request.kind.lower())
    content_type = _normalize_content_type(request.content_type)
    if kind == "web_article":
        if not isinstance(input_origin, BrowserCapture) or content_type != "application/json":
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Article packets are browser captures."
            )
        if request.size_bytes > ARTICLE_PACKET_MAX_BYTES:
            raise InvalidRequestError(
                ApiErrorCode.E_CAPTURE_TOO_LARGE, "Article packet exceeds the packet-size limit."
            )
    else:
        try:
            validate_file_ingest_request(kind, content_type, request.size_bytes)
        except InvalidRequestError as exc:
            # The shared validator reports kind/content-type rejections with its
            # own codes; this surface declares E_INVALID_FILE_TYPE.
            if exc.code is ApiErrorCode.E_FILE_TOO_LARGE:
                raise
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_FILE_TYPE, "Upload intent has an unsupported document type."
            ) from exc
    return _Intent(
        kind=kind,
        filename=_normalize_filename(request.filename),
        content_type=content_type,
        size_bytes=request.size_bytes,
        library_ids=tuple(sorted(set(request.library_ids))),
        input_origin=input_origin,
    )


def _normalize_filename(filename: str) -> str:
    clean = filename.strip().replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not clean or len(clean) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid upload filename.")
    return clean


def _normalize_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _require_key(value: str | None, label: str) -> str:
    clean = (value or "").strip()
    if not clean:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"{label} is required.")
    if len(clean) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"{label} is too long.")
    return clean


def _storage_error(exc: StorageError) -> ApiError:
    if exc.code == ApiErrorCode.E_STORAGE_MISSING.value:
        return InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING, "Uploaded source is missing from storage."
        )
    return ApiError(ApiErrorCode.E_STORAGE_ERROR, "Uploaded source storage is unavailable.")


def _db_now(db: Session) -> datetime:
    return db.execute(select(func.now())).scalar_one()
