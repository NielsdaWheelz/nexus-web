"""Podcast transcript admission, execution, and repair services."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from nexus.coerce import coerce_non_negative_int, coerce_positive_int
from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.session import create_session_factory
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import (
    TranscriptRequestBatchItemResponse,
    TranscriptRequestBatchResponse,
    TranscriptRequestResponse,
)
from nexus.schemas.media import (
    TranscriptRequestReason as TranscriptResponseReason,
)
from nexus.services.billing import get_transcription_usage
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.content_indexing import (
    IndexOwner,
    mark_content_index_failed,
    rebuild_transcript_content_index,
)
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.services.transcript_segments import (
    TranscriptSegmentInput,
    normalize_transcript_segments,
)
from nexus.services.transcripts.current import (
    TranscriptRequestReason,
    ensure_media_transcript_state_row,
    set_media_transcript_state,
    write_current_transcript,
)

from .deepgram_adapter import (
    get_deepgram_client,
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


@dataclass(frozen=True)
class TranscriptionRunResult:
    """Worker result for a single podcast transcription run."""

    status: Literal["skipped", "failed", "completed"]
    reason: str | None = None
    job_status: str | None = None
    error_code: str | None = None
    segment_count: int | None = None
    provider_fixture: dict[str, Any] | None = None


@dataclass(frozen=True)
class SemanticRepairResult:
    """Worker result for a podcast transcript semantic-index repair run."""

    status: Literal["skipped", "failed", "completed"]
    reason: str | None = None
    error_code: str | None = None
    chunk_count: int | None = None


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
            processing_status=effective_status,
            transcript_state=transcript_state or "not_requested",
            transcript_coverage=transcript_coverage or "none",
            request_reason=cast(TranscriptResponseReason, normalized_reason),
            required_minutes=required_minutes,
            remaining_minutes=remaining_minutes,
            fits_budget=fits_budget,
            request_enqueued=False,
        )

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
        db.commit()
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=effective_status,
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


def request_podcast_transcripts_batch_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media_ids: list[UUID],
    reason: str,
) -> TranscriptRequestBatchResponse:
    normalized_media_ids: list[UUID] = []
    seen_media_ids: set[UUID] = set()
    for media_id in media_ids:
        normalized_media_id = UUID(str(media_id))
        if normalized_media_id in seen_media_ids:
            continue
        seen_media_ids.add(normalized_media_id)
        normalized_media_ids.append(normalized_media_id)

    results: list[TranscriptRequestBatchItemResponse] = []
    quota_exhausted = False
    quota_remaining_after_exhaustion: int | None = 0

    for media_id in normalized_media_ids:
        media_id_str = str(media_id)
        if quota_exhausted:
            results.append(
                TranscriptRequestBatchItemResponse(
                    media_id=media_id_str,
                    status="rejected_quota",
                    required_minutes=None,
                    remaining_minutes=quota_remaining_after_exhaustion,
                    error="Monthly transcription quota exceeded",
                )
            )
            continue

        try:
            admission = request_podcast_transcript_for_viewer(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                reason=reason,
                dry_run=False,
            )
        except ApiError as exc:
            if exc.code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED:
                quota_exhausted = True
                quota_remaining_after_exhaustion = 0
                results.append(
                    TranscriptRequestBatchItemResponse(
                        media_id=media_id_str,
                        status="rejected_quota",
                        required_minutes=None,
                        remaining_minutes=0,
                        error=exc.message,
                    )
                )
                continue
            if exc.code in {
                ApiErrorCode.E_MEDIA_NOT_FOUND,
                ApiErrorCode.E_INVALID_KIND,
                ApiErrorCode.E_FORBIDDEN,
            }:
                results.append(
                    TranscriptRequestBatchItemResponse(
                        media_id=media_id_str,
                        status="rejected_invalid",
                        required_minutes=None,
                        remaining_minutes=None,
                        error=exc.message,
                    )
                )
                continue
            raise

        status = _batch_transcript_status_from_admission(admission)
        required_minutes = coerce_non_negative_int(admission.required_minutes)
        remaining_minutes = (
            coerce_non_negative_int(admission.remaining_minutes)
            if admission.remaining_minutes is not None
            else None
        )
        error_message = None
        if status == "rejected_invalid":
            error_message = "Transcript request admission failed"

        results.append(
            TranscriptRequestBatchItemResponse(
                media_id=media_id_str,
                status=status,
                required_minutes=required_minutes,
                remaining_minutes=remaining_minutes,
                error=error_message,
            )
        )

        if status == "queued" and remaining_minutes == 0:
            quota_exhausted = True
            quota_remaining_after_exhaustion = 0

    return TranscriptRequestBatchResponse(results=results)


def _batch_transcript_status_from_admission(
    admission: TranscriptRequestResponse,
) -> Literal["queued", "already_ready", "already_queued", "rejected_invalid"]:
    if admission.request_enqueued:
        return "queued"
    transcript_state = admission.transcript_state.strip().lower()
    if transcript_state in {"ready", "partial"}:
        return "already_ready"
    if transcript_state in {"queued", "running"}:
        return "already_queued"
    return "rejected_invalid"


def forecast_podcast_transcripts_for_viewer(
    db: Session,
    viewer_id: UUID,
    requests: list[tuple[UUID, str]],
) -> list[TranscriptRequestResponse]:
    """Return dry-run transcript forecasts for many podcast episodes in one commit."""

    if not requests:
        return []

    results: list[TranscriptRequestResponse] = []
    try:
        for media_id, reason in requests:
            results.append(
                request_podcast_transcript_for_viewer(
                    db,
                    viewer_id,
                    media_id,
                    reason=reason,
                    dry_run=True,
                    _auto_commit=False,
                )
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return results


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


def _transcription_heartbeat_interval_seconds(*, stale_extracting_seconds: int) -> float:
    # Keep lease heartbeats comfortably below stale reclaim cutoff.
    return max(1.0, min(30.0, float(stale_extracting_seconds) / 2.0))


def _run_transcription_job_heartbeat(
    session_factory: sessionmaker[Session],
    *,
    stop_event: threading.Event,
    media_id: UUID,
    interval_seconds: float,
) -> None:
    while not stop_event.wait(interval_seconds):
        try:
            with session_factory() as heartbeat_db:
                heartbeat_db.execute(
                    text(
                        """
                        UPDATE podcast_transcription_jobs
                        SET updated_at = now()
                        WHERE media_id = :media_id
                          AND status = 'running'
                        """
                    ),
                    {"media_id": media_id},
                )
                heartbeat_db.execute(
                    text(
                        """
                        UPDATE media
                        SET updated_at = now()
                        WHERE id = :media_id
                          AND processing_status = 'extracting'
                        """
                    ),
                    {"media_id": media_id},
                )
                heartbeat_db.commit()
        except SQLAlchemyError:
            logger.warning(
                "podcast_transcription_heartbeat_failed",
                media_id=str(media_id),
            )


def _start_transcription_job_heartbeat(
    db: Session,
    *,
    media_id: UUID,
    stale_extracting_seconds: int,
) -> tuple[threading.Event, threading.Thread]:
    bind = db.get_bind()
    engine = getattr(bind, "engine", bind)
    session_factory = create_session_factory(engine)
    stop_event = threading.Event()
    interval_seconds = _transcription_heartbeat_interval_seconds(
        stale_extracting_seconds=stale_extracting_seconds
    )
    heartbeat_thread = threading.Thread(
        target=_run_transcription_job_heartbeat,
        kwargs={
            "session_factory": session_factory,
            "stop_event": stop_event,
            "media_id": media_id,
            "interval_seconds": interval_seconds,
        },
        daemon=True,
        name=f"podcast-transcription-heartbeat-{media_id}",
    )
    heartbeat_thread.start()
    return stop_event, heartbeat_thread


def _stop_transcription_job_heartbeat(
    heartbeat: tuple[threading.Event, threading.Thread] | None,
) -> None:
    if heartbeat is None:
        return
    stop_event, heartbeat_thread = heartbeat
    stop_event.set()
    heartbeat_thread.join(timeout=2.0)


def run_podcast_transcription_now(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
    mark_media_ready: bool = True,
    mark_media_failed: bool = True,
    dispatch_metadata_enrichment: bool = True,
) -> TranscriptionRunResult:
    stale_extracting_seconds = get_settings().ingest_stale_extracting_seconds
    claimed = db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                status = 'running',
                error_code = NULL,
                attempts = attempts + 1,
                started_at = now(),
                completed_at = NULL,
                updated_at = now()
            WHERE media_id = :media_id
              AND (
                    status IN ('pending', 'failed')
                    OR (
                        status = 'running'
                        AND COALESCE(updated_at, started_at) < (
                            now() - (
                                CAST(:stale_extracting_seconds AS integer)
                                * interval '1 second'
                            )
                        )
                    )
              )
            RETURNING request_reason, updated_at
            """
        ),
        {
            "media_id": media_id,
            "stale_extracting_seconds": stale_extracting_seconds,
        },
    ).fetchone()

    if claimed is None:
        snapshot = db.execute(
            text(
                """
                SELECT status, error_code
                FROM podcast_transcription_jobs
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        if snapshot is None:
            return TranscriptionRunResult(status="skipped", reason="job_not_found")
        return TranscriptionRunResult(
            status="skipped",
            reason="not_pending",
            job_status=str(snapshot[0]),
            error_code=snapshot[1],
        )

    request_reason = str(claimed[0] or "episode_open")
    claim_now = claimed[1]
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="running",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason=request_reason,
        last_error_code=None,
        now=claim_now,
    )
    db.commit()

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
        db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET status = 'failed', error_code = :error_code, completed_at = :now, updated_at = :now
                WHERE media_id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": ApiErrorCode.E_MEDIA_NOT_FOUND.value,
                "now": claim_now,
            },
        )
        db.commit()
        return TranscriptionRunResult(
            status="failed", error_code=ApiErrorCode.E_MEDIA_NOT_FOUND.value
        )

    if str(media_row[0]) != "podcast_episode":
        mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_INVALID_KIND.value,
            error_message="Invalid media kind for podcast transcription",
            now=claim_now,
            mark_media_failed=mark_media_failed,
        )
        db.commit()
        return TranscriptionRunResult(status="failed", error_code=ApiErrorCode.E_INVALID_KIND.value)

    if mark_media_ready or mark_media_failed:
        db.execute(
            text(
                """
                UPDATE media
                SET
                    processing_status = 'extracting',
                    failure_stage = NULL,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    processing_started_at = :now,
                    processing_completed_at = NULL,
                    failed_at = NULL,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "now": claim_now,
            },
        )
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="running",
        transcript_coverage="none",
        semantic_status="none",
        last_request_reason=request_reason,
        last_error_code=None,
        now=claim_now,
    )
    db.commit()

    audio_url = str(media_row[1] or "").strip() or None
    heartbeat: tuple[threading.Event, threading.Thread] | None = None
    try:
        heartbeat = _start_transcription_job_heartbeat(
            db,
            media_id=media_id,
            stale_extracting_seconds=stale_extracting_seconds,
        )
    except (RuntimeError, SQLAlchemyError):
        logger.warning(
            "podcast_transcription_heartbeat_start_failed",
            media_id=str(media_id),
        )
    try:
        transcription_result = get_deepgram_client().transcribe(audio_url)
    except (
        Exception
    ) as exc:  # justify-ignore-error: provider boundary; recover into failed-status terminal record
        now = datetime.now(UTC)
        logger.exception(
            "podcast_transcription_unhandled_error",
            media_id=str(media_id),
            error=str(exc),
        )
        mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            error_message="Transcription failed",
            now=now,
            mark_media_failed=mark_media_failed,
        )
        db.commit()
        return TranscriptionRunResult(
            status="failed", error_code=ApiErrorCode.E_TRANSCRIPTION_FAILED.value
        )
    finally:
        _stop_transcription_job_heartbeat(heartbeat)
    transcription_status = transcription_result.status
    transcript_segments = normalize_transcript_segments(transcription_result.segments)
    transcription_error_code = transcription_result.error_code
    transcription_error_message = str(transcription_result.error_message or "").strip()
    diagnostic_error_code = transcription_result.diagnostic_error_code
    now = datetime.now(UTC)

    if transcription_status == "completed" and not transcript_segments:
        transcription_status = "failed"
        transcription_error_code = ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
        transcription_error_message = "Transcript unavailable"
        diagnostic_error_code = None

    if transcription_status == "completed" and transcript_segments:
        write_current_transcript(
            db,
            media_id=media_id,
            request_reason=cast(TranscriptRequestReason, request_reason),
            transcript_coverage="full",
            transcript_segments=transcript_segments,
            mark_media_ready=mark_media_ready,
            now=now,
        )
        db.execute(
            text(
                """
                UPDATE podcast_transcription_jobs
                SET
                    status = 'completed',
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
        db.commit()
        if dispatch_metadata_enrichment:
            if try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id):
                db.commit()
        return TranscriptionRunResult(
            status="completed",
            segment_count=len(transcript_segments),
            provider_fixture=transcription_result.provider_fixture,
        )

    terminal_error_code = transcription_error_code or ApiErrorCode.E_TRANSCRIPTION_FAILED.value
    terminal_error_message = transcription_error_message or "Transcription failed"
    mark_podcast_transcription_failure(
        db,
        media_id=media_id,
        error_code=terminal_error_code,
        error_message=terminal_error_message,
        now=now,
        mark_media_failed=mark_media_failed,
    )
    db.commit()
    if dispatch_metadata_enrichment:
        if try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id):
            db.commit()
    return TranscriptionRunResult(status="failed", error_code=terminal_error_code)


def repair_podcast_transcript_semantic_index_now(
    db: Session,
    *,
    media_id: UUID,
    request_reason: str = "operator_requeue",
    request_id: str | None = None,
) -> SemanticRepairResult:
    now = datetime.now(UTC)
    normalized_reason = (
        request_reason
        if request_reason in PODCAST_TRANSCRIPT_REQUEST_REASONS
        else "operator_requeue"
    )

    lock_acquired = db.execute(
        text("SELECT pg_try_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"podcast-semantic-repair:{media_id}"},
    ).scalar()
    if not bool(lock_acquired):
        return SemanticRepairResult(status="skipped", reason="locked")

    embedding_model = current_transcript_embedding_model()
    embedding_provider = current_transcript_embedding_provider()

    claim_row = db.execute(
        text(
            """
            UPDATE media_transcript_states AS mts
            SET
                semantic_status = 'pending',
                last_request_reason = :request_reason,
                last_error_code = NULL,
                updated_at = :now
            WHERE mts.media_id = :media_id
              AND mts.transcript_state IN ('ready', 'partial')
              AND mts.transcript_coverage IN ('partial', 'full')
              AND EXISTS (
                  SELECT 1
                  FROM podcast_transcript_segments pts
                  WHERE pts.media_id = mts.media_id
              )
              AND (
                  mts.semantic_status IN ('pending', 'failed')
                  OR (
                      mts.semantic_status = 'ready'
                      AND (
                          NOT EXISTS (
                              SELECT 1
                              FROM content_index_states mcis
                              WHERE mcis.owner_kind = 'media' AND mcis.owner_id = mts.media_id
                                AND mcis.status = 'ready'
                                AND mcis.active_embedding_provider = :embedding_provider
                                AND mcis.active_embedding_model = :embedding_model
                          )
                      )
                  )
              )
            RETURNING mts.transcript_state, mts.transcript_coverage
            """
        ),
        {
            "media_id": media_id,
            "request_reason": normalized_reason,
            "embedding_provider": embedding_provider,
            "embedding_model": embedding_model,
            "now": now,
        },
    ).fetchone()
    if claim_row is None:
        return SemanticRepairResult(status="skipped", reason="not_repairable")

    transcript_state = str(claim_row[0] or "ready")
    transcript_coverage = str(claim_row[1] or "full")
    segment_rows = db.execute(
        text(
            """
            SELECT canonical_text, t_start_ms, t_end_ms, speaker_label
            FROM podcast_transcript_segments
            WHERE media_id = :media_id
            ORDER BY segment_idx ASC
            """
        ),
        {"media_id": media_id},
    ).fetchall()

    # Rows arrive ordered by segment_idx ASC; enumerate over the kept rows restores
    # the contiguous 0..N-1 index the dataclass contract carries.
    transcript_segments: list[TranscriptSegmentInput] = []
    for row in segment_rows:
        canonical_text = str(row[0] or "").strip()
        t_start_ms = row[1]
        t_end_ms = row[2]
        if not canonical_text or t_start_ms is None or t_end_ms is None:
            continue
        transcript_segments.append(
            TranscriptSegmentInput(
                segment_idx=len(transcript_segments),
                t_start_ms=int(t_start_ms),
                t_end_ms=int(t_end_ms),
                canonical_text=canonical_text,
                speaker_label=row[3],
            )
        )

    if not transcript_segments:
        set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="failed",
            last_request_reason=normalized_reason,
            last_error_code=ApiErrorCode.E_INTERNAL.value,
            now=now,
        )
        return SemanticRepairResult(
            status="failed",
            error_code=ApiErrorCode.E_INTERNAL.value,
            reason="segments_missing",
        )

    try:
        rebuild_transcript_content_index(
            db,
            media_id=media_id,
            transcript_segments=transcript_segments,
            reason=normalized_reason,
        )
        set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="ready",
            last_request_reason=normalized_reason,
            last_error_code=None,
            now=now,
        )
        return SemanticRepairResult(
            status="completed",
            chunk_count=len(transcript_segments),
        )
    except Exception as exc:  # justify-ignore-error: semantic repair boundary; mark content index failure and surface in state
        logger.exception(
            "podcast_semantic_repair_failed",
            media_id=str(media_id),
            request_id=request_id,
            error=str(exc),
        )
        error_code = exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INTERNAL.value
        mark_content_index_failed(
            db,
            owner=IndexOwner("media", media_id),
            failure_code=error_code,
            failure_message=str(exc),
        )
        set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="failed",
            last_request_reason=normalized_reason,
            last_error_code=error_code,
            now=now,
        )
        return SemanticRepairResult(status="failed", error_code=error_code)


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
