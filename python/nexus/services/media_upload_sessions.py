"""Durable upload-session lifecycle and atomic media publication owner."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Literal, cast, get_args
from uuid import UUID, uuid5

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

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
from nexus.storage.client import StorageClient, StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
    get_file_extension,
)
from nexus.tasks.storage_object_cleanup import (
    StoragePathCleanupInFlight,
    finalize_upload_session_storage_object_write,
    reserve_upload_session_storage_object_write_in_current_transaction,
)

logger = get_logger(__name__)

_STAGED_RETENTION = timedelta(hours=24)
_CANDIDATE_NAMESPACE = UUID("6b8f6f6a-1c3f-4a84-9f2f-2b0f8c9a4d11")
_TERMINAL_VERIFICATION_CODES: frozenset[str] = frozenset(get_args(UploadVerificationFailureCode))

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
    kind: Literal["pdf", "epub"]
    filename: str
    content_type: str
    size_bytes: int
    library_ids: tuple[UUID, ...]


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
            self.session_id, self.generation, get_file_extension(self.kind)
        )


@dataclass(frozen=True, slots=True)
class _MeasuredSource:
    size_bytes: int
    sha256: str


# =============================================================================
# Create
# =============================================================================


def create_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    request: CreateUploadSessionRequest,
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
    intent = _normalize_intent(request)
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
            if (
                session.kind,
                session.filename,
                session.content_type,
                session.expected_size_bytes,
                _destinations(db, session.id),
            ) != (
                intent.kind,
                intent.filename,
                intent.content_type,
                intent.size_bytes,
                intent.library_ids,
            ):
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
# Transport failure and retry
# =============================================================================


def record_transport_failure(
    db: Session, *, viewer_id: UUID, session_handle: str, failure: UploadTransportFailureRequest
) -> None:
    """Record a browser phase report. Telemetry the caller can never be refused."""
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
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
        session = _owned_session_for_update(db, viewer_id, session_handle)
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
    if admitted.expires_at <= now:
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
    session_handle: str,
    generation: int,
    request_id: str | None,
    storage_client: StorageClient | None = None,
) -> Published:
    """Measure the staged object, copy it to its candidate path, and publish.

    Publication is the ``published_at`` write under the session row lock, so a
    concurrent confirm blocks on that lock and converges on the same
    ``Published`` rather than creating a second media.
    """
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
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
        session_id = session.id
        candidate_media_id = session.candidate_media_id
        kind = session.kind
        content_type = session.content_type
        expected_size_bytes = session.expected_size_bytes

    client = storage_client or get_storage_client()
    extension = get_file_extension(kind)
    staging_path = build_upload_session_staging_storage_path(session_id, generation, extension)
    # The candidate path is generation-derived, so a retried confirm reuses the
    # same object and never leaves a second orphan behind.
    candidate_path = build_upload_verification_candidate_storage_path(
        candidate_media_id, uuid5(_CANDIDATE_NAMESPACE, f"{session_id}:{generation}"), extension
    )
    logger.info(
        "ConfirmStarted",
        upload_session_id=str(session_id),
        generation=generation,
        request_id=request_id,
    )
    try:
        measured = _measure_source(
            client,
            storage_path=staging_path,
            kind=kind,
            expected_content_type=content_type,
            expected_size_bytes=expected_size_bytes,
        )
        _reserve_candidate_bytes(db, session_id=session_id, candidate_path=candidate_path)
        try:
            client.copy_object(staging_path, candidate_path)
        except StorageError as exc:
            raise _storage_error(exc) from exc
    except ApiError as exc:
        if exc.code.value in _TERMINAL_VERIFICATION_CODES:
            _record_terminal_verification_failure(db, session_id=session_id, error_code=exc.code)
        logger.info(
            "ConfirmFailed",
            upload_session_id=str(session_id),
            generation=generation,
            request_id=request_id,
            error_code=exc.code.value,
        )
        raise

    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
        now = _db_now(db)
        if session.published_at is not None:
            return _published(session, "Reused")
        if generation != session.upload_generation:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_GENERATION_STALE,
                "Upload generation is no longer current.",
            )
        destination_ids = list(_destinations(db, session.id))
        library_governance.validate_writable_library_destinations(db, viewer_id, destination_ids)
        media = Media(
            id=candidate_media_id,
            kind=kind,
            title=session.filename,
            processing_status=ProcessingStatus.pending,
            created_by_user_id=viewer_id,
            created_at=now,
            updated_at=now,
        )
        db.add(media)
        db.add(
            MediaFile(
                media_id=candidate_media_id,
                storage_path=candidate_path,
                content_type=content_type,
                size_bytes=measured.size_bytes,
                source_sha256=measured.sha256,
            )
        )
        db.flush()
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, candidate_media_id, destination_ids
        )
        attempt = media_source_ingest.create_attempt(
            db,
            media=media,
            viewer_id=viewer_id,
            source_type=f"uploaded_{kind}_file",
            intent_key=f"upload_session:{session.id}",
            requested_url=None,
            canonical_source_url=None,
            provider=None,
            provider_target_ref=None,
            source_payload={
                "filename": session.filename,
                "content_type": content_type,
                "size_bytes": measured.size_bytes,
                "source_sha256": measured.sha256,
                "storage_path": candidate_path,
                "library_ids": [str(value) for value in destination_ids],
            },
            request_id=request_id,
            idempotency_key=None,
            status="accepted",
        )
        mark_source_queued(db, media)
        media_source_ingest.enqueue_accepted_source_attempt_in_transaction(
            db,
            media_id=candidate_media_id,
            attempt_id=attempt.id,
            actor_user_id=viewer_id,
            request_id=request_id,
        )
        session.published_media_id = candidate_media_id
        session.published_source_attempt_id = attempt.id
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
                media_id=candidate_media_id,
                source_attempt_id=attempt.id,
            ),
            stage="Upload",
        )
        published_attempt_id = attempt.id

    finalize_upload_session_storage_object_write(
        db, upload_session_id=session_id, storage_path=candidate_path, storage_client=client
    )
    try:
        client.delete_object(staging_path)
    # justify-ignore-error: the staged object carries its own 24-hour cleanup
    # reservation, so a failed opportunistic delete only defers reclamation.
    except StorageError:
        logger.warning(
            "upload_staging_delete_failed",
            upload_session_id=str(session_id),
            generation=generation,
        )
    logger.info(
        "Published",
        upload_session_id=str(session_id),
        generation=generation,
        request_id=request_id,
        media_id=str(candidate_media_id),
        source_attempt_id=str(published_attempt_id),
    )
    return Published(
        session_handle=seal_upload_session(session_id),
        media_id=candidate_media_id,
        source_attempt_id=published_attempt_id,
        idempotency_outcome="Created",
    )


def _measure_source(
    storage_client: StorageClient,
    *,
    storage_path: str,
    kind: str,
    expected_content_type: str,
    expected_size_bytes: int,
) -> _MeasuredSource:
    """Head, then stream the staged object: size, content type, magic bytes, sha256."""
    try:
        metadata = storage_client.head_object(storage_path)
    except StorageError as exc:
        raise _storage_error(exc) from exc
    if metadata is None:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING, "Uploaded source is missing from storage."
        )
    max_bytes = get_settings().max_pdf_bytes if kind == "pdf" else get_settings().max_epub_bytes
    if metadata.size_bytes > max_bytes:
        raise InvalidRequestError(
            ApiErrorCode.E_FILE_TOO_LARGE, "Uploaded source exceeds the file-size limit."
        )
    if metadata.size_bytes != expected_size_bytes:
        raise InvalidRequestError(
            ApiErrorCode.E_SOURCE_INTEGRITY, "Uploaded source size does not match its intent."
        )
    if _normalize_content_type(metadata.content_type) != expected_content_type:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source has an invalid content type."
        )
    digest = hashlib.sha256()
    prefix = bytearray()
    measured = 0
    try:
        for chunk in storage_client.stream_object(storage_path):
            if len(prefix) < 5:
                prefix.extend(chunk[: 5 - len(prefix)])
            measured += len(chunk)
            if measured > max_bytes:
                raise InvalidRequestError(
                    ApiErrorCode.E_FILE_TOO_LARGE, "Uploaded source exceeds the file-size limit."
                )
            digest.update(chunk)
    except StorageError as exc:
        raise _storage_error(exc) from exc
    if measured != expected_size_bytes:
        raise InvalidRequestError(
            ApiErrorCode.E_SOURCE_INTEGRITY, "Uploaded source changed while being verified."
        )
    if not has_valid_file_signature(bytes(prefix), kind):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE, "Uploaded source has an invalid file signature."
        )
    return _MeasuredSource(size_bytes=measured, sha256=digest.hexdigest())


def _record_terminal_verification_failure(
    db: Session, *, session_id: UUID, error_code: ApiErrorCode
) -> None:
    """A deterministic rejection settles the session: only removal remains."""
    with transaction(db):
        session = db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if session is None or session.published_at is not None:
            return
        now = _db_now(db)
        _record_event(
            db,
            session.id,
            UploadFailed(generation=session.upload_generation, transport=absent()),
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


def delete_upload_session(db: Session, *, viewer_id: UUID, session_handle: str) -> None:
    """Remove an unpublished session, handing every staged generation to the sweeper."""
    session_id = unseal_upload_session(session_handle)
    with transaction(db):
        session = db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if session is None:
            return
        if session.created_by_user_id != viewer_id:
            raise NotFoundError(
                ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND, "Upload session not found."
            )
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
                        session.id, generation, get_file_extension(session.kind)
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
    """Remove published upload support before its media and source attempt."""
    session_id = db.execute(
        select(MediaUploadSession.id)
        .where(MediaUploadSession.published_media_id == media_id)
        .with_for_update()
    ).scalar_one_or_none()
    if session_id is None:
        return
    db.execute(
        delete(MediaUploadSessionDestination).where(
            MediaUploadSessionDestination.upload_session_id == session_id
        )
    )
    delete_upload_history_in_current_transaction(db, session_id=session_id)
    db.execute(delete(MediaUploadSession).where(MediaUploadSession.id == session_id))


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
    db: Session, viewer_id: UUID, session_handle: str
) -> MediaUploadSession:
    session = db.execute(
        select(MediaUploadSession)
        .where(
            MediaUploadSession.id == unseal_upload_session(session_handle),
            MediaUploadSession.created_by_user_id == viewer_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
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


def _normalize_intent(request: CreateUploadSessionRequest) -> _Intent:
    kind = cast(Literal["pdf", "epub"], request.kind.lower())
    content_type = _normalize_content_type(request.content_type)
    try:
        validate_file_ingest_request(kind, content_type, request.size_bytes)
    except InvalidRequestError as exc:
        # The shared validator reports kind/content-type rejections with the
        # direct-capture codes; this surface declares E_INVALID_FILE_TYPE.
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
