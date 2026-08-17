"""Durable upload-session lifecycle and atomic media publication owner."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, cast
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
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.logging import get_logger
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
    UploadSessionFailure,
    UploadSessionResponse,
    UploadTransportAbortedFailure,
    UploadTransportFailureRequest,
    UploadTransportHttpRejectedFailure,
    UploadTransportNetworkFailure,
    UploadTransportTimeoutFailure,
    VerificationFailed,
)
from nexus.services import library_entries, library_governance, media_source_ingest
from nexus.services.file_ingest_validation import (
    has_valid_file_signature,
    validate_file_ingest_request,
)
from nexus.services.media_processing_state import mark_source_queued
from nexus.services.sealed_handles import (
    UploadSessionHandle,
    seal_upload_session_handle,
    unseal_upload_session_handle,
)
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
    get_file_extension,
)
from nexus.tasks.storage_object_cleanup import (
    finalize_upload_session_storage_object_write,
    reserve_upload_session_storage_object_write,
    reserve_upload_session_storage_object_write_in_current_transaction,
)

logger = get_logger(__name__)

_STAGED_RETENTION = timedelta(hours=24)
_VERIFICATION_LEASE = timedelta(minutes=5)
_TERMINAL_VERIFICATION_CODES = frozenset(
    {
        ApiErrorCode.E_SOURCE_INTEGRITY.value,
        ApiErrorCode.E_INVALID_FILE_TYPE.value,
        ApiErrorCode.E_FILE_TOO_LARGE.value,
    }
)


@dataclass(frozen=True, slots=True)
class UploadSessionOwnerProjection:
    """Narrow Activity-facing projection of one unresolved upload obligation."""

    session_id: UUID
    session_handle: UploadSessionHandle
    filename: str
    kind: Literal["Pdf", "Epub"]
    expected_size_bytes: int
    state: Literal["VerificationFailed", "TransportFailed", "CapabilityExpired"]
    attention_at: datetime
    failure: UploadSessionFailure
    capabilities: UploadSessionCapabilities
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class _NormalizedIntent:
    kind: Literal["pdf", "epub"]
    filename: str
    content_type: str
    size_bytes: int
    library_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class _MeasuredSource:
    size_bytes: int
    sha256: str


def _db_now(db: Session) -> datetime:
    return db.execute(select(func.now())).scalar_one()


def _normalize_filename(filename: str) -> str:
    clean = filename.strip().replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not clean or len(clean) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid upload filename.")
    return clean


def _normalize_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _normalize_intent(request: CreateUploadSessionRequest) -> _NormalizedIntent:
    kind = cast(Literal["pdf", "epub"], request.kind.lower())
    content_type = _normalize_content_type(request.content_type)
    validate_file_ingest_request(kind, content_type, request.size_bytes)
    return _NormalizedIntent(
        kind=kind,
        filename=_normalize_filename(request.filename),
        content_type=content_type,
        size_bytes=request.size_bytes,
        library_ids=tuple(sorted(set(request.library_ids))),
    )


def _clean_idempotency_key(value: str | None) -> str:
    clean = (value or "").strip()
    if not clean:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required.")
    if len(clean) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long.")
    return clean


def _clean_request_id(value: str | None) -> str:
    clean = (value or "").strip()
    if not clean:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Request ID is required.")
    return clean[:255]


def _lock_idempotency_key(db: Session, viewer_id: UUID, idempotency_key: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"media_upload:{viewer_id}:{idempotency_key}"},
    )


def _session_destinations(db: Session, session_id: UUID) -> tuple[UUID, ...]:
    return tuple(
        db.execute(
            select(MediaUploadSessionDestination.library_id)
            .where(MediaUploadSessionDestination.upload_session_id == session_id)
            .order_by(MediaUploadSessionDestination.library_id)
        ).scalars()
    )


def _assert_valid_persisted_state(session: MediaUploadSession) -> None:
    lease = (
        session.verification_token,
        session.verification_generation,
        session.verification_expires_at,
    )
    if any(value is None for value in lease) != all(value is None for value in lease):
        # justify-service-invariant-check: upload state is intentionally stored as
        # orthogonal nullable facts rather than a database status/check constraint.
        raise AssertionError("partial upload verification lease")
    publication = (
        session.published_media_id,
        session.published_source_attempt_id,
        session.published_at,
    )
    if any(value is None for value in publication) != all(value is None for value in publication):
        # justify-service-invariant-check: publication facts must become visible atomically.
        raise AssertionError("partial upload publication fact")
    if (session.transport_failure_kind is None) != (session.transport_failed_at is None):
        # justify-service-invariant-check: transport kind and occurrence time are one fact.
        raise AssertionError("partial upload transport failure fact")
    if session.transport_failure_kind == "HttpRejected":
        if session.transport_http_status is None:
            raise AssertionError("HTTP upload rejection has no status")
    elif session.transport_http_status is not None:
        raise AssertionError("non-HTTP upload failure has an HTTP status")
    if (session.verification_error_code is None) != (session.verification_failed_at is None):
        # justify-service-invariant-check: verification code and occurrence time are one fact.
        raise AssertionError("partial upload verification failure fact")
    if (
        session.verification_error_code is not None
        and session.verification_error_code not in _TERMINAL_VERIFICATION_CODES
    ):
        raise AssertionError("unknown terminal upload verification code")
    if session.verification_error_code is not None and session.verification_token is not None:
        raise AssertionError("terminal upload verification retains a live lease")
    if session.verification_error_code is not None and session.transport_failure_kind is not None:
        raise AssertionError("terminal upload verification retains a transport failure")
    if session.verification_generation not in {None, session.upload_generation}:
        raise AssertionError("upload verification lease belongs to another generation")
    if session.published_at is not None and (
        session.verification_token is not None
        or session.transport_failed_at is not None
        or session.verification_failed_at is not None
    ):
        raise AssertionError("published upload retains unresolved facts")


def _owned_session_for_update(
    db: Session, viewer_id: UUID, session_handle: str
) -> MediaUploadSession:
    session_id = unseal_upload_session_handle(session_handle)
    session = db.execute(
        select(MediaUploadSession)
        .where(
            MediaUploadSession.id == session_id,
            MediaUploadSession.created_by_user_id == viewer_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if session is None:
        raise NotFoundError(ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND, "Upload session not found.")
    _assert_valid_persisted_state(session)
    return session


def _published(session: MediaUploadSession, outcome: Literal["Created", "Reused"]) -> Published:
    if session.published_media_id is None or session.published_source_attempt_id is None:
        raise AssertionError("published response requested for unpublished upload")
    return Published(
        session_handle=seal_upload_session_handle(session.id),
        media_id=session.published_media_id,
        source_attempt_id=session.published_source_attempt_id,
        idempotency_outcome=outcome,
    )


def _transport_failure(session: MediaUploadSession) -> TransportFailed:
    if session.transport_failed_at is None:
        raise AssertionError("transport failure projection has no timestamp")
    if session.transport_failure_kind == "Network":
        reason = UploadTransportNetworkFailure()
    elif session.transport_failure_kind == "Timeout":
        reason = UploadTransportTimeoutFailure()
    elif session.transport_failure_kind == "HttpRejected":
        if session.transport_http_status is None:
            raise AssertionError("HTTP upload rejection has no status")
        reason = UploadTransportHttpRejectedFailure(status=session.transport_http_status)
    elif session.transport_failure_kind == "Aborted":
        reason = UploadTransportAbortedFailure()
    else:
        raise AssertionError("unknown transport failure kind")
    return TransportFailed(reason=reason, failed_at=session.transport_failed_at)


def _needs_attention(session: MediaUploadSession, now: datetime) -> NeedsAttention | None:
    _assert_valid_persisted_state(session)
    capabilities = UploadSessionCapabilities(can_retry_upload=True, can_remove=True)
    if session.verification_error_code is not None:
        if session.verification_failed_at is None:
            raise AssertionError("terminal verification has no timestamp")
        return NeedsAttention(
            session_handle=seal_upload_session_handle(session.id),
            failure=VerificationFailed(
                code=cast(
                    Literal["E_SOURCE_INTEGRITY", "E_INVALID_FILE_TYPE", "E_FILE_TOO_LARGE"],
                    session.verification_error_code,
                ),
                failed_at=session.verification_failed_at,
            ),
            capabilities=UploadSessionCapabilities(can_retry_upload=False, can_remove=True),
        )
    if session.verification_token is not None and session.verification_expires_at is not None:
        if session.verification_expires_at > now:
            return None
    if session.transport_failed_at is not None:
        return NeedsAttention(
            session_handle=seal_upload_session_handle(session.id),
            failure=_transport_failure(session),
            capabilities=capabilities,
        )
    if session.upload_url_expires_at <= now:
        return NeedsAttention(
            session_handle=seal_upload_session_handle(session.id),
            failure=CapabilityExpired(expired_at=session.upload_url_expires_at),
            capabilities=capabilities,
        )
    return None


def _advance_generation(session: MediaUploadSession, now: datetime) -> None:
    session.upload_generation += 1
    session.upload_url_expires_at = now + timedelta(seconds=get_settings().signed_url_expiry_s)
    session.verification_token = None
    session.verification_generation = None
    session.verification_expires_at = None
    session.transport_failure_kind = None
    session.transport_http_status = None
    session.transport_failed_at = None
    session.updated_at = now


def _upload_required(
    db: Session,
    session: MediaUploadSession,
    *,
    outcome: Literal["Created", "Reused"],
    storage_client: StorageClientBase,
) -> UploadRequired:
    path = build_upload_session_staging_storage_path(
        session.id,
        session.upload_generation,
        get_file_extension(session.kind),
    )
    retain_until = (
        session.upload_url_expires_at
        + _STAGED_RETENTION
        - timedelta(seconds=get_settings().signed_url_expiry_s)
    )
    reserve_upload_session_storage_object_write(
        db,
        upload_session_id=session.id,
        storage_path=path,
        retain_until=retain_until,
    )
    try:
        signed = storage_client.sign_upload(
            path,
            content_type=session.content_type,
            size_bytes=session.expected_size_bytes,
            expires_in=get_settings().signed_url_expiry_s,
        )
    except StorageError as exc:
        raise ApiError(ApiErrorCode.E_SIGN_UPLOAD_FAILED, "Failed to initialize upload.") from exc
    return UploadRequired(
        session_handle=seal_upload_session_handle(session.id),
        generation=session.upload_generation,
        upload_url=signed.upload_url,
        required_headers=UploadRequiredHeaders.model_validate(
            {"Content-Type": session.content_type}
        ),
        expires_at=session.upload_url_expires_at,
        idempotency_outcome=outcome,
    )


def create_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    request: CreateUploadSessionRequest,
    request_id: str | None,
    idempotency_key: str | None,
    storage_client: StorageClientBase | None = None,
) -> UploadSessionResponse:
    intent = _normalize_intent(request)
    clean_key = _clean_idempotency_key(idempotency_key)
    clean_request_id = _clean_request_id(request_id)
    created = False
    with transaction(db):
        _lock_idempotency_key(db, viewer_id, clean_key)
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
                    upload_session_id=session.id,
                    library_id=library_id,
                    created_at=now,
                )
                for library_id in intent.library_ids
            )
            created = True
        else:
            _assert_valid_persisted_state(session)
            matches = (
                session.kind == intent.kind
                and session.filename == intent.filename
                and session.content_type == intent.content_type
                and session.expected_size_bytes == intent.size_bytes
                and _session_destinations(db, session.id) == intent.library_ids
            )
            if not matches:
                raise ConflictError(
                    ApiErrorCode.E_IDEMPOTENCY_CONFLICT,
                    "Idempotency key was reused for a different upload intent.",
                )
            if session.published_at is not None:
                return _published(session, "Reused")
            attention = _needs_attention(session, now)
            if session.verification_error_code is not None:
                if attention is None:
                    raise AssertionError("terminal upload has no attention projection")
                return attention
            if (
                session.verification_token is not None
                and session.verification_expires_at is not None
            ):
                if session.verification_expires_at > now:
                    raise ConflictError(
                        ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS,
                        "Upload verification is already in progress.",
                    )
                session.verification_token = None
                session.verification_generation = None
                session.verification_expires_at = None
            if session.transport_failed_at is not None or session.upload_url_expires_at <= now:
                _advance_generation(session, now)
            else:
                session.upload_url_expires_at = now + timedelta(
                    seconds=get_settings().signed_url_expiry_s
                )
                session.updated_at = now
    logger.info(
        "IntentAccepted",
        upload_session_id=str(session.id),
        generation=session.upload_generation,
        request_id=clean_request_id,
    )
    return _upload_required(
        db,
        session,
        outcome="Created" if created else "Reused",
        storage_client=storage_client or get_storage_client(),
    )


def record_transport_failure(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
    failure: UploadTransportFailureRequest,
) -> None:
    stale_generation = False
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
        if failure.generation != session.upload_generation:
            stale_generation = True
        elif session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
        else:
            now = _db_now(db)
            session.transport_failure_kind = failure.kind
            session.transport_http_status = (
                failure.status if isinstance(failure, UploadHttpRejectedFailureRequest) else None
            )
            session.transport_failed_at = now
            session.updated_at = now
    logger.info(
        "PutFailed",
        upload_session_id=str(session.id),
        generation=failure.generation,
        current_generation=session.upload_generation,
        stale_generation=stale_generation,
        request_id=failure.request_id,
        failure_kind=failure.kind,
        http_status=(
            failure.status if isinstance(failure, UploadHttpRejectedFailureRequest) else None
        ),
        duration_ms=failure.duration_ms,
    )


def retry_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
    request: RetryUploadSessionRequest,
    storage_client: StorageClientBase | None = None,
) -> UploadRequired:
    filename = _normalize_filename(request.filename)
    content_type = _normalize_content_type(request.content_type)
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
        validate_file_ingest_request(session.kind, content_type, request.size_bytes)
        if session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
        if session.verification_error_code is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_INTENT_MISMATCH,
                "A rejected upload session cannot be retried.",
            )
        if (
            filename != session.filename
            or content_type != session.content_type
            or request.size_bytes != session.expected_size_bytes
        ):
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_INTENT_MISMATCH,
                "Retry request does not match the upload intent.",
            )
        now = _db_now(db)
        _advance_generation(session, now)
    return _upload_required(
        db,
        session,
        outcome="Reused",
        storage_client=storage_client or get_storage_client(),
    )


def _storage_error(exc: StorageError) -> ApiError:
    if exc.code == ApiErrorCode.E_STORAGE_MISSING.value:
        return InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING, "Uploaded source is missing from storage."
        )
    return ApiError(ApiErrorCode.E_STORAGE_ERROR, "Uploaded source storage is unavailable.")


def _measure_source(
    storage_client: StorageClientBase,
    *,
    storage_path: str,
    kind: str,
    expected_content_type: str,
    expected_size_bytes: int,
) -> _MeasuredSource:
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
                    ApiErrorCode.E_FILE_TOO_LARGE,
                    "Uploaded source exceeds the file-size limit.",
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


def _clear_verification_lease(db: Session, session_id: UUID, token: UUID) -> None:
    with transaction(db):
        session = db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if session is not None and session.verification_token == token:
            session.verification_token = None
            session.verification_generation = None
            session.verification_expires_at = None
            session.updated_at = _db_now(db)


def _record_terminal_verification_failure(
    db: Session,
    *,
    session_id: UUID,
    token: UUID,
    error_code: ApiErrorCode,
) -> None:
    if error_code.value not in _TERMINAL_VERIFICATION_CODES:
        raise AssertionError("transient upload failure cannot become terminal")
    with transaction(db):
        session = db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if session is not None and session.verification_token == token:
            now = _db_now(db)
            session.verification_error_code = error_code.value
            session.verification_failed_at = now
            session.verification_token = None
            session.verification_generation = None
            session.verification_expires_at = None
            session.transport_failure_kind = None
            session.transport_http_status = None
            session.transport_failed_at = None
            session.updated_at = now


def _claim_verification(
    db: Session, *, viewer_id: UUID, session_handle: str, generation: int
) -> tuple[UUID, UUID, str, str, int, UUID, datetime]:
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
        if session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
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
        now = _db_now(db)
        if (
            session.verification_token is not None
            and session.verification_expires_at is not None
            and session.verification_expires_at > now
        ):
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS,
                "Upload verification is already in progress.",
            )
        token = new_uuid7()
        lease_expires_at = now + _VERIFICATION_LEASE
        session.verification_token = token
        session.verification_generation = generation
        session.verification_expires_at = lease_expires_at
        session.updated_at = now
    return (
        session.id,
        session.candidate_media_id,
        session.kind,
        session.content_type,
        session.expected_size_bytes,
        token,
        lease_expires_at,
    )


def confirm_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
    generation: int,
    request_id: str | None,
    storage_client: StorageClientBase | None = None,
) -> Published:
    try:
        session_id = unseal_upload_session_handle(session_handle)
    except InvalidRequestError:
        raise
    existing = db.execute(
        select(MediaUploadSession)
        .where(
            MediaUploadSession.id == session_id,
            MediaUploadSession.created_by_user_id == viewer_id,
        )
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if existing is not None and existing.published_at is not None:
        _assert_valid_persisted_state(existing)
        db.rollback()
        return _published(existing, "Reused")
    db.rollback()
    (
        session_id,
        candidate_media_id,
        kind,
        content_type,
        expected_size_bytes,
        token,
        lease_expires_at,
    ) = _claim_verification(
        db,
        viewer_id=viewer_id,
        session_handle=session_handle,
        generation=generation,
    )
    logger.info(
        "ConfirmStarted",
        upload_session_id=str(session_id),
        generation=generation,
        request_id=request_id,
    )
    client = storage_client or get_storage_client()
    staging_path = build_upload_session_staging_storage_path(
        session_id, generation, get_file_extension(kind)
    )
    candidate_path = build_upload_verification_candidate_storage_path(
        candidate_media_id,
        token,
        get_file_extension(kind),
    )
    try:
        staged = _measure_source(
            client,
            storage_path=staging_path,
            kind=kind,
            expected_content_type=content_type,
            expected_size_bytes=expected_size_bytes,
        )
        reserve_upload_session_storage_object_write(
            db,
            upload_session_id=session_id,
            storage_path=candidate_path,
            retain_until=lease_expires_at,
        )
        client.copy_object(staging_path, candidate_path)
        candidate = _measure_source(
            client,
            storage_path=candidate_path,
            kind=kind,
            expected_content_type=content_type,
            expected_size_bytes=expected_size_bytes,
        )
        if candidate.sha256 != staged.sha256:
            raise InvalidRequestError(
                ApiErrorCode.E_SOURCE_INTEGRITY,
                "Published source does not match the verified upload.",
            )
    except ApiError as exc:
        if exc.code.value in _TERMINAL_VERIFICATION_CODES:
            _record_terminal_verification_failure(
                db, session_id=session_id, token=token, error_code=exc.code
            )
        else:
            _clear_verification_lease(db, session_id, token)
        logger.info(
            "ConfirmFailed",
            upload_session_id=str(session_id),
            generation=generation,
            request_id=request_id,
            error_code=exc.code.value,
        )
        raise
    except StorageError as exc:
        _clear_verification_lease(db, session_id, token)
        error = _storage_error(exc)
        logger.info(
            "ConfirmFailed",
            upload_session_id=str(session_id),
            generation=generation,
            request_id=request_id,
            error_code=error.code.value,
        )
        raise error from exc

    try:
        with transaction(db):
            session = _owned_session_for_update(db, viewer_id, session_handle)
            now = _db_now(db)
            if session.published_at is not None:
                return _published(session, "Reused")
            if (
                session.upload_generation != generation
                or session.verification_token != token
                or session.verification_generation != generation
                or session.verification_expires_at is None
                or session.verification_expires_at <= now
                or session.kind != kind
                or session.content_type != content_type
                or session.expected_size_bytes != expected_size_bytes
                or session.candidate_media_id != candidate_media_id
            ):
                raise ConflictError(
                    ApiErrorCode.E_UPLOAD_GENERATION_STALE,
                    "Upload verification lease is no longer current.",
                )
            destination_ids = list(_session_destinations(db, session.id))
            library_governance.validate_writable_library_destinations(
                db, viewer_id, destination_ids
            )
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
                    size_bytes=candidate.size_bytes,
                    source_sha256=candidate.sha256,
                )
            )
            db.flush()
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, candidate_media_id, destination_ids
            )
            source_type = f"uploaded_{kind}_file"
            attempt = media_source_ingest.create_attempt(
                db,
                media=media,
                viewer_id=viewer_id,
                source_type=source_type,
                intent_key=f"upload_session:{session.id}",
                requested_url=None,
                canonical_source_url=None,
                provider=None,
                provider_target_ref=None,
                source_payload={
                    "filename": session.filename,
                    "content_type": content_type,
                    "size_bytes": candidate.size_bytes,
                    "source_sha256": candidate.sha256,
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
            session.verification_token = None
            session.verification_generation = None
            session.verification_expires_at = None
            session.transport_failure_kind = None
            session.transport_http_status = None
            session.transport_failed_at = None
            session.verification_error_code = None
            session.verification_failed_at = None
            session.updated_at = now
    except Exception:
        _clear_verification_lease(db, session_id, token)
        raise

    finalize_upload_session_storage_object_write(
        db,
        upload_session_id=session_id,
        storage_path=candidate_path,
        storage_client=client,
    )
    try:
        client.delete_object(staging_path)
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
        source_attempt_id=str(attempt.id),
    )
    return Published(
        session_handle=seal_upload_session_handle(session_id),
        media_id=candidate_media_id,
        source_attempt_id=attempt.id,
        idempotency_outcome="Created",
    )


def delete_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
) -> None:
    session_id = unseal_upload_session_handle(session_handle)
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
        _assert_valid_persisted_state(session)
        if session.published_at is not None:
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_ALREADY_PUBLISHED, "Upload is already published."
            )
        now = _db_now(db)
        write_margin = timedelta(seconds=get_settings().storage_object_cleanup_write_window_seconds)
        delete_not_before = max(now, session.upload_url_expires_at) + write_margin
        for generation in range(1, session.upload_generation + 1):
            reserve_upload_session_storage_object_write_in_current_transaction(
                db,
                upload_session_id=session.id,
                storage_path=build_upload_session_staging_storage_path(
                    session.id, generation, get_file_extension(session.kind)
                ),
                retain_until=delete_not_before,
            )
        db.execute(
            delete(MediaUploadSessionDestination).where(
                MediaUploadSessionDestination.upload_session_id == session.id
            )
        )
        db.delete(session)


def delete_library_destination_support_in_current_transaction(
    db: Session,
    *,
    library_id: UUID,
) -> None:
    """Remove upload-intent references to a library being deleted by its owner."""
    db.execute(
        delete(MediaUploadSessionDestination).where(
            MediaUploadSessionDestination.library_id == library_id
        )
    )


def delete_published_media_support_in_current_transaction(
    db: Session,
    *,
    media_id: UUID,
) -> None:
    """Remove published upload support before its media and source attempt."""
    sessions = list(
        db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.published_media_id == media_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalars()
    )
    if len(sessions) > 1:
        raise AssertionError("media has multiple published upload support rows")
    if not sessions:
        return
    session = sessions[0]
    _assert_valid_persisted_state(session)
    if session.published_media_id != media_id:
        raise AssertionError("published upload support points at another media")
    db.execute(
        delete(MediaUploadSessionDestination).where(
            MediaUploadSessionDestination.upload_session_id == session.id
        )
    )
    deleted_ids = list(
        db.execute(
            delete(MediaUploadSession)
            .where(MediaUploadSession.id == session.id)
            .returning(MediaUploadSession.id)
        ).scalars()
    )
    if deleted_ids != [session.id]:
        raise AssertionError("published upload support deletion did not remove its exact row")


def list_viewer_unresolved_upload_sessions(
    db: Session, *, viewer_id: UUID
) -> list[UploadSessionOwnerProjection]:
    now = _db_now(db)
    sessions = db.execute(
        select(MediaUploadSession)
        .where(
            MediaUploadSession.created_by_user_id == viewer_id,
            MediaUploadSession.published_at.is_(None),
        )
        .order_by(MediaUploadSession.created_at, MediaUploadSession.id)
    ).scalars()
    projections: list[UploadSessionOwnerProjection] = []
    for session in sessions:
        attention = _needs_attention(session, now)
        if attention is None:
            continue
        failure = attention.failure
        if isinstance(failure, VerificationFailed):
            state = "VerificationFailed"
            attention_at = failure.failed_at
        elif isinstance(failure, TransportFailed):
            state = "TransportFailed"
            attention_at = failure.failed_at
        elif isinstance(failure, CapabilityExpired):
            state = "CapabilityExpired"
            attention_at = failure.expired_at
        else:
            raise AssertionError("unknown upload attention projection")
        projections.append(
            UploadSessionOwnerProjection(
                session_id=session.id,
                session_handle=seal_upload_session_handle(session.id),
                filename=session.filename,
                kind=cast(Literal["Pdf", "Epub"], session.kind.title()),
                expected_size_bytes=session.expected_size_bytes,
                state=state,
                attention_at=attention_at,
                failure=failure,
                capabilities=attention.capabilities,
                created_at=session.created_at,
                updated_at=session.updated_at,
            )
        )
    return projections
