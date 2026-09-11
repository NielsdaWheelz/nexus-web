"""Durable upload-session lifecycle and atomic media publication owner."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Literal, assert_never, cast, get_args
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
from nexus.db.retries import admit_serializable
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.logging import get_logger
from nexus.schemas.import_history import (
    SafeFailureCode,
    UploadAccepted,
    UploadExecutionStarted,
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
    UploadSessionFailure,
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
from nexus.services.sealed_handles import (
    UploadSessionHandle,
    seal_upload_session,
    unseal_upload_session,
)
from nexus.storage.client import StorageClientBase, StorageError, get_storage_client
from nexus.storage.paths import (
    build_upload_session_staging_storage_path,
    build_upload_verification_candidate_storage_path,
    get_file_extension,
)
from nexus.tasks.storage_object_cleanup import (
    StoragePathCleanupInFlight,
    finalize_upload_session_storage_object_write,
    reserve_upload_session_storage_object_write,
    reserve_upload_session_storage_object_write_in_current_transaction,
)

logger = get_logger(__name__)

_STAGED_RETENTION = timedelta(hours=24)

_VERIFICATION_LEASE = timedelta(minutes=5)
"""Renewal period of the verification lease, not a budget for the whole confirm.

The verifier extends the lease under the session row lock at every phase
boundary, so this bounds how long a *dead* verifier can fence a session, not how
long a live one may stream. Publication requires the lease token, never a
non-expired lease, so a slow-but-live verifier that nobody stole from publishes.
"""

_TERMINAL_VERIFICATION_CODES: frozenset[str] = frozenset(get_args(UploadVerificationFailureCode))
"""Deterministic rejections recorded on the session, closed by the wire alias."""

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
"""The one set-wise expression of §6's derived-session-state precedence.

``_needs_attention`` is the per-row owner of the same precedence; this expression
is its set-wise twin so a bounded page and an operator aggregate never re-derive
the rule independently. Every consumer selects it over ``media_upload_sessions``
columns only. The two owners are cross-checked at runtime: every row this
expression classifies as an unresolved obligation must also produce an attention
projection in :func:`_needs_attention`.
"""

UPLOAD_SESSION_ATTENTION_STATES = ("VerificationFailed", "TransportFailed", "CapabilityExpired")
"""Derived states that are an unresolved user obligation (spec §4.3)."""

_UNRESOLVED_UPLOAD_SESSION_PAGE_SQL = f"""
    WITH derived AS (
        SELECT
            id,
            {UPLOAD_SESSION_DERIVED_STATE_SQL} AS derived_state,
            CASE {UPLOAD_SESSION_DERIVED_STATE_SQL}
                WHEN 'VerificationFailed' THEN verification_failed_at
                WHEN 'TransportFailed' THEN transport_failed_at
                WHEN 'CapabilityExpired' THEN upload_url_expires_at
            END AS attention_at
        FROM media_upload_sessions
        WHERE created_by_user_id = :viewer_id
    )
    SELECT id, count(*) OVER () AS unresolved_count
    FROM derived
    WHERE derived_state = ANY(CAST(:attention_states AS text[]))
    ORDER BY attention_at, id
    LIMIT :limit
"""


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


def _record_upload_event(
    db: Session,
    session_id: UUID,
    facts: UploadFacts,
    *,
    stage: Literal["Upload", "Validate"],
    failure_code: Presence[SafeFailureCode],
) -> None:
    append_upload_event(
        db, session_id=session_id, facts=facts, stage=present(stage), failure_code=failure_code
    )


def _normalize_filename(filename: str) -> str:
    clean = filename.strip().replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not clean or len(clean) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid upload filename.")
    return clean


def _normalize_content_type(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _validate_upload_intent(kind: str, content_type: str, size_bytes: int) -> None:
    """Validate one upload intent against this surface's declared failure set.

    The shared file-ingest validator owns the single content-type/size table but
    reports kind and content-type rejections with the direct-body capture codes.
    Spec §5 declares ``E_INVALID_FILE_TYPE`` for the upload surface, so that branch
    is consumed here and replaced; the size branch already matches.
    """
    try:
        validate_file_ingest_request(kind, content_type, size_bytes)
    except InvalidRequestError as exc:
        if exc.code is ApiErrorCode.E_FILE_TOO_LARGE:
            raise
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_FILE_TYPE,
            "Upload intent has an unsupported document type.",
        ) from exc


def _normalize_intent(request: CreateUploadSessionRequest) -> _NormalizedIntent:
    kind = cast(Literal["pdf", "epub"], request.kind.lower())
    content_type = _normalize_content_type(request.content_type)
    _validate_upload_intent(kind, content_type, request.size_bytes)
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
    session_id = unseal_upload_session(session_handle)
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
        session_handle=seal_upload_session(session.id),
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
            session_handle=seal_upload_session(session.id),
            failure=VerificationFailed(
                code=cast(UploadVerificationFailureCode, session.verification_error_code),
                failed_at=session.verification_failed_at,
            ),
            capabilities=UploadSessionCapabilities(can_retry_upload=False, can_remove=True),
        )
    if session.verification_token is not None and session.verification_expires_at is not None:
        if session.verification_expires_at > now:
            return None
    if session.transport_failed_at is not None:
        return NeedsAttention(
            session_handle=seal_upload_session(session.id),
            failure=_transport_failure(session),
            capabilities=capabilities,
        )
    if session.upload_url_expires_at <= now:
        return _capability_expired(session.id, session.upload_url_expires_at)
    return None


def _capability_expired(session_id: UUID, expired_at: datetime) -> NeedsAttention:
    return NeedsAttention(
        session_handle=seal_upload_session(session_id),
        failure=CapabilityExpired(expired_at=expired_at),
        capabilities=UploadSessionCapabilities(can_retry_upload=True, can_remove=True),
    )


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


@dataclass(frozen=True, slots=True)
class _UploadCapability:
    """One generation's immutable upload facts, carried out of the transaction
    that admitted it so the capability is minted with no transaction open."""

    session_id: UUID
    generation: int
    kind: str
    content_type: str
    expected_size_bytes: int
    expires_at: datetime

    @classmethod
    def of(cls, session: MediaUploadSession) -> _UploadCapability:
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


def _reserve_staged_bytes_in_current_transaction(
    db: Session, capability: _UploadCapability
) -> None:
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


def _signed_upload_required(
    capability: _UploadCapability,
    *,
    outcome: Literal["Created", "Reused"],
    expires_in: int,
    storage_client: StorageClientBase,
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


def create_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    request: CreateUploadSessionRequest,
    request_id: str | None,
    idempotency_key: str | None,
    storage_client: StorageClientBase | None = None,
) -> UploadSessionResponse:
    """Accept one upload intent and mint the capability for its current generation.

    The idempotency key identifies the intent, not one capability: every create is
    a new explicit command, so a live generation is re-signed here and its expiry
    extended, while a stolen verification lease, a transport failure, or a lapsed
    capability advances the generation instead (fencing the abandoned bytes behind
    a new staging path). ``retry_upload_session`` is the other half of that
    contract: its replay re-mints only the generation it memoized, for that memo's
    remaining life, so a replayed retry reports ``CapabilityExpired`` where a fresh
    create still hands back a usable capability.
    """
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
            _record_upload_event(
                db,
                session.id,
                UploadAccepted(generation=1),
                stage="Upload",
                failure_code=absent(),
            )
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
            stole_expired_lease = False
            if (
                session.verification_token is not None
                and session.verification_expires_at is not None
            ):
                if session.verification_expires_at > now:
                    raise ConflictError(
                        ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS,
                        "Upload verification is already in progress.",
                    )
                stole_expired_lease = True
            if (
                stole_expired_lease
                or session.transport_failed_at is not None
                or session.upload_url_expires_at <= now
            ):
                # A generation whose lease was stolen is not reusable: an abandoned
                # verifier may still be streaming its staged bytes, so the new
                # capability fences itself with a new generation and a new path.
                # ``_advance_generation`` clears the stolen lease.
                _advance_generation(session, now)
                _record_upload_event(
                    db,
                    session.id,
                    UploadRecoveryAccepted(generation=session.upload_generation),
                    stage="Upload",
                    failure_code=absent(),
                )
            else:
                session.upload_url_expires_at = now + timedelta(
                    seconds=get_settings().signed_url_expiry_s
                )
                session.updated_at = now
        capability = _UploadCapability.of(session)
        _reserve_staged_bytes_in_current_transaction(db, capability)
    logger.info(
        "IntentAccepted",
        upload_session_id=str(capability.session_id),
        generation=capability.generation,
        request_id=clean_request_id,
    )
    return _signed_upload_required(
        capability,
        outcome="Created" if created else "Reused",
        expires_in=get_settings().signed_url_expiry_s,
        storage_client=storage_client or get_storage_client(),
    )


def record_transport_failure(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
    failure: UploadTransportFailureRequest,
) -> None:
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
        # A browser phase report is telemetry, never a mutation the caller can be
        # refused: a stale generation or an already-published session is accepted
        # and changes nothing (spec §5).
        stale_generation = failure.generation != session.upload_generation
        already_published = session.published_at is not None
        recorded = not stale_generation and not already_published
        if recorded:
            now = _db_now(db)
            session.transport_failure_kind = failure.kind
            session.transport_http_status = (
                failure.status if isinstance(failure, UploadHttpRejectedFailureRequest) else None
            )
            session.transport_failed_at = now
            session.updated_at = now
            _record_upload_event(
                db,
                session.id,
                UploadFailed(
                    generation=session.upload_generation,
                    transport=present(_transport_failure(session).reason),
                ),
                stage="Upload",
                failure_code=present("E_UPLOAD_TRANSPORT_FAILED"),
            )
    logger.info(
        "PutFailed",
        upload_session_id=str(session.id),
        generation=failure.generation,
        current_generation=session.upload_generation,
        stale_generation=stale_generation,
        already_published=already_published,
        recorded=recorded,
        request_id=failure.request_id,
        failure_kind=failure.kind,
        http_status=(
            failure.status if isinstance(failure, UploadHttpRejectedFailureRequest) else None
        ),
        duration_ms=failure.duration_ms,
    )


@dataclass(frozen=True, slots=True)
class _AdmittedRetry:
    """The memoized receipt of one admitted retry: the generation and its expiry,
    never a signed URL."""

    generation: int
    expires_at: datetime


def retry_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
    request: RetryUploadSessionRequest,
    storage_client: StorageClientBase | None = None,
) -> UploadRequired | NeedsAttention:
    """Admit one new upload generation for the inspected one, exactly once per
    ``client_mutation_id``; a replay re-mints the admitted generation for its
    remaining life and never extends it."""
    filename = _normalize_filename(request.filename)
    content_type = _normalize_content_type(request.content_type)
    session_id = unseal_upload_session(session_handle)
    scope = f"media_upload_retry:{session_id}"
    request_bytes = canonical_json_bytes(request.model_dump(mode="json"))

    def admit() -> tuple[_UploadCapability, _AdmittedRetry]:
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
            # The replay re-mints the admitted capability: its expiry is the memo's,
            # even when a later create-with-reused-key extended the same generation.
            capability = replace(_UploadCapability.of(session), expires_at=admitted.expires_at)
            db.commit()
            return capability, admitted
        now = _db_now(db)
        if (
            session.verification_token is not None
            and session.verification_expires_at is not None
            and session.verification_expires_at > now
        ):
            # Same policy as create: a live verification owns this session, so a
            # retry reports it instead of silently cancelling the verifier.
            raise ConflictError(
                ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS,
                "Upload verification is already in progress.",
            )
        # Intent is compared before any content-type judgement so picking the wrong
        # file is reported as a mismatch the user can repair, not as a bad request.
        # The persisted intent was validated on create and is immutable, so a match
        # needs no re-validation.
        if (
            filename != session.filename
            or content_type != session.content_type
            or request.size_bytes != session.expected_size_bytes
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
        _advance_generation(session, now)
        _record_upload_event(
            db,
            session.id,
            UploadRecoveryAccepted(generation=session.upload_generation),
            stage="Upload",
            failure_code=absent(),
        )
        capability = _UploadCapability.of(session)
        _reserve_staged_bytes_in_current_transaction(db, capability)
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
            changed_lanes={},
        )
        db.commit()
        return capability, admitted

    capability, admitted = admit_serializable(db, "retry_upload_session", admit)
    now = _db_now(db)
    db.rollback()
    if admitted.expires_at <= now:
        return _capability_expired(session_id, admitted.expires_at)
    return _signed_upload_required(
        capability,
        outcome="Reused",
        expires_in=int((admitted.expires_at - now).total_seconds()),
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
            _record_upload_event(
                db,
                session.id,
                UploadFailed(generation=session.upload_generation, transport=absent()),
                stage="Validate",
                failure_code=present(error_code.value),
            )
            session.verification_error_code = error_code.value
            session.verification_failed_at = now
            session.verification_token = None
            session.verification_generation = None
            session.verification_expires_at = None
            session.transport_failure_kind = None
            session.transport_http_status = None
            session.transport_failed_at = None
            session.updated_at = now


@dataclass(frozen=True, slots=True)
class _AlreadyPublished:
    """The session already carries its publication fact; every confirm converges."""

    published: Published


@dataclass(frozen=True, slots=True)
class _LeaseClaimed:
    """This confirm owns the verification fence for exactly one generation."""

    session_id: UUID
    candidate_media_id: UUID
    kind: str
    content_type: str
    expected_size_bytes: int
    token: UUID
    lease_expires_at: datetime


type _VerificationFence = _AlreadyPublished | _LeaseClaimed
"""Every locked decision about a confirm: converge on publication, or hold the fence."""


def _verification_lease_lost(session: MediaUploadSession, generation: int) -> ConflictError:
    """Classify the loss of a held verification lease for one unpublished session.

    Only ``_advance_generation`` moves the generation and it clears the lease, so a
    token that is no longer current means either a newer generation superseded this
    attempt or another confirm stole the lease after it lapsed.
    """
    if session.upload_generation != generation:
        return ConflictError(
            ApiErrorCode.E_UPLOAD_GENERATION_STALE,
            "Upload generation is no longer current.",
        )
    return ConflictError(
        ApiErrorCode.E_UPLOAD_VERIFICATION_IN_PROGRESS,
        "Another verification attempt owns this upload session.",
    )


def _assert_lease_pins_generation(session: MediaUploadSession, generation: int) -> None:
    if session.verification_generation != generation or session.upload_generation != generation:
        # justify-service-invariant-check: the lease token and the generation it
        # fences are one fact stored as orthogonal nullable columns, so the pairing
        # cannot be expressed as a type.
        raise AssertionError("upload verification lease token outlived its generation")


def _renew_verification_lease(
    db: Session, *, session_id: UUID, generation: int, token: UUID
) -> _VerificationFence:
    """Extend the verification fence under the session row lock at a phase boundary.

    Renewal is the heartbeat that makes a slow-but-live verifier safe: publication
    requires the lease *token*, and expiry only governs whether a new confirm may
    steal the lease. A confirm that finds the session already published converges on
    that fact rather than failing.
    """
    with transaction(db):
        session = db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id == session_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if session is None:
            raise NotFoundError(
                ApiErrorCode.E_UPLOAD_SESSION_NOT_FOUND, "Upload session not found."
            )
        _assert_valid_persisted_state(session)
        if session.published_at is not None:
            return _AlreadyPublished(_published(session, "Reused"))
        if session.verification_token != token:
            raise _verification_lease_lost(session, generation)
        _assert_lease_pins_generation(session, generation)
        now = _db_now(db)
        renewed = _LeaseClaimed(
            session_id=session.id,
            candidate_media_id=session.candidate_media_id,
            kind=session.kind,
            content_type=session.content_type,
            expected_size_bytes=session.expected_size_bytes,
            token=token,
            lease_expires_at=now + _VERIFICATION_LEASE,
        )
        session.verification_expires_at = renewed.lease_expires_at
        session.updated_at = now
    return renewed


def _reserve_candidate_bytes(
    db: Session, *, session_id: UUID, candidate_path: str, lease_expires_at: datetime
) -> None:
    """Hold the candidate object for at least the life of the current lease.

    The reservation is already keyed to the lease token (the token is part of the
    path), and its retention deadline trails every renewal by the delayed-writer
    window, so the durable sweep can never reclaim bytes a live verifier still owns.
    """
    retain_until = lease_expires_at + timedelta(
        seconds=get_settings().storage_object_cleanup_write_window_seconds
    )
    try:
        reserve_upload_session_storage_object_write(
            db,
            upload_session_id=session_id,
            storage_path=candidate_path,
            retain_until=retain_until,
        )
    except StoragePathCleanupInFlight as exc:
        # The sweep for this exact token-fenced candidate is already deleting it, so
        # the copied bytes are gone. Nothing deterministic was rejected: the confirm
        # stays transient and retryable.
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, "Uploaded source storage is unavailable."
        ) from exc


def _claim_verification(
    db: Session, *, viewer_id: UUID, session_handle: str, generation: int
) -> _VerificationFence:
    """Take the one locked decision about this confirm: converge, or own the fence."""
    with transaction(db):
        session = _owned_session_for_update(db, viewer_id, session_handle)
        if session.published_at is not None:
            # This locked read is the single source of truth for "already
            # published". A replay that blocks here behind the winning publication
            # converges on the same Published projection.
            return _AlreadyPublished(_published(session, "Reused"))
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
        claimed = _LeaseClaimed(
            session_id=session.id,
            candidate_media_id=session.candidate_media_id,
            kind=session.kind,
            content_type=session.content_type,
            expected_size_bytes=session.expected_size_bytes,
            token=new_uuid7(),
            lease_expires_at=now + _VERIFICATION_LEASE,
        )
        session.verification_token = claimed.token
        session.verification_generation = generation
        session.verification_expires_at = claimed.lease_expires_at
        session.updated_at = now
        _record_upload_event(
            db,
            session.id,
            UploadExecutionStarted(generation=generation),
            stage="Validate",
            failure_code=absent(),
        )
    return claimed


def confirm_upload_session(
    db: Session,
    *,
    viewer_id: UUID,
    session_handle: str,
    generation: int,
    request_id: str | None,
    storage_client: StorageClientBase | None = None,
) -> Published:
    claim = _claim_verification(
        db,
        viewer_id=viewer_id,
        session_handle=session_handle,
        generation=generation,
    )
    match claim:
        case _AlreadyPublished(published=published):
            return published
        case _LeaseClaimed():
            lease = claim
        case _ as unreachable:
            assert_never(unreachable)

    session_id = lease.session_id
    candidate_media_id = lease.candidate_media_id
    kind = lease.kind
    content_type = lease.content_type
    expected_size_bytes = lease.expected_size_bytes
    token = lease.token
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

    def renew() -> _LeaseClaimed | Published:
        """Extend this confirm's fence at one phase boundary, or converge."""
        renewal = _renew_verification_lease(
            db, session_id=session_id, generation=generation, token=token
        )
        match renewal:
            case _AlreadyPublished(published=already):
                return already
            case _LeaseClaimed():
                return renewal
            case _ as unreachable:
                assert_never(unreachable)

    # One emission point for the ConfirmFailed fact: no failure path added below can
    # settle a confirm without the operator seeing the keyed, safe reason (spec §7).
    try:
        try:
            try:
                staged = _measure_source(
                    client,
                    storage_path=staging_path,
                    kind=kind,
                    expected_content_type=content_type,
                    expected_size_bytes=expected_size_bytes,
                )
                fence = renew()
                if isinstance(fence, Published):
                    return fence
                _reserve_candidate_bytes(
                    db,
                    session_id=session_id,
                    candidate_path=candidate_path,
                    lease_expires_at=fence.lease_expires_at,
                )
                client.copy_object(staging_path, candidate_path)
                fence = renew()
                if isinstance(fence, Published):
                    return fence
                _reserve_candidate_bytes(
                    db,
                    session_id=session_id,
                    candidate_path=candidate_path,
                    lease_expires_at=fence.lease_expires_at,
                )
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
                fence = renew()
                if isinstance(fence, Published):
                    return fence
                _reserve_candidate_bytes(
                    db,
                    session_id=session_id,
                    candidate_path=candidate_path,
                    lease_expires_at=fence.lease_expires_at,
                )
            except StorageError as exc:
                raise _storage_error(exc) from exc
        except ApiError as exc:
            if exc.code.value in _TERMINAL_VERIFICATION_CODES:
                _record_terminal_verification_failure(
                    db, session_id=session_id, token=token, error_code=exc.code
                )
            else:
                _clear_verification_lease(db, session_id, token)
            raise

        try:
            with transaction(db):
                session = _owned_session_for_update(db, viewer_id, session_handle)
                now = _db_now(db)
                if session.published_at is not None:
                    return _published(session, "Reused")
                # The fence is the lease *token*, not its expiry: a slow verifier
                # nobody stole from still publishes, and a stolen lease never does.
                if session.verification_token != token:
                    raise _verification_lease_lost(session, generation)
                _assert_lease_pins_generation(session, generation)
                if (
                    session.kind != kind
                    or session.content_type != content_type
                    or session.expected_size_bytes != expected_size_bytes
                    or session.candidate_media_id != candidate_media_id
                ):
                    # justify-service-invariant-check: normalized intent and candidate
                    # identity are immutable after creation, so drift is corruption
                    # rather than a state a caller can reach.
                    raise AssertionError("upload intent changed during verification")
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
                _record_upload_event(
                    db,
                    session.id,
                    UploadPublished(
                        generation=generation,
                        media_id=candidate_media_id,
                        source_attempt_id=attempt.id,
                    ),
                    stage="Upload",
                    failure_code=absent(),
                )
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
    except ApiError as exc:
        logger.info(
            "ConfirmFailed",
            upload_session_id=str(session_id),
            generation=generation,
            request_id=request_id,
            error_code=exc.code.value,
        )
        raise
    except Exception:
        logger.info(
            "ConfirmFailed",
            upload_session_id=str(session_id),
            generation=generation,
            request_id=request_id,
            error_code="E_INTERNAL",
        )
        raise

    finalize_upload_session_storage_object_write(
        db,
        upload_session_id=session_id,
        storage_path=candidate_path,
        storage_client=client,
    )
    try:
        client.delete_object(staging_path)
    # justify-ignore-error: the staged object carries its own 24-hour UploadSession
    # cleanup reservation, which is the durable owner of this deletion; a failed
    # opportunistic delete only defers reclamation and never orphans bytes.
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
        session_handle=seal_upload_session(session_id),
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
        _assert_valid_persisted_state(session)
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
            # justify-ignore-error: a claimed/running sweep of this exact staged path
            # already is the durable cleanup intent §5 requires for a 204, and it is
            # strictly stronger evidence than a freshly armed reservation. Removal
            # stays idempotent instead of reporting another domain's conflict.
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
    delete_upload_history_in_current_transaction(db, session_id=session.id)
    deleted_ids = list(
        db.execute(
            delete(MediaUploadSession)
            .where(MediaUploadSession.id == session.id)
            .returning(MediaUploadSession.id)
        ).scalars()
    )
    if deleted_ids != [session.id]:
        raise AssertionError("published upload support deletion did not remove its exact row")


@dataclass(frozen=True, slots=True)
class UnresolvedUploadSessionPage:
    """One bounded page of viewer obligations plus the exact unresolved total."""

    items: tuple[UploadSessionOwnerProjection, ...]
    total: int


def list_viewer_unresolved_upload_sessions(
    db: Session, *, viewer_id: UUID, limit: int
) -> UnresolvedUploadSessionPage:
    """Return at most ``limit`` unresolved obligations and their exact total.

    Selection, ordering, the page bound, and the badge total share one query over
    :data:`UPLOAD_SESSION_DERIVED_STATE_SQL`, so an unbounded backlog of abandoned
    sessions can never make a single Activity read scan or hydrate more than a page.
    """
    if limit < 1:
        raise ValueError("Upload-session page limit must be positive.")
    rows = list(
        db.execute(
            text(_UNRESOLVED_UPLOAD_SESSION_PAGE_SQL),
            {
                "viewer_id": viewer_id,
                "limit": limit,
                "attention_states": list(UPLOAD_SESSION_ATTENTION_STATES),
            },
        ).mappings()
    )
    if not rows:
        return UnresolvedUploadSessionPage(items=(), total=0)
    total = int(rows[0]["unresolved_count"])
    ordered_ids = [UUID(str(row["id"])) for row in rows]
    sessions = {
        session.id: session
        for session in db.execute(
            select(MediaUploadSession)
            .where(MediaUploadSession.id.in_(ordered_ids))
            .execution_options(populate_existing=True)
        ).scalars()
    }
    # Read the clock after the selection so the per-row classifier can only observe
    # a later instant: every derived state it must agree with is monotonic in time.
    now = _db_now(db)
    projections: list[UploadSessionOwnerProjection] = []
    for session_id in ordered_ids:
        session = sessions[session_id]
        attention = _needs_attention(session, now)
        if attention is None:
            # justify-service-invariant-check: the set-wise precedence expression and
            # the per-row classifier are two owners of one rule; disagreement is drift.
            raise AssertionError("selected upload obligation has no attention projection")
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
                session_handle=seal_upload_session(session.id),
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
    return UnresolvedUploadSessionPage(items=tuple(projections), total=total)
