"""Durable source-ingest lifecycle: accept, admit recovery, run under the fence.

Everything a source becomes media through enters here. Acceptance is synchronous
and commits one ``media_source_attempts`` row plus one ``ingest_media_source``
job; the worker then acquires the source with no transaction open and publishes
every write through ``source_publication``'s exact queue-claim fence.
"""

from __future__ import annotations

import json
import posixpath
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, cast
from urllib.parse import unquote, urlparse
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, MediaFile, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.db.retries import admit_serializable
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    current_dead_job_for_payload,
    enqueue_job,
    find_nonterminal_jobs_for_payload,
    lock_job,
    requeue_dead_job,
    supersede_unclaimed_job,
)
from nexus.logging import get_logger
from nexus.schemas.import_history import (
    RepairSourceRecovery,
    RetrySourceRecovery,
    SafeFailureCode,
    SourceAccepted,
    SourceExecutionStarted,
    SourceFacts,
    SourceFailed,
    SourceRecoveryAccepted,
    SourceSucceeded,
    SourceSuperseded,
    assume_safe_failure_code,
)
from nexus.schemas.imports import RepairSourceOffer, RetrySourceOffer, SourceRecoveryInput
from nexus.schemas.media import (
    FromUrlResponse,
    MediaProcessingStatus,
    MediaSourceAttemptStatus,
    SourceRepairAdmission,
    SourceRetryAdmission,
)
from nexus.schemas.presence import Presence, absent, present
from nexus.services import library_entries, library_governance
from nexus.services import media_source_types as source_types
from nexus.services.capabilities import (
    OperatorRecovery,
    RecoveryActor,
    SourceRecoveryAnswer,
    SourceRecoveryRestriction,
    ViewerRecovery,
    is_same_source_terminal_error,
)
from nexus.services.contributor_taxonomy import ContributorObservationBatch, NotObserved
from nexus.services.contributor_writes import MediaTarget
from nexus.services.contributors import apply_observed_role_slices_in_current_transaction
from nexus.services.import_history import append_processing_event
from nexus.services.media_author_observation_seam import (
    SourceAuthorObservation,
    take_author_observations,
)
from nexus.services.media_deletion import (
    delete_document_storage_objects,
    delete_duplicate_document_media,
)
from nexus.services.media_fact_revisions import bump_all_media_fact_collections
from nexus.services.media_processing_state import (
    mark_ready_for_reading,
    mark_source_queued,
    mark_stage_warning,
    require_media_failure_stage,
)
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.remote_file_ingest import remote_file_kind_from_url
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.source_attempt_artifacts import source_attempt_storage_paths
from nexus.services.source_attempt_failures import (
    SourceAttemptFailure,
    publish_source_attempt_failure,
    source_attempt_failure_stage,
)
from nexus.services.source_history import source_failure_progress, source_history_stage
from nexus.services.source_publication import (
    SourcePublicationFence,
    SourcePublicationSuperseded,
    latest_source_attempt_id,
    reset_source_progress,
    run_source_publication_phase,
)
from nexus.services.transcripts.request_reason import (
    TranscriptRequestReason,
    require_transcript_request_reason,
)
from nexus.services.transcripts.semantic import enqueue_transcript_semantic_job
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.x_identity import classify_x_url, is_x_url
from nexus.services.youtube_identity import classify_youtube_url, is_youtube_url
from nexus.storage.client import StorageError, get_storage_client
from nexus.storage.paths import get_file_extension
from nexus.tasks.storage_object_cleanup import (
    finalize_storage_object_write,
    reserve_storage_object_write,
)

logger = get_logger(__name__)

ACCEPTED = "accepted"
QUEUED = "queued"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
IN_FLIGHT_STATUSES = frozenset({ACCEPTED, QUEUED, RUNNING})

# The bytes behind these failures are gone for good: only a new source helps.
_NON_REACQUIRABLE_FILE_ERROR_CODES = frozenset(
    "E_SIGN_UPLOAD_FAILED E_STORAGE_MISSING E_STORAGE_ERROR".split()
)
# Only these settle the attempt; every other failure re-raises to the queue.
_TERMINAL_SOURCE_FAILURE_CODES = frozenset(
    """E_SOURCE_ACCESS_DENIED E_SOURCE_INTEGRITY E_SOURCE_TOO_LARGE E_SOURCE_NOT_READABLE
    E_SSRF_BLOCKED E_INVALID_FILE_TYPE E_INVALID_CONTENT_TYPE E_FILE_TOO_LARGE
    E_CAPTURE_TOO_LARGE E_ARCHIVE_UNSAFE E_INVALID_REQUEST E_PDF_PASSWORD_REQUIRED
    E_TRANSCRIPT_UNAVAILABLE E_X_POST_UNAVAILABLE E_X_PROVIDER_CREDITS_DEPLETED
    E_X_PROVIDER_AUTH_REJECTED E_PODCAST_QUOTA_EXCEEDED E_BILLING_REQUIRED""".split()
)
_RESTRICTION_MESSAGES: dict[SourceRecoveryRestriction, str] = {
    "NotOwner": "Only the creator can retry source content.",
    "SameSourceTerminal": (
        "Source retry is not available for this terminal failure. Provide a new source."
    ),
    "SourceNotReacquirable": (
        "Source retry is not available because the original source bytes cannot be reacquired."
    ),
}


# =============================================================================
# Recovery policy
# =============================================================================


def source_repairable_sql(media_alias: str) -> str:
    """Boolean SQL: the media's latest attempt is nonterminal and its exact job is dead."""
    return f"""EXISTS(
    SELECT 1
    FROM media_source_attempts latest_attempt
    JOIN background_jobs latest_job
      ON latest_job.id = latest_attempt.job_id
     AND latest_job.kind = 'ingest_media_source'
     AND latest_job.status = 'dead'
     AND latest_job.payload @> jsonb_build_object(
         'media_id', {media_alias}.id::text,
         'attempt_id', latest_attempt.id::text
     )
    WHERE latest_attempt.media_id = {media_alias}.id
      AND latest_attempt.status IN ('accepted', 'queued', 'running')
      AND latest_attempt.id = (
          SELECT latest.id
          FROM media_source_attempts latest
          WHERE latest.media_id = {media_alias}.id
          ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
          LIMIT 1
      )
)"""


@dataclass(frozen=True, slots=True)
class SourceRecoveryFacts:
    """The facts the recovery policy decides on, for one media's latest attempt."""

    attempt_id: UUID
    attempt_status: str
    error_code: str | None
    source_type: str
    processing_status: str
    job_id: UUID | None
    repairable: bool
    is_creator: bool
    is_operator: bool


def source_recovery(facts: SourceRecoveryFacts) -> SourceRecoveryAnswer:
    """The one recovery answer for a media's source obligation.

    A nonterminal attempt whose exact job is dead repairs that job; a terminally
    failed source retries through a new attempt when the viewer created it and
    the same source can be reacquired; anything else offers nothing.
    """
    if facts.repairable and facts.job_id is not None:
        if not (facts.is_creator or facts.is_operator):
            return "NotOwner"
        return RepairSourceOffer(
            expected_attempt_id=facts.attempt_id,
            expected_job_id=facts.job_id,
            input=_recovery_input(facts.source_type),
        )
    if facts.attempt_status != FAILED or facts.processing_status != "failed":
        return None
    if not facts.is_creator:
        return "NotOwner"
    restriction = _reacquisition_restriction(
        source_type=facts.source_type, error_code=facts.error_code
    )
    if restriction is not None:
        return restriction
    return RetrySourceOffer(
        expected_attempt_id=facts.attempt_id, input=_recovery_input(facts.source_type)
    )


def _recovery_input(source_type: str) -> SourceRecoveryInput:
    if source_type in source_types.NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES:
        return "StoredSource"
    return "RefetchSource"


def _reacquisition_restriction(
    *, source_type: str, error_code: str | None
) -> SourceRecoveryRestriction | None:
    """Why the same source can never be reacquired, or ``None`` when it can."""
    if is_same_source_terminal_error(error_code):
        return "SameSourceTerminal"
    if (
        source_type in source_types.NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES
        and error_code in _NON_REACQUIRABLE_FILE_ERROR_CODES
    ):
        return "SourceNotReacquirable"
    return None


def _recovery_facts(
    db: Session, *, media: Media, attempt: MediaSourceAttempt, is_creator: bool, is_operator: bool
) -> SourceRecoveryFacts:
    """Per-row facts inside an admission; the dead job, when exact, stays locked."""
    repairable = False
    if attempt.job_id is not None and attempt.status in IN_FLIGHT_STATUSES:
        dead = current_dead_job_for_payload(
            db,
            kind="ingest_media_source",
            expected_payload_match={"media_id": str(media.id), "attempt_id": str(attempt.id)},
        )
        repairable = dead is not None and dead.id == attempt.job_id
    return SourceRecoveryFacts(
        attempt_id=attempt.id,
        attempt_status=attempt.status,
        error_code=attempt.error_code,
        source_type=attempt.source_type,
        processing_status=media.processing_status.value,
        job_id=attempt.job_id,
        repairable=repairable,
        is_creator=is_creator,
        is_operator=is_operator,
    )


# =============================================================================
# URL classification
# =============================================================================


@dataclass(frozen=True, slots=True)
class UrlSourceSpec:
    """Everything a URL decides about the media and attempt it becomes."""

    source_type: str
    kind: str
    title: str
    canonical_source_url: str | None
    source_payload: dict[str, object]
    canonical_url: str | None = None
    external_playback_url: str | None = None
    provider: str | None = None
    provider_id: str | None = None
    provider_target_ref: str | None = None


def url_source_spec(url: str) -> UrlSourceSpec:
    """Classify a validated URL: YouTube, then X, then remote file, else generic web."""
    youtube = classify_youtube_url(url)
    if youtube is not None:
        return UrlSourceSpec(
            source_type=source_types.YOUTUBE_VIDEO,
            kind=MediaKind.video.value,
            title=f"YouTube Video {youtube.provider_video_id}",
            canonical_url=youtube.watch_url,
            canonical_source_url=youtube.watch_url,
            external_playback_url=youtube.watch_url,
            provider=youtube.provider,
            provider_id=youtube.provider_video_id,
            provider_target_ref=youtube.provider_video_id,
            source_payload={"video_id": youtube.provider_video_id},
        )
    if is_youtube_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "YouTube URL must include a valid video ID"
        )

    x_post = classify_x_url(url)
    if x_post is not None:
        return UrlSourceSpec(
            source_type=source_types.X_AUTHOR_THREAD,
            kind=MediaKind.web_article.value,
            title=f"X post {x_post.provider_id}",
            canonical_source_url=x_post.canonical_url,
            provider=x_post.provider,
            provider_target_ref=x_post.provider_id,
            source_payload={"post_id": x_post.provider_id},
        )
    if is_x_url(url):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "X URL must include a valid post ID"
        )

    remote_kind = remote_file_kind_from_url(url)
    if remote_kind is not None:
        return UrlSourceSpec(
            source_type=(
                source_types.REMOTE_PDF_URL
                if remote_kind == "pdf"
                else source_types.REMOTE_EPUB_URL
            ),
            kind=remote_kind,
            title=_remote_file_name(url, remote_kind),
            canonical_source_url=normalize_url_for_display(url),
            source_payload={"remote_kind": remote_kind},
        )

    return UrlSourceSpec(
        source_type=source_types.GENERIC_WEB_URL,
        kind=MediaKind.web_article.value,
        title=url[:255] if url else "Untitled",
        canonical_source_url=normalize_url_for_display(url),
        source_payload={},
    )


def _embedded_source_spec(url: str) -> UrlSourceSpec | None:
    """The child-source spec for a trusted document embed, or ``None`` if unsupported."""
    spec = url_source_spec(url)
    if spec.source_type == source_types.X_AUTHOR_THREAD:
        post_id = spec.provider_target_ref or ""
        return UrlSourceSpec(
            source_type=source_types.X_POST,
            kind=spec.kind,
            title=spec.title,
            canonical_source_url=spec.canonical_source_url,
            provider=spec.provider,
            provider_id=f"post:{post_id}",
            provider_target_ref=post_id,
            source_payload={"post_id": post_id},
        )
    return spec if spec.source_type == source_types.YOUTUBE_VIDEO else None


def _find_reusable_url_media(db: Session, spec: UrlSourceSpec) -> Media | None:
    """The existing media a re-added URL reuses, for the three deduped source kinds."""
    if spec.source_type == source_types.X_AUTHOR_THREAD:
        if not spec.provider_target_ref:
            return None
        return db.scalars(
            select(Media)
            .join(MediaSourceAttempt, MediaSourceAttempt.media_id == Media.id)
            .where(
                MediaSourceAttempt.source_type == source_types.X_AUTHOR_THREAD,
                MediaSourceAttempt.provider_target_ref == spec.provider_target_ref,
                Media.provider == "x",
            )
            .order_by(MediaSourceAttempt.created_at.asc(), MediaSourceAttempt.id.asc())
            .limit(1)
        ).one_or_none()
    if spec.source_type == source_types.X_POST:
        if not spec.provider_id:
            return None
        return db.scalars(
            select(Media).where(Media.provider == "x", Media.provider_id == spec.provider_id)
        ).one_or_none()
    if spec.source_type != source_types.YOUTUBE_VIDEO:
        return None
    return db.scalars(
        select(Media).where(
            Media.kind == MediaKind.video.value, Media.canonical_url == spec.canonical_url
        )
    ).one_or_none()


def _refresh_reused_video_identity(media: Media, spec: UrlSourceSpec) -> None:
    """A video media matched on canonical URL adopts the URL's provider identity."""
    media.provider = spec.provider
    media.provider_id = spec.provider_id
    media.external_playback_url = media.external_playback_url or spec.external_playback_url
    media.canonical_source_url = media.canonical_source_url or spec.canonical_source_url
    media.updated_at = datetime.now(UTC)


def reusable_embedded_source_media_ids(
    db: Session, *, viewer_id: UUID, urls: list[str]
) -> set[UUID]:
    """The pre-existing media rows an embed publication must lock."""
    media_ids: set[UUID] = set()
    for url in urls:
        validate_requested_url(url)
        spec = _embedded_source_spec(url)
        if spec is None:
            continue
        media = _find_reusable_url_media(db, spec)
        if media is not None:
            media_ids.add(media.id)
    return media_ids


# =============================================================================
# Attempts, intents, idempotency
# =============================================================================


def build_intent_key(
    source_type: str, url: str, target_ref: object, *, library_ids: list[UUID] | None = None
) -> str:
    """The stable identity of one accept intent, compared on idempotency replay."""
    payload: dict[str, object] = {
        "source_type": source_type,
        "url": url,
        "target_ref": target_ref,
    }
    if library_ids is not None:
        payload["library_ids"] = sorted(str(library_id) for library_id in library_ids)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _action_intent_key(action: str, *, media_id: UUID, previous_attempt_id: UUID) -> str:
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


def lock_identity(db: Session, key: str) -> None:
    """Serialize this transaction against every other holder of the same key.

    The one advisory-lock owner: provider identities before a read-or-create,
    and idempotency keys before their lookup.
    """
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"), {"lock_key": key}
    )


def _clean_idempotency_key(value: str | None) -> str | None:
    clean = (value or "").strip()
    if not clean:
        return None
    if len(clean) > 255:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long.")
    return clean


def _replay_or_none(
    db: Session, *, viewer_id: UUID, idempotency_key: str | None, intent_key: str
) -> FromUrlResponse | None:
    """Serialize on the key, then answer a replay of the same intent."""
    if idempotency_key is None:
        return None
    lock_identity(db, f"media_source:{viewer_id}:{idempotency_key}")
    existing = db.scalars(
        select(MediaSourceAttempt)
        .where(
            MediaSourceAttempt.created_by_user_id == viewer_id,
            MediaSourceAttempt.idempotency_key == idempotency_key,
        )
        .limit(1)
    ).one_or_none()
    if existing is None:
        return None
    if existing.intent_key != intent_key:
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Idempotency key was reused for a different source ingest request.",
        )
    media = db.get(Media, existing.media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return _from_url_response(media, existing, "reused")


def _from_url_response(
    media: Media,
    attempt: MediaSourceAttempt,
    outcome: Literal["created", "reused", "retrying", "refreshed"],
    *,
    ingest_enqueued: bool | None = None,
) -> FromUrlResponse:
    return FromUrlResponse(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        source_attempt_status=cast(MediaSourceAttemptStatus, attempt.status),
        idempotency_outcome=outcome,
        processing_status=cast(MediaProcessingStatus, media.processing_status.value),
        ingest_enqueued=(
            attempt.status in {ACCEPTED, QUEUED} if ingest_enqueued is None else ingest_enqueued
        ),
    )


def create_attempt(
    db: Session,
    *,
    media: Media,
    viewer_id: UUID,
    source_type: str,
    intent_key: str,
    requested_url: str | None,
    canonical_source_url: str | None,
    provider: str | None,
    provider_target_ref: str | None,
    source_payload: dict[str, object],
    request_id: str | None,
    idempotency_key: str | None,
    status: str,
) -> MediaSourceAttempt:
    """Append one attempt to a media's attempt sequence and record its history."""
    attempt_no = db.scalar(
        select(func.coalesce(func.max(MediaSourceAttempt.attempt_no), 0) + 1).where(
            MediaSourceAttempt.media_id == media.id
        )
    )
    attempt = MediaSourceAttempt(
        media_id=media.id,
        created_by_user_id=viewer_id,
        source_type=source_type,
        attempt_no=int(attempt_no or 1),
        status=status,
        intent_key=intent_key,
        idempotency_key=idempotency_key,
        requested_url=requested_url,
        canonical_source_url=canonical_source_url,
        provider=provider,
        provider_target_ref=provider_target_ref,
        source_payload=source_payload,
        request_id=request_id,
    )
    db.add(attempt)
    db.flush()
    _record_event(
        db,
        media_id=media.id,
        attempt=attempt,
        facts=SourceAccepted(source_attempt_id=attempt.id, attempt_no=attempt.attempt_no),
        failure_code=absent(),
    )
    if status == SUCCEEDED:
        _record_event(
            db,
            media_id=media.id,
            attempt=attempt,
            facts=SourceSucceeded(source_attempt_id=attempt.id, execution_id=absent()),
            failure_code=absent(),
        )
    elif status == FAILED:
        _record_event(
            db,
            media_id=media.id,
            attempt=attempt,
            facts=SourceFailed(
                source_attempt_id=attempt.id,
                execution_id=absent(),
                origin="Domain",
                terminal=True,
                progress=absent(),
            ),
            failure_code=present(_failed_media_code(media)),
        )
    return attempt


def _clone_attempt(
    db: Session,
    *,
    media: Media,
    viewer_id: UUID,
    previous: MediaSourceAttempt,
    request_id: str | None,
    intent_key: str,
) -> MediaSourceAttempt:
    """A fresh accepted attempt carrying the previous one's source identity only."""
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=previous.source_type,
        intent_key=intent_key,
        requested_url=previous.requested_url,
        canonical_source_url=previous.canonical_source_url,
        provider=previous.provider,
        provider_target_ref=previous.provider_target_ref,
        source_payload=dict(previous.source_payload or {}),
        request_id=request_id,
        idempotency_key=None,
        status=ACCEPTED,
    )
    if attempt.source_type == source_types.PODCAST_EPISODE_TRANSCRIPT:
        attempt.source_payload = {
            **dict(attempt.source_payload or {}),
            "request_reason": "operator_requeue",
        }
    return attempt


def _latest_attempt(db: Session, media_id: UUID) -> MediaSourceAttempt | None:
    return db.scalars(
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.media_id == media_id)
        .order_by(
            MediaSourceAttempt.attempt_no.desc(),
            MediaSourceAttempt.created_at.desc(),
            MediaSourceAttempt.id.desc(),
        )
        .limit(1)
    ).one_or_none()


def _lock_latest_attempt(db: Session, media_id: UUID) -> MediaSourceAttempt | None:
    attempt_id = latest_source_attempt_id(db, media_id)
    if attempt_id is None:
        return None
    return db.scalars(
        select(MediaSourceAttempt).where(MediaSourceAttempt.id == attempt_id).with_for_update()
    ).one_or_none()


def _record_event(
    db: Session,
    *,
    media_id: UUID,
    attempt: MediaSourceAttempt,
    facts: SourceFacts,
    failure_code: Presence[SafeFailureCode],
) -> None:
    append_processing_event(
        db,
        media_id=media_id,
        facts=facts,
        stage=present(
            source_history_stage(
                source_type=attempt.source_type, processing_stage=attempt.processing_stage
            )
        ),
        failure_code=failure_code,
    )


def _failed_media_code(media: Media) -> SafeFailureCode:
    return assume_safe_failure_code(media.last_error_code or ApiErrorCode.E_INGEST_FAILED.value)


# =============================================================================
# Accept surfaces
# =============================================================================


def accept_url_source(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None = None,
    idempotency_key: str | None = None,
    ingest_purpose: Literal["artifact_research"] | None = None,
) -> FromUrlResponse:
    """Accept a URL source intent before any provider, network or storage work runs."""
    library_governance.validate_writable_library_destinations(db, viewer_id, library_ids)
    return _accept_url(
        db=db,
        viewer_id=viewer_id,
        url=url,
        library_ids=library_ids,
        request_id=request_id,
        idempotency_key=idempotency_key,
        assign_viewer_libraries=True,
        payload_extra=({"ingest_purpose": ingest_purpose} if ingest_purpose is not None else None),
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

    The owning system service attaches the media through its own explicit
    library-entry command after acceptance.
    """
    return _accept_url(
        db=db,
        viewer_id=actor_user_id,
        url=url,
        library_ids=[],
        request_id=request_id,
        idempotency_key=idempotency_key,
        assign_viewer_libraries=False,
        expected_kind=expected_kind,
        payload_extra={"system_source": system_source},
    )


def _accept_url(
    *,
    db: Session,
    viewer_id: UUID,
    url: str,
    library_ids: list[UUID],
    request_id: str | None,
    idempotency_key: str | None,
    assign_viewer_libraries: bool,
    expected_kind: str | None = None,
    payload_extra: dict[str, object] | None = None,
) -> FromUrlResponse:
    validate_requested_url(url)
    spec = url_source_spec(url)
    if expected_kind is not None and spec.kind != expected_kind:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            f"URL source produced {spec.kind!r}; expected {expected_kind!r}.",
        )
    intent_key = build_intent_key(
        spec.source_type,
        url,
        spec.provider_target_ref,
        library_ids=library_ids if assign_viewer_libraries else None,
    )
    clean_key = _clean_idempotency_key(idempotency_key)
    replay = _replay_or_none(
        db, viewer_id=viewer_id, idempotency_key=clean_key, intent_key=intent_key
    )
    if replay is not None:
        return replay

    media = _find_reusable_url_media(db, spec)
    created = media is None
    if media is None:
        media = _new_media_from_spec(db, spec, url=url, viewer_id=viewer_id)
    elif spec.source_type == source_types.YOUTUBE_VIDEO:
        _refresh_reused_video_identity(media, spec)

    if assign_viewer_libraries:
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, library_ids
        )
        if not created and spec.source_type == source_types.X_AUTHOR_THREAD:
            _reconcile_reused_thread_libraries(db, viewer_id, media.id, library_ids)

    if not created:
        in_flight = _latest_attempt(db, media.id)
        if in_flight is not None and in_flight.status in IN_FLIGHT_STATUSES:
            # A second submission joins the run already crossing the fence rather
            # than accepting a newer attempt over it.
            db.commit()
            return _from_url_response(media, in_flight, "reused")

    source_payload: dict[str, object] = {"url": url, "kind": spec.kind, **spec.source_payload}
    if assign_viewer_libraries:
        source_payload["library_ids"] = [str(library_id) for library_id in library_ids]
    if payload_extra:
        source_payload.update(payload_extra)
    settled_status = FAILED if media.processing_status == ProcessingStatus.failed else SUCCEEDED
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=spec.source_type,
        intent_key=intent_key,
        requested_url=url,
        canonical_source_url=spec.canonical_source_url,
        provider=spec.provider,
        provider_target_ref=spec.provider_target_ref,
        source_payload=source_payload,
        request_id=request_id,
        idempotency_key=clean_key,
        status=ACCEPTED if created else settled_status,
    )
    if not created:
        attempt.finished_at = func.now()
        if attempt.status == FAILED:
            attempt.error_code = media.last_error_code
            attempt.error_message = media.last_error_message
    db.commit()

    if not created:
        return _from_url_response(media, attempt, "reused", ingest_enqueued=False)
    return _store_and_enqueue(
        db,
        media_id=media.id,
        attempt_id=attempt.id,
        viewer_id=viewer_id,
        request_id=request_id,
        writes=(),
    )


def _new_media_from_spec(db: Session, spec: UrlSourceSpec, *, url: str, viewer_id: UUID) -> Media:
    now = datetime.now(UTC)
    media = Media(
        kind=spec.kind,
        title=spec.title[:255],
        requested_url=url,
        canonical_url=spec.canonical_url,
        canonical_source_url=spec.canonical_source_url,
        external_playback_url=spec.external_playback_url,
        provider=spec.provider,
        provider_id=spec.provider_id,
        processing_status=ProcessingStatus.pending,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
    )
    db.add(media)
    db.flush()
    return media


def _reconcile_reused_thread_libraries(
    db: Session, viewer_id: UUID, media_id: UUID, library_ids: list[UUID]
) -> None:
    from nexus.services.document_embeds import (
        reconcile_document_embed_edges_for_viewer,
        resolved_document_embed_target_media_ids,
    )

    for target_media_id in resolved_document_embed_target_media_ids(db, media_id=media_id):
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, target_media_id, library_ids
        )
    reconcile_document_embed_edges_for_viewer(db, viewer_id=viewer_id, media_id=media_id)


@dataclass(frozen=True, slots=True)
class EmbeddedSourceAcceptance:
    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    provider_target_ref: str | None
    source_attempt_status: str
    processing_status: str
    needs_enqueue: bool


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
    spec = _embedded_source_spec(url)
    if spec is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Unsupported embedded source provider."
        )
    if spec.source_type == source_types.X_POST and spec.provider_id:
        lock_identity(db, spec.provider_id)

    media = _find_reusable_url_media(db, spec)
    if media is not None:
        if spec.source_type == source_types.YOUTUBE_VIDEO:
            _refresh_reused_video_identity(media, spec)
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, viewer_id, media.id, library_ids
        )
        existing = _latest_attempt(db, media.id)
        if existing is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Reusable embedded media has no attempt.")
        return EmbeddedSourceAcceptance(
            media_id=media.id,
            source_attempt_id=existing.id,
            source_type=existing.source_type,
            provider_target_ref=existing.provider_target_ref,
            source_attempt_status=existing.status,
            processing_status=media.processing_status.value,
            needs_enqueue=False,
        )

    media = _new_media_from_spec(db, spec, url=url, viewer_id=viewer_id)
    library_entries.assign_libraries_for_media_in_current_transaction(
        db, viewer_id, media.id, library_ids
    )
    attempt = create_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        source_type=spec.source_type,
        intent_key=build_intent_key(
            spec.source_type, url, spec.provider_target_ref, library_ids=library_ids
        ),
        requested_url=url,
        canonical_source_url=spec.canonical_source_url,
        provider=spec.provider,
        provider_target_ref=spec.provider_target_ref,
        source_payload={
            "url": url,
            "kind": spec.kind,
            "parent_media_id": str(parent_media_id),
            "document_embed_key": document_embed_key,
            **spec.source_payload,
            "library_ids": [str(library_id) for library_id in library_ids],
        },
        request_id=request_id,
        idempotency_key=None,
        status=ACCEPTED,
    )
    return EmbeddedSourceAcceptance(
        media_id=media.id,
        source_attempt_id=attempt.id,
        source_type=attempt.source_type,
        provider_target_ref=attempt.provider_target_ref,
        source_attempt_status=attempt.status,
        processing_status=media.processing_status.value,
        needs_enqueue=True,
    )


def enqueue_podcast_episode_transcript_source_attempt(
    *,
    db: Session,
    media_id: UUID,
    viewer_id: UUID,
    request_reason: TranscriptRequestReason,
    request_id: str | None,
) -> Literal["created", "idempotent"]:
    """Bind podcast transcript source work inside the caller-owned transaction."""
    media = db.execute(
        select(Media).where(Media.id == media_id).with_for_update(key_share=True)
    ).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != MediaKind.podcast_episode.value:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Podcast transcript source attempts must target podcast episode media.",
        )
    latest = _latest_attempt(db, media_id)
    if latest is not None and latest.status in IN_FLIGHT_STATUSES:
        return "idempotent"
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
        source_payload={"media_kind": media.kind, "request_reason": request_reason},
        request_id=request_id,
        idempotency_key=None,
        status=ACCEPTED,
    )
    mark_source_queued(db, media)
    bump_all_media_fact_collections(db)
    db.flush()
    enqueue_accepted_source_attempt_in_transaction(
        db,
        media_id=media_id,
        attempt_id=attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
    )
    return "created"


def complete_x_post_snapshot_attempt(
    db: Session,
    *,
    media: Media,
    source_attempt_id: UUID,
    viewer_id: UUID,
    post_id: str,
    canonical_url: str,
    request_id: str | None,
) -> MediaSourceAttempt:
    """Complete an accepted X-post child from the parent thread's provider snapshot."""
    attempt = db.get(MediaSourceAttempt, source_attempt_id)
    if attempt is None or attempt.media_id != media.id:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Accepted X-post attempt identity changed.")
    if attempt.status == SUCCEEDED:
        return attempt
    now = datetime.now(UTC)
    if attempt.status == FAILED:
        attempt = create_attempt(
            db,
            media=media,
            viewer_id=viewer_id,
            source_type=source_types.X_POST,
            intent_key=build_intent_key(source_types.X_POST, canonical_url, post_id),
            requested_url=canonical_url,
            canonical_source_url=canonical_url,
            provider="x",
            provider_target_ref=post_id,
            source_payload={"post_id": post_id},
            request_id=request_id,
            idempotency_key=None,
            status=SUCCEEDED,
        )
    else:
        _release_in_flight_x_post_job(db, attempt)
        attempt.status = SUCCEEDED
        attempt.error_code = None
        attempt.error_message = None
        attempt.retry_after_seconds = None
        _record_event(
            db,
            media_id=media.id,
            attempt=attempt,
            facts=SourceSucceeded(source_attempt_id=attempt.id, execution_id=absent()),
            failure_code=absent(),
        )
    attempt.run_count = max(1, int(attempt.run_count or 0))
    attempt.started_at = attempt.started_at or now
    attempt.finished_at = now
    attempt.updated_at = now
    return attempt


def _release_in_flight_x_post_job(db: Session, attempt: MediaSourceAttempt) -> None:
    """Retire the child's waiting queue row without waiting on a worker's lock.

    This runs under the quote media's publication lock, which the queue seam's
    history insert needs as KEY SHARE: waiting on a queue row a worker holds
    would wait on the worker that is waiting on this media. So the jobs are read
    unlocked and only an unclaimed row is superseded; a claimed execution can
    never publish over the succeeded attempt this commits, because
    ``require_source_publication`` fences on attempt status.
    """
    if attempt.status != QUEUED or attempt.job_id is None:
        return
    jobs = find_nonterminal_jobs_for_payload(
        db, kind="ingest_media_source", expected_payload_match={"attempt_id": str(attempt.id)}
    )
    for job in jobs:
        if (
            job.id == attempt.job_id
            and job.status in {"pending", "failed"}
            and job.claimed_by is None
        ):
            supersede_unclaimed_job(db, job_id=job.id, kind="ingest_media_source")


# =============================================================================
# Enqueue
# =============================================================================


def _enqueue_source_job(
    db: Session, media_id: UUID, attempt_id: UUID, actor_user_id: UUID, request_id: str | None
) -> JobRow:
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


def enqueue_accepted_source_attempt_in_transaction(
    db: Session, *, media_id: UUID, attempt_id: UUID, actor_user_id: UUID, request_id: str | None
) -> UUID:
    """Bind a newly accepted child attempt to its durable job without committing."""
    job = _enqueue_source_job(db, media_id, attempt_id, actor_user_id, request_id)
    attempt = db.get(MediaSourceAttempt, attempt_id)
    if attempt is None or attempt.media_id != media_id:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Accepted source attempt identity changed.")
    attempt.job_id = job.id
    attempt.status = QUEUED
    attempt.retry_after_seconds = None
    attempt.updated_at = func.now()
    return job.id


def enqueue_accepted_source_attempt(
    db: Session, *, media_id: UUID, attempt_id: UUID, actor_user_id: UUID, request_id: str | None
) -> bool:
    """Commit the queue binding for one accepted attempt and settle its embed edges."""
    enqueued = _enqueue_attempt(
        db,
        media_id=media_id,
        attempt_id=attempt_id,
        actor_user_id=actor_user_id,
        request_id=request_id,
        failure_stage="extract",
        requeue=False,
    )
    _sync_document_embed_targets(db, media_id)
    return enqueued


def _enqueue_attempt(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
    failure_stage: str,
    requeue: bool,
) -> bool:
    """Commit one attempt into the queue; a failure here fails the attempt visibly.

    ``requeue`` additionally preflights the stored source with no transaction
    open and re-admits the domain state a second run needs.
    """
    try:
        if requeue:
            _verify_source_storage(db, media_id=media_id, attempt_id=attempt_id)
            media = db.execute(
                select(Media).where(Media.id == media_id).with_for_update(key_share=True)
            ).scalar()
            attempt = db.scalars(
                select(MediaSourceAttempt)
                .where(MediaSourceAttempt.id == attempt_id)
                .with_for_update()
            ).one_or_none()
            if media is None or attempt is None:
                db.rollback()
                return False
            if attempt.status == FAILED:
                db.commit()
                return False
            _admit_requeued_transcript(db, media, attempt, actor_user_id)
            mark_source_queued(db, media)
            bump_all_media_fact_collections(db)
        else:
            attempt = db.get(MediaSourceAttempt, attempt_id)
            if attempt is None:
                db.rollback()
                return False
            if attempt.status == FAILED:
                db.commit()
                return False
        job = _enqueue_source_job(db, media_id, attempt_id, actor_user_id, request_id)
        attempt.job_id = job.id
        attempt.status = QUEUED
        attempt.retry_after_seconds = None
        attempt.updated_at = func.now()
        db.commit()
        return True
    except Exception as exc:
        # A quota or billing refusal is the caller's answer, not a queue failure:
        # the attempt is settled failed and the refusal is re-raised.
        quota_refusal = isinstance(exc, ApiError) and exc.code in {
            ApiErrorCode.E_BILLING_REQUIRED,
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
        }
        if not quota_refusal:
            db.rollback()
        _fail_source_attempt(
            db,
            media_id=media_id,
            attempt_id=attempt_id,
            exc=exc,
            stage=failure_stage,
            execution_id=absent(),
        )
        db.commit()
        if quota_refusal:
            raise
        return False


def _admit_requeued_transcript(
    db: Session, media: Media, attempt: MediaSourceAttempt, actor_user_id: UUID
) -> None:
    """A transcript requeue re-enters the podcast quota admission; nothing else does."""
    if attempt.source_type != source_types.PODCAST_EPISODE_TRANSCRIPT:
        return
    from nexus.services.podcasts.transcription import (
        PodcastTranscriptionRejectedQuota,
        admit_generated_podcast_transcription_for_source_attempt,
    )

    admission = admit_generated_podcast_transcription_for_source_attempt(
        db,
        media_id=media.id,
        requested_by_user_id=actor_user_id,
        request_reason=require_transcript_request_reason(
            dict(attempt.source_payload or {}).get("request_reason")
        ),
    )
    if isinstance(admission, PodcastTranscriptionRejectedQuota):
        raise admission.error


def _verify_source_storage(db: Session, *, media_id: UUID, attempt_id: UUID) -> None:
    """Head the stored source object with no database transaction open."""
    attempt = db.get(MediaSourceAttempt, attempt_id)
    source_path: str | None = None
    if attempt is not None and attempt.media_id == media_id:
        if attempt.source_type in source_types.LOCAL_FILE_SOURCE_TYPES:
            source_path = db.scalar(
                select(MediaFile.storage_path).where(MediaFile.media_id == media_id)
            )
            if not source_path:
                raise InvalidRequestError(
                    ApiErrorCode.E_STORAGE_MISSING, "Source file metadata is missing."
                )
        elif attempt.source_type == source_types.BROWSER_ARTICLE_CAPTURE:
            source_path = str((attempt.source_payload or {}).get("storage_path") or "")
            if not source_path:
                raise InvalidRequestError(
                    ApiErrorCode.E_STORAGE_MISSING, "Captured article source artifact is missing."
                )
    db.rollback()
    if source_path is None:
        return
    try:
        metadata = get_storage_client().head_object(source_path)
    except StorageError as exc:
        raise ApiError(
            ApiErrorCode.E_STORAGE_ERROR, "Failed to verify source storage before retry."
        ) from exc
    if metadata is None:
        raise InvalidRequestError(
            ApiErrorCode.E_STORAGE_MISSING, "Source storage object is missing."
        )


def ensure_stale_source_attempt_job(
    db: Session, *, media_id: UUID, attempt_id: UUID, request_id: str | None
) -> str:
    """Ensure one stale nonterminal attempt still has its canonical queue owner."""
    media = db.scalar(select(Media).where(Media.id == media_id).with_for_update(key_share=True))
    if media is None:
        return "skipped"
    attempt = db.scalar(
        select(MediaSourceAttempt).where(MediaSourceAttempt.id == attempt_id).with_for_update()
    )
    if attempt is None or attempt.media_id != media.id or attempt.status not in IN_FLIGHT_STATUSES:
        return "skipped"
    if attempt.job_id is not None:
        job = lock_job(db, attempt.job_id)
        if job is not None:
            if job.status == "dead":
                return "suspended"
            return "deduplicated" if job.status in {"pending", "failed", "running"} else "skipped"
    actor_user_id = attempt.created_by_user_id or media.created_by_user_id
    if actor_user_id is None:
        return "skipped"
    job = _enqueue_source_job(db, media.id, attempt.id, actor_user_id, request_id)
    attempt.job_id = job.id
    attempt.status = QUEUED
    attempt.retry_after_seconds = None
    attempt.updated_at = func.now()
    return "enqueued"


# =============================================================================
# Recovery admissions
# =============================================================================


def retry_source_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    client_mutation_id: str,
    expected_attempt_id: UUID,
    request_id: str | None,
) -> SourceRetryAdmission:
    """Admit one new source attempt for a terminally failed source.

    A read-committed pre-check heads the stored source with no transaction open,
    then the serializable admission re-checks authority, the inspected attempt
    and the owner policy before cloning the attempt and enqueueing its one job in
    the same commit that records the replay receipt.
    """
    scope = f"media_source_retry:{media_id}"
    request_bytes = canonical_json_bytes({"expected_attempt_id": str(expected_attempt_id)})
    _load_owned_media(db, viewer_id, media_id, lock=False)
    inspected = _latest_attempt(db, media_id)
    if inspected is not None:
        _verify_source_storage(db, media_id=media_id, attempt_id=inspected.id)
    db.rollback()

    def admit() -> SourceRetryAdmission:
        replay = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
        )
        if replay is not None:
            db.rollback()
            return SourceRetryAdmission.model_validate(replay)
        media = _load_owned_media(db, viewer_id, media_id, lock=True)
        attempt = _lock_latest_attempt(db, media.id)
        if attempt is None:
            raise ConflictError(
                ApiErrorCode.E_RETRY_NOT_ALLOWED,
                "Source retry is not available for media without a source attempt.",
            )
        if attempt.id != expected_attempt_id:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected source attempt is no longer current.",
                details={"current": {"attempt_id": str(attempt.id)}},
            )
        offer = source_recovery(
            _recovery_facts(db, media=media, attempt=attempt, is_creator=True, is_operator=False)
        )
        match offer:
            case RetrySourceOffer():
                pass
            case RepairSourceOffer():
                raise ConflictError(
                    ApiErrorCode.E_RETRY_NOT_ALLOWED,
                    "Processing stopped before this import finished. Imports offers Retry "
                    "stopped processing, which runs the stopped attempt again without "
                    "creating a new one.",
                )
            case "NotOwner" | "SameSourceTerminal" | "SourceNotReacquirable":
                raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, _RESTRICTION_MESSAGES[offer])
            case None:
                raise ConflictError(
                    ApiErrorCode.E_RETRY_NOT_ALLOWED, "Latest source attempt is not retryable."
                )
        retry_attempt = _clone_attempt(
            db,
            media=media,
            viewer_id=viewer_id,
            previous=attempt,
            request_id=request_id,
            intent_key=_action_intent_key(
                "retry", media_id=media.id, previous_attempt_id=attempt.id
            ),
        )
        _admit_requeued_transcript(db, media, retry_attempt, viewer_id)
        mark_source_queued(db, media)
        bump_all_media_fact_collections(db)
        job_id = enqueue_accepted_source_attempt_in_transaction(
            db,
            media_id=media.id,
            attempt_id=retry_attempt.id,
            actor_user_id=viewer_id,
            request_id=request_id,
        )
        _record_event(
            db,
            media_id=media.id,
            attempt=attempt,
            facts=SourceRecoveryAccepted(
                source_attempt_id=attempt.id,
                recovery=RetrySourceRecovery(new_source_attempt_id=retry_attempt.id),
            ),
            failure_code=absent(),
        )
        admission = SourceRetryAdmission(
            media_id=media.id,
            source_attempt_id=retry_attempt.id,
            job_id=job_id,
        )
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=client_mutation_id,
            request_bytes=request_bytes,
            response_json=admission.model_dump(mode="json"),
        )
        db.commit()
        return admission

    return admit_serializable(db, "retry_source_for_viewer", admit)


def repair_dead_source_execution(
    db: Session,
    *,
    actor: RecoveryActor,
    media_id: UUID,
    expected_attempt_id: UUID,
    expected_job_id: UUID,
) -> SourceRepairAdmission:
    """Requeue the exact dead job of one still-nonterminal source attempt."""
    scope = f"media_source_repair:{media_id}"
    request_bytes = canonical_json_bytes(
        {"expected_attempt_id": str(expected_attempt_id), "expected_job_id": str(expected_job_id)}
    )

    def admit() -> SourceRepairAdmission:
        is_creator, is_operator = False, isinstance(actor, OperatorRecovery)
        if isinstance(actor, ViewerRecovery):
            if not can_read_media(db, actor.viewer_id, media_id):
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            creator_id = db.scalar(select(Media.created_by_user_id).where(Media.id == media_id))
            if creator_id is None:
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            if creator_id != actor.viewer_id:
                raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")
            is_creator = True
            replay = lookup_replay(
                db,
                viewer_id=actor.viewer_id,
                scope=scope,
                client_mutation_id=actor.client_mutation_id,
                request_bytes=request_bytes,
            )
            if replay is not None:
                db.rollback()
                return SourceRepairAdmission.model_validate(replay)
        media = db.execute(
            select(Media).where(Media.id == media_id).with_for_update(key_share=True)
        ).scalar()
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        attempt = _lock_latest_attempt(db, media.id)
        if attempt is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED,
                "Source repair is not available for media without a source attempt.",
            )
        offer = source_recovery(
            _recovery_facts(
                db, media=media, attempt=attempt, is_creator=is_creator, is_operator=is_operator
            )
        )
        if (attempt.id, attempt.job_id) != (expected_attempt_id, expected_job_id):
            current: dict[str, object] = {"attempt_id": str(attempt.id)}
            if attempt.job_id is not None:
                current["job_id"] = str(attempt.job_id)
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The inspected source execution is no longer current.",
                details={"current": current},
            )
        if not isinstance(offer, RepairSourceOffer):
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED,
                "No exact current dead source execution is repairable.",
            )
        if not requeue_dead_job(db, job_id=offer.expected_job_id):
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED,
                "No exact current dead source execution is repairable.",
            )
        _record_event(
            db,
            media_id=media.id,
            attempt=attempt,
            facts=SourceRecoveryAccepted(
                source_attempt_id=attempt.id,
                recovery=RepairSourceRecovery(job_id=offer.expected_job_id),
            ),
            failure_code=absent(),
        )
        admission = SourceRepairAdmission(
            media_id=media.id, source_attempt_id=attempt.id, job_id=offer.expected_job_id
        )
        if isinstance(actor, ViewerRecovery):
            record_replay(
                db,
                viewer_id=actor.viewer_id,
                scope=scope,
                client_mutation_id=actor.client_mutation_id,
                request_bytes=request_bytes,
                response_json=admission.model_dump(mode="json"),
            )
        db.commit()
        return admission

    return admit_serializable(db, "repair_dead_source_execution", admit)


def refresh_source_for_viewer(
    *, db: Session, viewer_id: UUID, media_id: UUID, request_id: str | None
) -> dict[str, object]:
    """Clone and requeue the latest attempt of a settled, re-acquirable source."""
    media = _load_owned_media(db, viewer_id, media_id, lock=True)
    if media.processing_status not in {
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.failed,
    }:
        raise ConflictError(
            ApiErrorCode.E_MEDIA_NOT_READY,
            "Media source refresh is not available in the current processing state.",
        )
    attempt = _latest_attempt(db, media.id)
    if attempt is None:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source refresh is not available for media without a source attempt.",
        )
    if attempt.status in IN_FLIGHT_STATUSES:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE, "Source ingest is already queued or running."
        )
    _raise_if_not_reacquirable(media, attempt)
    refresh_attempt = _clone_attempt(
        db,
        media=media,
        viewer_id=viewer_id,
        previous=attempt,
        request_id=request_id,
        intent_key=_action_intent_key("refresh", media_id=media.id, previous_attempt_id=attempt.id),
    )
    db.commit()
    enqueued = _enqueue_attempt(
        db,
        media_id=media.id,
        attempt_id=refresh_attempt.id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage=source_attempt_failure_stage(refresh_attempt.source_type),
        requeue=True,
    )
    from nexus.services.media import get_media_for_viewer

    reloaded = db.get(Media, media.id) or media
    attempt_now = db.get(MediaSourceAttempt, refresh_attempt.id) or refresh_attempt
    return {
        "media_id": str(reloaded.id),
        "source_attempt_id": str(attempt_now.id),
        "source_type": attempt_now.source_type,
        "source_attempt_status": attempt_now.status,
        "idempotency_outcome": "refreshed",
        "processing_status": reloaded.processing_status.value,
        "ingest_enqueued": enqueued,
        "capabilities": get_media_for_viewer(db, viewer_id, media.id).capabilities.model_dump(),
    }


@dataclass(frozen=True, slots=True)
class SystemSourceRepairResult:
    media_id: UUID
    source_attempt_id: UUID | None
    action: str
    ingest_enqueued: bool
    processing_status: str


def repair_source_for_system_media(
    *, db: Session, actor_user_id: UUID, media_id: UUID, request_id: str | None, reason: str
) -> SystemSourceRepairResult:
    """Repair source-backed system media through the same durable attempt substrate."""
    media = db.execute(
        select(Media).where(Media.id == media_id).with_for_update(key_share=True)
    ).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != actor_user_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN, "Only the source owner can repair system media."
        )
    attempt = _latest_attempt(db, media.id)
    if attempt is None:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Source repair is not available for media without a source attempt.",
        )
    if attempt.status in {QUEUED, RUNNING}:
        return SystemSourceRepairResult(
            media_id=media.id,
            source_attempt_id=attempt.id,
            action="already_in_flight",
            ingest_enqueued=False,
            processing_status=media.processing_status.value,
        )
    if attempt.status == ACCEPTED:
        enqueued = _enqueue_attempt(
            db,
            media_id=media.id,
            attempt_id=attempt.id,
            actor_user_id=actor_user_id,
            request_id=request_id,
            failure_stage=source_attempt_failure_stage(attempt.source_type),
            requeue=True,
        )
        return _system_repair_result(db, media.id, attempt.id, "queued", enqueued)
    if media.processing_status != ProcessingStatus.failed and attempt.status != FAILED:
        return SystemSourceRepairResult(
            media_id=media.id,
            source_attempt_id=attempt.id,
            action="not_needed",
            ingest_enqueued=False,
            processing_status=media.processing_status.value,
        )
    if attempt.status != FAILED:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE, "Latest source attempt is not repairable."
        )
    _raise_if_not_reacquirable(media, attempt)
    repair_attempt = _clone_attempt(
        db,
        media=media,
        viewer_id=actor_user_id,
        previous=attempt,
        request_id=request_id,
        intent_key=_action_intent_key(
            "system_repair", media_id=media.id, previous_attempt_id=attempt.id
        ),
    )
    repair_attempt.source_payload = {
        **dict(repair_attempt.source_payload or {}),
        "system_repair_reason": reason,
    }
    db.commit()
    enqueued = _enqueue_attempt(
        db,
        media_id=media.id,
        attempt_id=repair_attempt.id,
        actor_user_id=actor_user_id,
        request_id=request_id,
        failure_stage=source_attempt_failure_stage(repair_attempt.source_type),
        requeue=True,
    )
    return _system_repair_result(db, media.id, repair_attempt.id, "repair_queued", enqueued)


def _system_repair_result(
    db: Session, media_id: UUID, attempt_id: UUID, action: str, enqueued: bool
) -> SystemSourceRepairResult:
    media = db.get(Media, media_id)
    return SystemSourceRepairResult(
        media_id=media_id,
        source_attempt_id=attempt_id,
        action=action,
        ingest_enqueued=enqueued,
        processing_status=media.processing_status.value if media is not None else "failed",
    )


def _raise_if_not_reacquirable(media: Media, attempt: MediaSourceAttempt) -> None:
    """Refuse on ``media.last_error_code`` — the exact column the offer read."""
    restriction = _reacquisition_restriction(
        source_type=attempt.source_type, error_code=media.last_error_code
    )
    if restriction is not None:
        raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, _RESTRICTION_MESSAGES[restriction])


def _load_owned_media(db: Session, viewer_id: UUID, media_id: UUID, *, lock: bool) -> Media:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    statement = select(Media).where(Media.id == media_id)
    media = db.execute(statement.with_for_update(key_share=True) if lock else statement).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN, "Only the creator can retry or refresh source content."
        )
    return media


# =============================================================================
# Running one attempt
# =============================================================================


@dataclass(frozen=True, slots=True)
class SourceRunOutcome:
    """One adapter's closed result, decoded once for the runner."""

    log: dict[str, object]
    observations: tuple[SourceAuthorObservation, ...]
    superseded_by_media_id: UUID | None
    additional_reindex_media_ids: tuple[UUID, ...] = ()
    warning_error_code: str | None = None
    transcript_semantic_intent: bool = False
    transcript_request_reason: object = None
    metadata_enrichment: bool = False

    @classmethod
    def of(cls, result: dict[str, object]) -> SourceRunOutcome:
        # The observations hold credited names and must never reach the logged
        # or returned job result, so they are drained, not read.
        observations = tuple(take_author_observations(result))
        reindex = result.pop("additional_reindex_media_ids", [])
        superseded = result.get("superseded_by_media_id")
        return cls(
            log=result,
            observations=observations,
            superseded_by_media_id=UUID(str(superseded)) if superseded else None,
            additional_reindex_media_ids=tuple(
                UUID(str(value)) for value in (reindex if isinstance(reindex, list) else [])
            ),
            warning_error_code=(
                str(result["warning_error_code"]) if result.get("warning_error_code") else None
            ),
            transcript_semantic_intent=bool(result.get("transcript_semantic_intent")),
            transcript_request_reason=result.get("transcript_request_reason"),
            metadata_enrichment=bool(result.get("metadata_enrichment")),
        )


def run_source_attempt(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
    context: JobExecutionContext,
) -> dict[str, object]:
    """Run one queued source attempt and persist its terminal state."""
    fence = SourcePublicationFence.from_context(attempt_id=attempt_id, context=context)
    try:
        return _run_fenced_attempt(
            session_factory=session_factory,
            media_id=media_id,
            attempt_id=attempt_id,
            actor_user_id=actor_user_id,
            request_id=request_id,
            fence=fence,
        )
    except SourcePublicationSuperseded:
        return {"status": "superseded"}


def _run_fenced_attempt(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
    fence: SourcePublicationFence,
) -> dict[str, object]:
    from nexus.services.media_source_adapters import run_source_adapter

    def mark_running(db: Session, attempt: MediaSourceAttempt) -> None:
        attempt.status = RUNNING
        attempt.run_count = int(attempt.run_count or 0) + 1
        attempt.started_at = func.now()
        attempt.updated_at = func.now()
        reset_source_progress(attempt)
        _record_event(
            db,
            media_id=media_id,
            attempt=attempt,
            facts=SourceExecutionStarted(
                source_attempt_id=attempt.id, execution_id=fence.execution_id
            ),
            failure_code=absent(),
        )

    run_source_publication_phase(
        session_factory=session_factory,
        label="mark_source_attempt_running",
        fence=fence,
        media_ids=(media_id,),
        mutate=mark_running,
    )

    # Adapters receive an immutable detached snapshot: keeping a transaction open
    # across a provider or object-store call would violate the source I/O boundary.
    snapshot_db = session_factory()
    try:
        attempt = snapshot_db.get(MediaSourceAttempt, attempt_id)
        if attempt is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Running source attempt disappeared.")
        snapshot_db.expunge(attempt)
        snapshot_db.rollback()
    finally:
        snapshot_db.close()

    try:
        result = run_source_adapter(
            session_factory=session_factory,
            media_id=media_id,
            attempt=attempt,
            actor_user_id=actor_user_id,
            request_id=request_id,
            fence=fence,
        )
    except SourcePublicationSuperseded:
        raise
    except Exception as exc:
        if not _is_terminal_source_failure(exc, source_type=attempt.source_type):
            raise
        return _publish_terminal_failure(
            session_factory, media_id=media_id, attempt_id=attempt_id, exc=exc, fence=fence
        )

    outcome = SourceRunOutcome.of(result)
    superseded_storage_paths: list[str] = []
    terminal_media_id = media_id
    if outcome.superseded_by_media_id is not None and outcome.superseded_by_media_id != media_id:
        winner_media_id = outcome.superseded_by_media_id
        superseded_storage_paths = run_source_publication_phase(
            session_factory=session_factory,
            label="publish_source_media_supersession",
            fence=fence,
            media_ids=(media_id, winner_media_id),
            mutate=lambda db, locked: _supersede_source_media(
                db, attempt=locked, loser_media_id=media_id, winner_media_id=winner_media_id
            ),
        )
        terminal_media_id = winner_media_id

    # The attempt and the queue payload stay anchored to the originally accepted
    # media: the queue claim's identity is (media_id, attempt_id).
    base_media_ids = {
        media_id,
        terminal_media_id,
        *outcome.additional_reindex_media_ids,
        *(observed for observed, _obs, _src in outcome.observations if observed is not None),
    }
    discover = _document_embed_owners(base_media_ids)

    if outcome.observations:
        run_source_publication_phase(
            session_factory=session_factory,
            label="apply_contributor_observations",
            fence=fence,
            media_ids=tuple(sorted(base_media_ids)),
            mutate=lambda db, _attempt: _apply_observations(db, terminal_media_id, outcome),
            discover=discover,
        )
    run_source_publication_phase(
        session_factory=session_factory,
        label="publish_source_attempt_terminal",
        fence=fence,
        media_ids=tuple(sorted(base_media_ids)),
        mutate=lambda db, locked: _publish_terminal_attempt(
            db,
            attempt=locked,
            terminal_media_id=terminal_media_id,
            outcome=outcome,
            request_id=request_id,
            execution_id=fence.execution_id,
        ),
        discover=discover,
    )
    if attempt.created_by_user_id is not None and outcome.metadata_enrichment:
        post_success_db = session_factory()
        try:
            if try_enqueue_metadata_enrichment(
                post_success_db,
                media_id=terminal_media_id,
                requester_user_id=attempt.created_by_user_id,
                request_id=request_id,
            ):
                post_success_db.commit()
        finally:
            post_success_db.close()
    delete_document_storage_objects(superseded_storage_paths)
    return outcome.log


def _document_embed_owners(media_ids: set[UUID]) -> Callable[[Session], list[UUID]]:
    """Every media that embeds one of these as a target must be locked with them."""

    def discover(db: Session) -> list[UUID]:
        return [
            UUID(str(value))
            for value in db.scalars(
                text(
                    """
                    SELECT DISTINCT media_id
                    FROM document_embeds
                    WHERE target_media_id = ANY(:target_media_ids)
                    """
                ),
                {"target_media_ids": sorted(media_ids)},
            ).all()
        ]

    return discover


def _apply_observations(db: Session, terminal_media_id: UUID, outcome: SourceRunOutcome) -> None:
    media = db.get(Media, terminal_media_id)
    if media is None or media.processing_status == ProcessingStatus.failed:
        return
    for observed_media_id, observation, source in outcome.observations:
        if isinstance(observation, NotObserved):
            continue
        apply_observed_role_slices_in_current_transaction(
            db,
            target=MediaTarget(observed_media_id or terminal_media_id),
            observation=cast(ContributorObservationBatch, observation),
            source=source,
        )


def _publish_terminal_attempt(
    db: Session,
    *,
    attempt: MediaSourceAttempt,
    terminal_media_id: UUID,
    outcome: SourceRunOutcome,
    request_id: str | None,
    execution_id: UUID,
) -> None:
    """Settle the attempt against the terminal media's own published outcome."""
    media = db.get(Media, terminal_media_id)
    if media is None:
        raise SourcePublicationSuperseded("terminal_media_disappeared")
    if media.processing_status == ProcessingStatus.failed:
        attempt.status = FAILED
        attempt.error_code = media.last_error_code
        attempt.error_message = media.last_error_message
        attempt.retry_after_seconds = None
        _record_event(
            db,
            media_id=attempt.media_id,
            attempt=attempt,
            facts=SourceFailed(
                source_attempt_id=attempt.id,
                execution_id=present(execution_id),
                origin="Domain",
                terminal=True,
                progress=source_failure_progress(
                    processing_stage=attempt.processing_stage,
                    progress_completed=int(attempt.progress_completed or 0),
                    progress_total=attempt.progress_total,
                    progress_unit=attempt.progress_unit,
                ),
            ),
            failure_code=present(_failed_media_code(media)),
        )
    else:
        if media.processing_status == ProcessingStatus.extracting:
            mark_ready_for_reading(db, media)
        attempt.status = SUCCEEDED
        attempt.error_code = None
        attempt.error_message = None
        attempt.retry_after_seconds = None
        _record_event(
            db,
            media_id=attempt.media_id,
            attempt=attempt,
            facts=SourceSucceeded(source_attempt_id=attempt.id, execution_id=present(execution_id)),
            failure_code=absent(),
        )
        if outcome.warning_error_code == "E_PDF_TEXT_UNAVAILABLE":
            mark_stage_warning(
                db,
                media,
                stage="extract",
                error_code="E_PDF_TEXT_UNAVAILABLE",
                error_message="PDF text is unavailable; OCR is required.",
            )
        bump_all_media_fact_collections(db)
        if outcome.transcript_semantic_intent:
            enqueue_transcript_semantic_job(
                db,
                media_id=terminal_media_id,
                request_reason=require_transcript_request_reason(outcome.transcript_request_reason),
            )
        if media.kind in {
            MediaKind.web_article.value,
            MediaKind.epub.value,
            MediaKind.pdf.value,
        }:
            from nexus.services.content_indexing import request_media_content_reindex

            for reindex_media_id in (terminal_media_id, *outcome.additional_reindex_media_ids):
                request_media_content_reindex(
                    db,
                    media_id=reindex_media_id,
                    reason="source_success",
                    request_id=request_id,
                )
    attempt.finished_at = func.now()
    attempt.updated_at = func.now()
    for synced_media_id in (terminal_media_id, *outcome.additional_reindex_media_ids):
        _sync_document_embed_targets(db, synced_media_id)


def _publish_terminal_failure(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    attempt_id: UUID,
    exc: Exception,
    fence: SourcePublicationFence,
) -> dict[str, object]:
    def publish(db: Session, attempt: MediaSourceAttempt) -> None:
        _fail_source_attempt(
            db,
            media_id=media_id,
            attempt_id=attempt_id,
            exc=exc,
            stage=source_attempt_failure_stage(attempt.source_type),
            execution_id=present(fence.execution_id),
        )
        _sync_document_embed_targets(db, media_id)

    run_source_publication_phase(
        session_factory=session_factory,
        label="publish_source_attempt_failure",
        fence=fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=_document_embed_owners({media_id}),
    )
    error_code, error_message = _source_error_fields(exc)
    return {"status": "failed", "error_code": error_code, "error_message": error_message}


def _sync_document_embed_targets(db: Session, media_id: UUID) -> None:
    from nexus.services.document_embeds import sync_document_embed_targets_for_media

    sync_document_embed_targets_for_media(db, target_media_id=media_id)


def _supersede_source_media(
    db: Session,
    *,
    attempt: MediaSourceAttempt,
    loser_media_id: UUID,
    winner_media_id: UUID,
) -> list[str]:
    """Transfer the loser's membership and edges to the winner, then delete it."""
    if source_attempt_storage_paths(attempt.source_payload):
        # Otherwise the loser's R2 objects die while the payload still names them.
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Source attempt storage artifacts must be rehomed before canonical dedupe.",
        )
    _record_event(
        db,
        media_id=loser_media_id,
        attempt=attempt,
        facts=SourceSuperseded(source_attempt_id=attempt.id, winner_media_id=winner_media_id),
        failure_code=absent(),
    )
    # Ascending-id order is the deadlock discipline two concurrent thread
    # ingests that discover each other depend on.
    library_entries.lock_media_rows_in_order(db, [loser_media_id, winner_media_id])
    if attempt.created_by_user_id is not None:
        target_library_ids = _library_ids_from_payload(attempt.source_payload)
        library_governance.lock_library_rows_in_order(
            db,
            [
                *library_entries.library_ids_for_media(db, loser_media_id),
                library_governance.default_library_id_for_user(db, attempt.created_by_user_id),
                *library_governance.resolve_writable_non_default_library_ids(
                    db, attempt.created_by_user_id, target_library_ids
                ),
            ],
        )
        library_entries.assign_libraries_for_media_in_current_transaction(
            db, attempt.created_by_user_id, winner_media_id, target_library_ids
        )
    return delete_duplicate_document_media(
        db, loser_media_id=loser_media_id, winner_media_id=winner_media_id
    )


def _library_ids_from_payload(payload: dict[str, object] | None) -> list[UUID]:
    raw_ids = (payload or {}).get("library_ids")
    library_ids: list[UUID] = []
    for raw_id in raw_ids if isinstance(raw_ids, list) else []:
        try:
            library_ids.append(UUID(str(raw_id)))
        except (TypeError, ValueError):
            continue
    return library_ids


# =============================================================================
# Failure publication
# =============================================================================


def _store_and_enqueue(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    viewer_id: UUID,
    request_id: str | None,
    writes: tuple[tuple[str, bytes, str], ...],
) -> FromUrlResponse:
    """The tail every accept surface shares: store the artifacts, then queue the run.

    Each write reserves its durable final sweep first, so a crash leaves a
    reservation the sweeper collects rather than orphan bytes; a write that
    fails settles the accepted attempt visibly instead of dropping the source.
    """
    storage_client = get_storage_client()
    try:
        for path, payload, content_type in writes:
            reserve_storage_object_write(db, media_id=media_id, storage_path=path)
            storage_client.put_object(path, payload, content_type)
            finalize_storage_object_write(
                db, media_id=media_id, storage_path=path, storage_client=storage_client
            )
    except Exception as exc:
        return _fail_accepted_source(
            db, media_id=media_id, attempt_id=attempt_id, exc=exc, stage="upload"
        )
    enqueued = _enqueue_attempt(
        db,
        media_id=media_id,
        attempt_id=attempt_id,
        actor_user_id=viewer_id,
        request_id=request_id,
        failure_stage="extract",
        requeue=False,
    )
    return _reloaded_response(db, media_id, attempt_id, "created", ingest_enqueued=enqueued)


def _fail_accepted_source(
    db: Session, *, media_id: UUID, attempt_id: UUID, exc: Exception, stage: str
) -> FromUrlResponse:
    """Settle an accepted attempt that failed before it ever reached the queue."""
    _fail_source_attempt(
        db, media_id=media_id, attempt_id=attempt_id, exc=exc, stage=stage, execution_id=absent()
    )
    db.commit()
    return _reloaded_response(db, media_id, attempt_id, "created", ingest_enqueued=False)


def _reloaded_response(
    db: Session,
    media_id: UUID,
    attempt_id: UUID,
    outcome: Literal["created", "reused", "retrying", "refreshed"],
    *,
    ingest_enqueued: bool,
) -> FromUrlResponse:
    media = db.get(Media, media_id)
    attempt = db.get(MediaSourceAttempt, attempt_id)
    if media is None or attempt is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return _from_url_response(media, attempt, outcome, ingest_enqueued=ingest_enqueued)


def _fail_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    attempt_id: UUID,
    exc: Exception,
    stage: str,
    execution_id: Presence[UUID],
) -> None:
    error_code, error_message = _source_error_fields(exc)
    # The failure record otherwise lives only in the attempt row: without this
    # line a terminally failed capture leaves no trace in any log stream.
    logger.warning(
        "source_attempt_failed",
        media_id=str(media_id),
        attempt_id=str(attempt_id),
        stage=stage,
        error_code=error_code,
        error_message=error_message,
    )
    publish_source_attempt_failure(
        db,
        SourceAttemptFailure(
            media_id=media_id,
            attempt_id=attempt_id,
            failure_stage=require_media_failure_stage(stage),
            error_code=error_code,
            error_message=error_message,
            retry_after_seconds=_retry_after_seconds(exc),
            now=datetime.now(UTC),
            execution_id=execution_id,
        ),
    )


def _source_error_fields(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, ApiError):
        return exc.code.value, exc.message
    if isinstance(exc, StorageError):
        return exc.code, exc.message
    return ApiErrorCode.E_INGEST_FAILED.value, str(exc)


def _retry_after_seconds(exc: Exception) -> int | None:
    retry_after = getattr(exc, "retry_after_seconds", None)
    try:
        return max(0, int(retry_after)) if retry_after is not None else None
    except (TypeError, ValueError):
        return None


def _is_terminal_source_failure(exc: Exception, *, source_type: str) -> bool:
    """Only a terminal code settles the attempt; everything else re-raises to the queue."""
    if not isinstance(exc, ApiError):
        return False
    if (
        source_type == source_types.GENERIC_WEB_URL
        and exc.code is ApiErrorCode.E_SOURCE_FETCH_FAILED
    ):
        return exc.message in {"HTTP error: 404", "HTTP error: 410"}
    return exc.code.value in _TERMINAL_SOURCE_FAILURE_CODES


def _remote_file_name(url: str, kind: str) -> str:
    name = unquote(posixpath.basename(urlparse(url).path)).strip()
    return name or f"download.{get_file_extension(kind)}"
