"""Podcast transcript admission, execution, and repair services."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from nexus.coerce import coerce_positive_int
from nexus.db.errors import integrity_constraint_name
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import (
    MediaProcessingStatus,
    TranscriptRequestResponse,
)
from nexus.schemas.media import (
    TranscriptRequestReason as TranscriptResponseReason,
)
from nexus.schemas.podcast import (
    PodcastEpisodeQueryTranscriptForecastOut,
    PodcastEpisodeQueryTranscriptRequestOut,
    PodcastEpisodeQueryTranscriptTarget,
)
from nexus.schemas.presence import absent, present
from nexus.services.billing import get_transcription_usage
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.services.source_publication import (
    SourcePublicationFence,
    run_source_publication_phase,
)
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import (
    TranscriptRequestReason,
    ensure_media_transcript_state_row,
    publish_source_transcript,
    set_media_transcript_state,
)

from .deepgram_adapter import (
    get_deepgram_client,
)
from .episodes import (
    episode_selection_fingerprint,
    resolve_transcript_eligible_episode_ids,
)

logger = get_logger(__name__)

PODCAST_TRANSCRIPT_REQUEST_REASONS = {
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
    "rss_feed",
}


def _bump_episode_row_collections(db: Session, *, viewer_id: UUID) -> None:
    bump_collection_families(
        db,
        viewer_ids=(viewer_id,),
        families=(
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastEpisodes,
        ),
    )


def _bump_all_episode_row_collections(db: Session) -> None:
    bump_all_collection_families(
        db,
        families=(
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastEpisodes,
        ),
    )


@dataclass(frozen=True)
class TranscriptionRunResult:
    """Worker result for a single podcast transcription run."""

    status: Literal["skipped", "failed", "completed"]
    reason: str | None = None
    job_status: str | None = None
    error_code: str | None = None
    segment_count: int | None = None
    provider_fixture: dict[str, Any] | None = None


def _semantic_index_requires_repair(
    db: Session,
    *,
    media_id: UUID,
) -> bool:
    """Whether active transcript evidence is absent or stale."""
    embedding_model = current_transcript_embedding_model()
    embedding_provider = current_transcript_embedding_provider()
    row = db.execute(
        text(
            """
            SELECT
                mcis.status,
                mcis.active_embedding_provider,
                mcis.active_embedding_model
            FROM content_index_states mcis
            WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        return True
    return row[0] != "ready" or row[1] != embedding_provider or row[2] != embedding_model


def request_podcast_transcript_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    reason: str,
    dry_run: bool = False,
    request_id: str | None = None,
    _auto_commit: bool = True,
) -> TranscriptRequestResponse:
    from nexus.auth.permissions import can_read_media

    normalized_reason = str(reason or "").strip()
    if normalized_reason not in PODCAST_TRANSCRIPT_REQUEST_REASONS:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid transcript request reason",
        )

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    now = datetime.now(UTC)
    usage_date = now.date()
    media_row = db.execute(
        text(
            """
            SELECT
                m.kind,
                m.processing_status,
                m.last_error_code,
                (
                    SELECT pe.duration_seconds
                    FROM podcast_episodes pe
                    WHERE pe.media_id = m.id
                ) AS duration_seconds,
                (
                    SELECT j.status
                    FROM podcast_transcription_jobs j
                    WHERE j.media_id = m.id
                ) AS job_status,
                (
                    SELECT mts.transcript_state
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS transcript_state,
                (
                    SELECT mts.transcript_coverage
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS transcript_coverage,
                (
                    SELECT mts.semantic_status
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS semantic_status
            FROM media m
            WHERE m.id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_kind = str(media_row[0] or "")
    processing_status = str(media_row[1] or "")
    duration_seconds = coerce_positive_int(media_row[3])
    job_status = str(media_row[4] or "").strip() or None
    transcript_state = str(media_row[5] or "").strip() or None
    transcript_coverage = str(media_row[6] or "").strip() or None
    semantic_status = str(media_row[7] or "").strip() or "none"

    if media_kind != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript request is only supported for podcast episodes.",
        )

    required_minutes = max(1, (duration_seconds + 59) // 60) if duration_seconds else 1
    entitlements = get_effective_entitlements(db, viewer_id)
    if not entitlements.can_transcribe:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Transcription requires an AI tier.")

    if transcript_state is None:
        ensure_media_transcript_state_row(
            db,
            media_id=media_id,
            now=now,
            request_reason=normalized_reason,
        )
        transcript_state = "not_requested"
        transcript_coverage = "none"

    monthly_limit_minutes = entitlements.transcription_minutes_limit_monthly
    usage_start_date = entitlements.usage_period_start.date()
    usage_end_date = entitlements.usage_period_end.date()
    usage_snapshot = get_transcription_usage(
        db,
        viewer_id,
        usage_start_date,
        usage_end_date,
    )
    consumed_minutes = int(usage_snapshot["used"]) + int(usage_snapshot["reserved"])
    remaining_minutes = (
        None
        if monthly_limit_minutes is None
        else max(0, int(monthly_limit_minutes) - consumed_minutes)
    )
    fits_budget = remaining_minutes is None or required_minutes <= remaining_minutes

    already_ready = transcript_state in {"ready", "partial"} and transcript_coverage in {
        "partial",
        "full",
    }
    semantic_needs_repair = already_ready and semantic_status in {"pending", "failed"}
    if (
        already_ready
        and not semantic_needs_repair
        and _semantic_index_requires_repair(
            db,
            media_id=media_id,
        )
    ):
        semantic_needs_repair = True
    already_inflight = transcript_state in {"queued", "running"} or job_status in {
        "pending",
        "running",
    }
    effective_status = (
        "ready_for_reading"
        if already_ready
        else "extracting"
        if already_inflight
        else processing_status
    )

    if dry_run:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=True,
            outcome="forecast",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=fits_budget,
            now=now,
        )
        if _auto_commit:
            db.commit()
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=cast(MediaProcessingStatus, effective_status),
            transcript_state=transcript_state or "not_requested",
            transcript_coverage=transcript_coverage or "none",
            request_reason=cast(TranscriptResponseReason, normalized_reason),
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=fits_budget,
            request_enqueued=False,
        )

    _bump_episode_row_collections(db, viewer_id=viewer_id)

    if semantic_needs_repair:
        semantic_repair_enqueued = _enqueue_podcast_semantic_repair_job(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            request_id=request_id,
        )
        if semantic_repair_enqueued:
            set_media_transcript_state(
                db,
                media_id=media_id,
                transcript_state=transcript_state or "ready",
                transcript_coverage=transcript_coverage or "full",
                semantic_status="pending",
                last_request_reason=normalized_reason,
                last_error_code=None,
                now=now,
            )

        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="queued" if semantic_repair_enqueued else "enqueue_failed",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            now=now,
        )
        if _auto_commit:
            db.commit()
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status="ready_for_reading",
            transcript_state=transcript_state or "ready",
            transcript_coverage=transcript_coverage or "full",
            request_reason=cast(TranscriptResponseReason, normalized_reason),
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            request_enqueued=semantic_repair_enqueued,
        )

    # Already queued/running/readable without semantic backlog: idempotent no-op.
    if already_ready or already_inflight:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="idempotent",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            now=now,
        )
        if _auto_commit:
            db.commit()
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=cast(MediaProcessingStatus, effective_status),
            transcript_state=transcript_state or ("ready" if already_ready else "queued"),
            transcript_coverage=transcript_coverage or ("full" if already_ready else "none"),
            request_reason=cast(TranscriptResponseReason, normalized_reason),
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            request_enqueued=False,
        )

    if not fits_budget:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="rejected_quota",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=False,
            now=now,
        )
        if _auto_commit:
            db.commit()
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Monthly transcription quota exceeded",
        )

    usage_snapshot_after = _reserve_usage_minutes_or_raise(
        db,
        user_id=viewer_id,
        usage_date=usage_date,
        usage_start_date=usage_start_date,
        usage_end_date=usage_end_date,
        required_minutes=required_minutes,
        monthly_limit_minutes=monthly_limit_minutes,
        now=now,
    )
    remaining_minutes_after = (
        None
        if monthly_limit_minutes is None
        else max(0, int(monthly_limit_minutes) - int(usage_snapshot_after["total"]))
    )

    existing_job_id = db.scalar(
        text("SELECT media_id FROM podcast_transcription_jobs WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    if existing_job_id is None:
        db.execute(
            text(
                """
                INSERT INTO podcast_transcription_jobs (
                    media_id,
                    requested_by_user_id,
                    request_reason,
                    reserved_minutes,
                    reservation_usage_date,
                    status,
                    error_code,
                    attempts,
                    started_at,
                    completed_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :media_id,
                    :requested_by_user_id,
                    :request_reason,
                    :reserved_minutes,
                    :reservation_usage_date,
                    'pending',
                    NULL,
                    0,
                    NULL,
                    NULL,
                    :created_at,
                    :updated_at
                )
                """
            ),
            {
                "media_id": media_id,
                "requested_by_user_id": viewer_id,
                "request_reason": normalized_reason,
                "reserved_minutes": required_minutes,
                "reservation_usage_date": usage_date,
                "created_at": now,
                "updated_at": now,
            },
        )
    else:
        db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET
                    requested_by_user_id = :requested_by_user_id,
                    request_reason = :request_reason,
                    reserved_minutes = :reserved_minutes,
                    reservation_usage_date = :reservation_usage_date,
                    status = 'pending',
                    error_code = NULL,
                    started_at = NULL,
                    completed_at = NULL,
                    updated_at = :updated_at
                WHERE media_id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "requested_by_user_id": viewer_id,
                "request_reason": normalized_reason,
                "reserved_minutes": required_minutes,
                "reservation_usage_date": usage_date,
                "updated_at": now,
            },
        )

    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="queued",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason=normalized_reason,
        last_error_code=None,
        now=now,
    )

    enqueued = _enqueue_podcast_transcript_source_attempt(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=normalized_reason,
        request_id=request_id,
    )
    if not enqueued:
        mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_INTERNAL.value,
            error_message="Failed to enqueue podcast transcription job",
            now=now,
        )
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            dry_run=False,
            outcome="enqueue_failed",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            now=now,
        )
        if _auto_commit:
            db.commit()
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status="failed",
            transcript_state="failed_provider",
            transcript_coverage="none",
            request_reason=cast(TranscriptResponseReason, normalized_reason),
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=True,
            request_enqueued=False,
        )

    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=normalized_reason,
        dry_run=False,
        outcome="queued",
        required_minutes=required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        now=now,
    )
    if _auto_commit:
        db.commit()
    return TranscriptRequestResponse(
        media_id=str(media_id),
        processing_status="extracting",
        transcript_state="queued",
        transcript_coverage="none",
        request_reason=cast(TranscriptResponseReason, normalized_reason),
        required_minutes=required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        request_enqueued=True,
    )


def forecast_podcast_episode_query_transcripts(
    db: Session,
    *,
    viewer_id: UUID,
    target: PodcastEpisodeQueryTranscriptTarget,
) -> PodcastEpisodeQueryTranscriptForecastOut:
    media_ids = resolve_transcript_eligible_episode_ids(
        db,
        viewer_id=viewer_id,
        podcast_id=target.podcast_id,
        selection=target.selection,
    )
    forecasts = [
        request_podcast_transcript_for_viewer(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            reason=target.reason,
            dry_run=True,
            _auto_commit=False,
        )
        for media_id in media_ids
    ]
    db.commit()
    required_minutes = sum(item.required_minutes for item in forecasts)
    remaining_values = [
        item.remaining_minutes for item in forecasts if item.remaining_minutes is not None
    ]
    remaining_minutes = min(remaining_values) if remaining_values else None
    return PodcastEpisodeQueryTranscriptForecastOut(
        eligible_count=len(media_ids),
        required_minutes=required_minutes,
        remaining_minutes=(
            present(remaining_minutes) if remaining_minutes is not None else absent()
        ),
        fits_budget=remaining_minutes is None or required_minutes <= remaining_minutes,
        selection_fingerprint=episode_selection_fingerprint(media_ids),
    )


def request_podcast_episode_query_transcripts(
    db: Session,
    *,
    viewer_id: UUID,
    target: PodcastEpisodeQueryTranscriptTarget,
    expected_fingerprint: str,
) -> PodcastEpisodeQueryTranscriptRequestOut:
    with transaction(db):
        media_ids = resolve_transcript_eligible_episode_ids(
            db,
            viewer_id=viewer_id,
            podcast_id=target.podcast_id,
            selection=target.selection,
        )
        actual_fingerprint = episode_selection_fingerprint(media_ids)
        if actual_fingerprint != expected_fingerprint:
            raise ConflictError(
                ApiErrorCode.E_SELECTION_CHANGED,
                "Episode selection changed before transcript request",
            )
        queued_count = 0
        for media_id in media_ids:
            admission = request_podcast_transcript_for_viewer(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                reason=target.reason,
                dry_run=False,
                _auto_commit=False,
            )
            queued_count += int(admission.request_enqueued)
        revision = read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.PodcastEpisodes,
        )
        return PodcastEpisodeQueryTranscriptRequestOut(
            matched_count=len(media_ids),
            queued_count=queued_count,
            collection_revision=revision,
        )


def prepare_podcast_transcription_for_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_reason: str,
) -> None:
    """Reset podcast transcript-domain rows for a durable source attempt.

    Caller owns authorization, media kind validation, media source status, and commit.
    """
    now = datetime.now(UTC)
    usage_date = now.date()
    media_row = db.execute(
        text(
            """
            SELECT
                m.kind,
                (
                    SELECT pe.duration_seconds
                    FROM podcast_episodes pe
                    WHERE pe.media_id = m.id
                ) AS duration_seconds
            FROM media m
            WHERE m.id = :media_id
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if str(media_row[0] or "") != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Podcast transcript source attempts must target podcast episode media.",
        )

    duration_seconds = coerce_positive_int(media_row[1])
    required_minutes = max(1, (duration_seconds + 59) // 60) if duration_seconds else 1
    entitlements = get_effective_entitlements(db, requested_by_user_id)
    if not entitlements.can_transcribe:
        raise ApiError(ApiErrorCode.E_BILLING_REQUIRED, "Transcription requires an AI tier.")

    monthly_limit_minutes = entitlements.transcription_minutes_limit_monthly
    usage_start_date = entitlements.usage_period_start.date()
    usage_end_date = entitlements.usage_period_end.date()
    usage_snapshot = get_transcription_usage(
        db,
        requested_by_user_id,
        usage_start_date,
        usage_end_date,
    )
    consumed_minutes = int(usage_snapshot["used"]) + int(usage_snapshot["reserved"])
    remaining_minutes = (
        None
        if monthly_limit_minutes is None
        else max(0, int(monthly_limit_minutes) - consumed_minutes)
    )
    fits_budget = remaining_minutes is None or required_minutes <= remaining_minutes
    if not fits_budget:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_reason=request_reason,
            dry_run=False,
            outcome="rejected_quota",
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=False,
            now=now,
        )
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Monthly transcription quota exceeded",
        )

    usage_snapshot_after = _reserve_usage_minutes_or_raise(
        db,
        user_id=requested_by_user_id,
        usage_date=usage_date,
        usage_start_date=usage_start_date,
        usage_end_date=usage_end_date,
        required_minutes=required_minutes,
        monthly_limit_minutes=monthly_limit_minutes,
        now=now,
    )
    remaining_minutes_after = (
        None
        if monthly_limit_minutes is None
        else max(0, int(monthly_limit_minutes) - int(usage_snapshot_after["total"]))
    )
    _reset_podcast_transcription_job_for_source_attempt(
        db,
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_reason=request_reason,
        reserved_minutes=required_minutes,
        reservation_usage_date=usage_date,
        now=now,
    )
    _reset_media_transcript_state_for_source_attempt(
        db,
        media_id=media_id,
        request_reason=request_reason,
        now=now,
    )
    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_reason=request_reason,
        dry_run=False,
        outcome="queued",
        required_minutes=required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        now=now,
    )


def _enqueue_podcast_transcript_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_reason: str,
    request_id: str | None = None,
) -> bool:
    if requested_by_user_id is None:
        logger.warning(
            "podcast_transcript_source_attempt_missing_requested_by_user_id",
            media_id=str(media_id),
            request_reason=request_reason,
            request_id=request_id,
        )
        return False

    from nexus.services.media_source_ingest import (
        enqueue_podcast_episode_transcript_source_attempt,
    )

    try:
        return enqueue_podcast_episode_transcript_source_attempt(
            db=db,
            media_id=media_id,
            viewer_id=requested_by_user_id,
            request_reason=request_reason,
            request_id=request_id,
        )
    except SQLAlchemyError as exc:
        logger.warning(
            "podcast_transcript_source_attempt_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=str(requested_by_user_id),
            request_reason=request_reason,
            error=str(exc),
        )
        return False


def _enqueue_podcast_semantic_repair_job(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_reason: str,
    request_id: str | None = None,
) -> bool:
    try:
        enqueue_job(
            db,
            kind="podcast_reindex_semantic_job",
            payload={
                "media_id": str(media_id),
                "requested_by_user_id": (
                    str(requested_by_user_id) if requested_by_user_id is not None else None
                ),
                "request_reason": request_reason,
                "request_id": request_id,
            },
        )
        return True
    except SQLAlchemyError as exc:
        logger.warning(
            "podcast_semantic_repair_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            request_reason=request_reason,
            error=str(exc),
        )
        return False


def mark_podcast_transcription_failure(
    db: Session,
    *,
    media_id: UUID,
    error_code: str,
    error_message: str,
    now: datetime,
    mark_media_failed: bool = True,
) -> None:
    """Fail-close podcast transcription with full job/quota/transcript-state repair.

    Also used by operational recovery paths (for example the stale-ingest
    reconciler) that must not leave orphaned running jobs or reserved quota.
    """
    if error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value:
        transcript_state = "unavailable"
    elif error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value:
        transcript_state = "failed_quota"
    else:
        transcript_state = "failed_provider"

    if mark_media_failed:
        db.execute(
            text(
                """
                UPDATE media
                SET
                    processing_status = 'failed',
                    failure_stage = 'transcribe',
                    last_error_code = :error_code,
                    last_error_message = :error_message,
                    processing_completed_at = NULL,
                    failed_at = :now,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": error_code,
                "error_message": error_message[:1000],
                "now": now,
            },
        )
    db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                status = 'failed',
                error_code = :error_code,
                completed_at = :now,
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "error_code": error_code,
            "now": now,
        },
    )
    _release_reserved_usage_for_media(db, media_id=media_id, now=now)
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=transcript_state,
        transcript_coverage="none",
        semantic_status="none",
        last_error_code=error_code,
        now=now,
    )
    _bump_all_episode_row_collections(db)


def run_podcast_transcription_now(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
    publication_fence: SourcePublicationFence,
) -> TranscriptionRunResult:
    def publish_running_state(db: Session, _attempt: object) -> tuple[str, str | None]:
        media_row = db.execute(
            text(
                """
                SELECT kind, external_playback_url
                FROM media
                WHERE id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        if media_row is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if str(media_row[0]) != "podcast_episode":
            raise AssertionError("podcast transcript source media kind changed")
        ledger = db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET status = 'running',
                    error_code = NULL,
                    attempts = attempts + 1,
                    started_at = now(),
                    completed_at = NULL,
                    updated_at = now()
                WHERE media_id = :media_id
                RETURNING request_reason
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        if ledger is None:
            raise AssertionError("podcast source attempt is missing its quota ledger")
        request_reason = str(ledger[0] or "episode_open")
        set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state="running",
            transcript_coverage="none",
            semantic_status="none",
            last_request_reason=request_reason,
            last_error_code=None,
            now=datetime.now(UTC),
        )
        _bump_all_episode_row_collections(db)
        return request_reason, str(media_row[1] or "").strip() or None

    request_reason, audio_url = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_podcast_transcription_running",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish_running_state,
    )
    transcription_result = get_deepgram_client().transcribe(audio_url)
    transcription_status = transcription_result.status
    transcript_segments = normalize_transcript_segments(transcription_result.segments)
    transcription_error_code = transcription_result.error_code
    transcription_error_message = str(transcription_result.error_message or "").strip()
    diagnostic_error_code = transcription_result.diagnostic_error_code
    now = datetime.now(UTC)

    if transcription_status == "completed" and transcript_segments:

        def publish_transcript(db: Session, _attempt: object) -> None:
            publish_source_transcript(
                db,
                media_id=media_id,
                request_reason=cast(TranscriptRequestReason, request_reason),
                transcript_coverage="full",
                transcript_segments=transcript_segments,
                now=now,
            )
            db.execute(
                text(
                    """
                    UPDATE podcast_transcription_jobs
                    SET status = 'completed',
                        error_code = :error_code,
                        completed_at = :now,
                        updated_at = :now
                    WHERE media_id = :media_id
                    """
                ),
                {
                    "media_id": media_id,
                    "error_code": diagnostic_error_code,
                    "now": now,
                },
            )
            _commit_reserved_usage_for_media(db, media_id=media_id, now=now)
            _bump_all_episode_row_collections(db)

        run_source_publication_phase(
            session_factory=session_factory,
            label="publish_podcast_transcript_artifacts",
            fence=publication_fence,
            media_ids=(media_id,),
            mutate=publish_transcript,
        )
        return TranscriptionRunResult(
            status="completed",
            segment_count=len(transcript_segments),
            provider_fixture=transcription_result.provider_fixture,
        )

    if transcription_status == "completed":
        raise RuntimeError("podcast transcription completed without valid segments")
    if transcription_error_code in {
        ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
        ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
    }:
        raise ApiError(
            ApiErrorCode(transcription_error_code),
            transcription_error_message or "Transcription provider failed",
        )
    if transcription_error_code != ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value:
        raise RuntimeError(
            "podcast transcription provider returned unexpected failure "
            f"code: {transcription_error_code!r}"
        )
    raise ApiError(
        ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE,
        transcription_error_message or "Transcript unavailable",
    )


def _reset_podcast_transcription_job_for_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_reason: str,
    reserved_minutes: int,
    reservation_usage_date: date,
    now: datetime,
) -> None:
    existing_media_id = db.scalar(
        text("SELECT media_id FROM podcast_transcription_jobs WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    params = {
        "media_id": media_id,
        "requested_by_user_id": requested_by_user_id,
        "request_reason": request_reason,
        "reserved_minutes": reserved_minutes,
        "reservation_usage_date": reservation_usage_date,
        "updated_at": now,
    }
    if existing_media_id is None:
        result = db.execute(
            text(
                """
                INSERT INTO podcast_transcription_jobs (
                    media_id,
                    requested_by_user_id,
                    request_reason,
                    reserved_minutes,
                    reservation_usage_date,
                    status,
                    error_code,
                    attempts,
                    started_at,
                    completed_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :media_id,
                    :requested_by_user_id,
                    :request_reason,
                    :reserved_minutes,
                    :reservation_usage_date,
                    'pending',
                    NULL,
                    0,
                    NULL,
                    NULL,
                    :updated_at,
                    :updated_at
                )
                """
            ),
            params,
        )
    else:
        result = db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET
                    requested_by_user_id = :requested_by_user_id,
                    request_reason = :request_reason,
                    reserved_minutes = :reserved_minutes,
                    reservation_usage_date = :reservation_usage_date,
                    status = 'pending',
                    error_code = NULL,
                    started_at = NULL,
                    completed_at = NULL,
                    updated_at = :updated_at
                WHERE media_id = :media_id
                """
            ),
            params,
        )
    _assert_one_mutated_row(result, "podcast_transcription_jobs")


def _reset_media_transcript_state_for_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    request_reason: str,
    now: datetime,
) -> None:
    # Clear the current transcript so readers show nothing until re-transcription
    # installs replacement current rows.
    db.execute(
        text("DELETE FROM podcast_transcript_segments WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="queued",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason=request_reason,
        last_error_code=None,
        now=now,
    )
    _bump_all_episode_row_collections(db)


def _assert_one_mutated_row(result: Any, table_name: str) -> None:
    if getattr(result, "rowcount", None) != 1:
        raise RuntimeError(f"{table_name} mutation affected an unexpected row count")


def _record_podcast_transcript_request_audit(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_reason: str,
    dry_run: bool,
    outcome: str,
    required_minutes: int | None,
    remaining_minutes: int | None,
    fits_budget: bool | None,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO podcast_transcript_request_audits (
                media_id,
                requested_by_user_id,
                request_reason,
                dry_run,
                outcome,
                required_minutes,
                remaining_minutes,
                fits_budget,
                created_at
            )
            VALUES (
                :media_id,
                :requested_by_user_id,
                :request_reason,
                :dry_run,
                :outcome,
                :required_minutes,
                :remaining_minutes,
                :fits_budget,
                :created_at
            )
            """
        ),
        {
            "media_id": media_id,
            "requested_by_user_id": requested_by_user_id,
            "request_reason": request_reason,
            "dry_run": dry_run,
            "outcome": outcome,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": fits_budget,
            "created_at": now,
        },
    )


def _reserve_usage_minutes_or_raise(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    usage_start_date: date,
    usage_end_date: date,
    required_minutes: int,
    monthly_limit_minutes: int | None,
    now: datetime,
) -> dict[str, int]:
    if required_minutes <= 0:
        usage_snapshot = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
        return {
            "used": usage_snapshot["used"],
            "reserved": usage_snapshot["reserved"],
            "total": usage_snapshot["used"] + usage_snapshot["reserved"],
        }

    # One user row serializes quota checks across all usage days without adding
    # zero-minute rows to the daily usage ledger.
    user_lock = db.execute(
        text("SELECT 1 FROM users WHERE id = :user_id FOR UPDATE"),
        {"user_id": user_id},
    ).fetchone()
    assert (
        user_lock is not None
    )  # justify-service-invariant-check: caller already resolved the user.
    _ensure_usage_daily_row(
        db,
        user_id=user_id,
        usage_date=usage_date,
        now=now,
    )

    if monthly_limit_minutes is None:
        admitted_row = db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily
                SET
                    minutes_reserved = minutes_reserved + :required_minutes,
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND usage_date = :usage_date
                RETURNING minutes_used, minutes_reserved
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "required_minutes": required_minutes,
                "updated_at": now,
            },
        ).fetchone()
    else:
        admitted_row = db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily AS usage
                SET
                    minutes_reserved = usage.minutes_reserved + :required_minutes,
                    updated_at = :updated_at
                WHERE usage.user_id = :user_id
                  AND usage.usage_date = :usage_date
                  AND (
                        COALESCE(
                            (
                                SELECT SUM(other.minutes_used + other.minutes_reserved)
                                FROM podcast_transcription_usage_daily other
                                WHERE other.user_id = :user_id
                                  AND other.usage_date >= :usage_start_date
                                  AND other.usage_date < :usage_end_date
                                  AND other.usage_date <> :usage_date
                            ),
                            0
                        )
                        + usage.minutes_used
                        + usage.minutes_reserved
                        + :required_minutes
                      ) <= :monthly_limit_minutes
                RETURNING usage.minutes_used, usage.minutes_reserved
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "usage_start_date": usage_start_date,
                "usage_end_date": usage_end_date,
                "required_minutes": required_minutes,
                "monthly_limit_minutes": monthly_limit_minutes,
                "updated_at": now,
            },
        ).fetchone()
    if admitted_row is None:
        usage_before = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
        logger.warning(
            "podcast_quota_exceeded",
            viewer_id=str(user_id),
            usage_date=usage_date.isoformat(),
            used_minutes=usage_before["used"],
            reserved_minutes=usage_before["reserved"],
            required_minutes=required_minutes,
            monthly_limit_minutes=monthly_limit_minutes,
        )
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Monthly transcription quota exceeded",
        )

    usage_after = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
    used_after = int(usage_after["used"] or 0)
    reserved_after = int(usage_after["reserved"] or 0)
    return {
        "used": used_after,
        "reserved": reserved_after,
        "total": used_after + reserved_after,
    }


def _ensure_usage_daily_row(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    now: datetime,
) -> None:
    existing_row = db.execute(
        text(
            """
            SELECT 1
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id
              AND usage_date = :usage_date
            """
        ),
        {"user_id": user_id, "usage_date": usage_date},
    ).fetchone()
    if existing_row is not None:
        return

    try:
        with db.begin_nested():
            db.execute(
                text(
                    """
                    INSERT INTO podcast_transcription_usage_daily (
                        user_id,
                        usage_date,
                        minutes_used,
                        minutes_reserved,
                        updated_at
                    )
                    VALUES (
                        :user_id,
                        :usage_date,
                        0,
                        0,
                        :updated_at
                    )
                    """
                ),
                {
                    "user_id": user_id,
                    "usage_date": usage_date,
                    "updated_at": now,
                },
            )
    except IntegrityError as exc:
        if not _is_usage_daily_identity_conflict(exc):
            raise


def _is_usage_daily_identity_conflict(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "podcast_transcription_usage_daily_pkey"
    return "podcast_transcription_usage_daily_pkey" in str(orig or exc)


def _claim_job_reservation(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> tuple[UUID | None, date | None, int] | None:
    row = db.execute(
        text(
            """
            WITH claimed AS MATERIALIZED (
                SELECT
                    media_id,
                    requested_by_user_id,
                    reservation_usage_date,
                    reserved_minutes
                FROM podcast_transcription_jobs
                WHERE media_id = :media_id
                  AND reserved_minutes > 0
                  AND reservation_usage_date IS NOT NULL
            ),
            cleared AS (
                UPDATE podcast_transcription_jobs job
                SET
                    reserved_minutes = 0,
                    reservation_usage_date = NULL,
                    updated_at = :now
                FROM claimed
                WHERE job.media_id = claimed.media_id
                  AND job.reserved_minutes = claimed.reserved_minutes
                  AND job.reservation_usage_date = claimed.reservation_usage_date
                  AND job.reserved_minutes > 0
                  AND job.reservation_usage_date IS NOT NULL
                RETURNING
                    claimed.requested_by_user_id,
                    claimed.reservation_usage_date,
                    claimed.reserved_minutes
            )
            SELECT requested_by_user_id, reservation_usage_date, reserved_minutes
            FROM cleared
            """
        ),
        {"media_id": media_id, "now": now},
    ).fetchone()
    if row is None:
        return None
    return row[0], row[1], int(row[2] or 0)


def _release_reserved_usage_for_media(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    reservation = _claim_job_reservation(db, media_id=media_id, now=now)
    if reservation is None:
        return

    user_id, usage_date, reserved_minutes = reservation
    if user_id is not None and usage_date is not None and reserved_minutes > 0:
        db.execute(
            text(
                """
                UPDATE podcast_transcription_usage_daily
                SET
                    minutes_reserved = GREATEST(minutes_reserved - :reserved_minutes, 0),
                    updated_at = :updated_at
                WHERE user_id = :user_id
                  AND usage_date = :usage_date
                """
            ),
            {
                "user_id": user_id,
                "usage_date": usage_date,
                "reserved_minutes": reserved_minutes,
                "updated_at": now,
            },
        )


def _commit_reserved_usage_for_media(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    reservation = _claim_job_reservation(db, media_id=media_id, now=now)
    if reservation is None:
        return

    user_id, usage_date, reserved_minutes = reservation
    if user_id is None or usage_date is None or reserved_minutes <= 0:
        return

    _ensure_usage_daily_row(
        db,
        user_id=user_id,
        usage_date=usage_date,
        now=now,
    )
    result = db.execute(
        text(
            """
            UPDATE podcast_transcription_usage_daily
            SET
                minutes_used = minutes_used + :minutes_used,
                minutes_reserved = GREATEST(minutes_reserved - :minutes_used, 0),
                updated_at = :updated_at
            WHERE user_id = :user_id
              AND usage_date = :usage_date
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "minutes_used": reserved_minutes,
            "updated_at": now,
        },
    )
    assert (
        getattr(result, "rowcount", 0) == 1
    )  # justify-service-invariant-check: ensured usage row exists.
