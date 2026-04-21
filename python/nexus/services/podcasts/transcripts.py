"""Podcast transcript admission, execution, and repair services."""

from __future__ import annotations

import json
import math
import threading
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Environment, get_settings
from nexus.db.session import create_session_factory
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
from nexus.services.billing import get_entitlements, get_transcription_usage
from nexus.services.semantic_chunks import (
    chunk_transcript_segments,
    current_transcript_embedding_model,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)
from nexus.services.transcript_segments import (
    canonicalize_transcript_segment_text as _shared_canonicalize_transcript_segment_text,
)
from nexus.services.transcript_segments import (
    insert_transcript_fragments as _shared_insert_transcript_fragments,
)
from nexus.services.transcript_segments import (
    normalize_transcript_segments as _shared_normalize_transcript_segments,
)
from nexus.services.url_normalize import validate_requested_url

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
_DEEPGRAM_LISTEN_PATH = "/v1/listen"


def _semantic_index_requires_repair(
    db: Session,
    *,
    transcript_version_id: UUID,
) -> bool:
    """Whether active transcript chunks are absent/stale for the current embedding model."""
    active_embedding_model = current_transcript_embedding_model()
    row = db.execute(
        text(
            """
            SELECT
                EXISTS (
                    SELECT 1
                    FROM podcast_transcript_chunks tc
                    WHERE tc.transcript_version_id = :transcript_version_id
                ) AS has_chunks,
                EXISTS (
                    SELECT 1
                    FROM podcast_transcript_chunks tc
                    WHERE tc.transcript_version_id = :transcript_version_id
                      AND (
                          tc.embedding_vector IS NULL
                          OR tc.embedding_model IS NULL
                          OR tc.embedding_model <> :active_embedding_model
                      )
                ) AS has_stale_chunks
            """
        ),
        {
            "transcript_version_id": transcript_version_id,
            "active_embedding_model": active_embedding_model,
        },
    ).fetchone()
    if row is None:
        return True
    has_chunks = bool(row[0])
    has_stale_chunks = bool(row[1])
    return (not has_chunks) or has_stale_chunks


def request_podcast_transcript_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    reason: str,
    dry_run: bool = False,
    request_id: str | None = None,
    _auto_commit: bool = True,
) -> dict[str, Any]:
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
                ) AS semantic_status,
                (
                    SELECT mts.active_transcript_version_id
                    FROM media_transcript_states mts
                    WHERE mts.media_id = m.id
                ) AS active_transcript_version_id
            FROM media m
            WHERE m.id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_kind = str(media_row[0] or "")
    processing_status = str(media_row[1] or "")
    last_error_code = str(media_row[2] or "").strip() or None
    duration_seconds = _coerce_positive_int(media_row[3])
    job_status = str(media_row[4] or "").strip() or None
    transcript_state = str(media_row[5] or "").strip() or None
    transcript_coverage = str(media_row[6] or "").strip() or None
    semantic_status = str(media_row[7] or "").strip() or "none"
    active_transcript_version_id = media_row[8]

    if media_kind != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript request is only supported for podcast episodes.",
        )

    if transcript_state is None:
        _ensure_media_transcript_state_row(
            db,
            media_id=media_id,
            processing_status=processing_status,
            last_error_code=last_error_code,
            now=now,
            request_reason=normalized_reason,
        )
        if processing_status in {"ready_for_reading", "embedding", "ready"}:
            transcript_state = "ready"
            transcript_coverage = "full"
        elif processing_status == "extracting":
            transcript_state = "running"
            transcript_coverage = "none"
        else:
            transcript_state = "not_requested"
            transcript_coverage = "none"

    required_minutes = _episode_minutes({"duration_seconds": duration_seconds})
    entitlements = get_entitlements(db, viewer_id)
    monthly_limit_minutes = entitlements.transcription_minutes_limit_monthly
    if entitlements.current_period_start and entitlements.current_period_end:
        usage_start_date = entitlements.current_period_start.date()
        usage_end_date = entitlements.current_period_end.date()
    else:
        usage_start_date = date(usage_date.year, usage_date.month, 1)
        usage_end_date = (
            date(usage_date.year + 1, 1, 1)
            if usage_date.month == 12
            else date(usage_date.year, usage_date.month + 1, 1)
        )
    usage_snapshot = get_transcription_usage(
        db,
        viewer_id,
        usage_start_date,
        usage_end_date,
    )
    consumed_minutes = int(usage_snapshot["used"]) + int(usage_snapshot["reserved"])
    remaining_minutes = max(0, int(monthly_limit_minutes) - consumed_minutes)
    fits_budget = required_minutes <= remaining_minutes

    already_ready = transcript_state in {"ready", "partial"} and transcript_coverage in {
        "partial",
        "full",
    }
    semantic_needs_repair = already_ready and semantic_status in {"pending", "failed"}
    if (
        already_ready
        and not semantic_needs_repair
        and active_transcript_version_id is not None
        and _semantic_index_requires_repair(
            db,
            transcript_version_id=active_transcript_version_id,
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
        return {
            "media_id": str(media_id),
            "processing_status": effective_status,
            "transcript_state": transcript_state or "not_requested",
            "transcript_coverage": transcript_coverage or "none",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": fits_budget,
            "request_enqueued": False,
        }

    if semantic_needs_repair:
        semantic_repair_enqueued = _enqueue_podcast_semantic_repair_job(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=normalized_reason,
            request_id=request_id,
        )
        if semantic_repair_enqueued:
            _set_media_transcript_state(
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
        return {
            "media_id": str(media_id),
            "processing_status": "ready_for_reading",
            "transcript_state": transcript_state or "ready",
            "transcript_coverage": transcript_coverage or "full",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": semantic_repair_enqueued,
        }

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
        return {
            "media_id": str(media_id),
            "processing_status": effective_status,
            "transcript_state": transcript_state or ("ready" if already_ready else "queued"),
            "transcript_coverage": transcript_coverage or ("full" if already_ready else "none"),
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": False,
        }

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
    remaining_minutes_after = max(
        0,
        int(monthly_limit_minutes) - int(usage_snapshot_after["total"]),
    )

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
            ON CONFLICT (media_id)
            DO UPDATE SET
                requested_by_user_id = EXCLUDED.requested_by_user_id,
                request_reason = EXCLUDED.request_reason,
                reserved_minutes = EXCLUDED.reserved_minutes,
                reservation_usage_date = EXCLUDED.reservation_usage_date,
                status = 'pending',
                error_code = NULL,
                started_at = NULL,
                completed_at = NULL,
                updated_at = EXCLUDED.updated_at
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
            "now": now,
        },
    )

    _set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="queued",
        transcript_coverage="none",
        semantic_status="none",
        active_transcript_version_id=None,
        last_request_reason=normalized_reason,
        last_error_code=None,
        now=now,
    )

    enqueued = _enqueue_podcast_transcription_job(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_id=request_id,
    )
    if not enqueued:
        _mark_podcast_transcription_failure(
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
        return {
            "media_id": str(media_id),
            "processing_status": "failed",
            "transcript_state": "failed_provider",
            "transcript_coverage": "none",
            "request_reason": normalized_reason,
            "required_minutes": required_minutes,
            "remaining_minutes": remaining_minutes,
            "fits_budget": True,
            "request_enqueued": False,
        }

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
    return {
        "media_id": str(media_id),
        "processing_status": "extracting",
        "transcript_state": "queued",
        "transcript_coverage": "none",
        "request_reason": normalized_reason,
        "required_minutes": required_minutes,
        "remaining_minutes": remaining_minutes_after,
        "fits_budget": True,
        "request_enqueued": True,
    }


def request_podcast_transcripts_batch_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media_ids: list[UUID],
    reason: str,
) -> dict[str, Any]:
    normalized_media_ids: list[UUID] = []
    seen_media_ids: set[UUID] = set()
    for media_id in media_ids:
        normalized_media_id = UUID(str(media_id))
        if normalized_media_id in seen_media_ids:
            continue
        seen_media_ids.add(normalized_media_id)
        normalized_media_ids.append(normalized_media_id)

    results: list[dict[str, Any]] = []
    quota_exhausted = False
    quota_remaining_after_exhaustion: int | None = 0

    for media_id in normalized_media_ids:
        media_id_str = str(media_id)
        if quota_exhausted:
            results.append(
                {
                    "media_id": media_id_str,
                    "status": "rejected_quota",
                    "required_minutes": None,
                    "remaining_minutes": quota_remaining_after_exhaustion,
                    "error": "Monthly transcription quota exceeded",
                }
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
                    {
                        "media_id": media_id_str,
                        "status": "rejected_quota",
                        "required_minutes": None,
                        "remaining_minutes": 0,
                        "error": exc.message,
                    }
                )
                continue
            if exc.code in {
                ApiErrorCode.E_MEDIA_NOT_FOUND,
                ApiErrorCode.E_INVALID_KIND,
                ApiErrorCode.E_FORBIDDEN,
            }:
                results.append(
                    {
                        "media_id": media_id_str,
                        "status": "rejected_invalid",
                        "required_minutes": None,
                        "remaining_minutes": None,
                        "error": exc.message,
                    }
                )
                continue
            raise
        except (InvalidRequestError, NotFoundError, ForbiddenError) as exc:
            results.append(
                {
                    "media_id": media_id_str,
                    "status": "rejected_invalid",
                    "required_minutes": None,
                    "remaining_minutes": None,
                    "error": exc.message,
                }
            )
            continue

        status = _batch_transcript_status_from_admission(admission)
        required_minutes = _coerce_non_negative_int(admission.get("required_minutes"))
        remaining_minutes = (
            _coerce_non_negative_int(admission.get("remaining_minutes"))
            if admission.get("remaining_minutes") is not None
            else None
        )
        error_message = None
        if status == "rejected_invalid":
            error_message = "Transcript request admission failed"

        results.append(
            {
                "media_id": media_id_str,
                "status": status,
                "required_minutes": required_minutes,
                "remaining_minutes": remaining_minutes,
                "error": error_message,
            }
        )

        if status == "queued" and remaining_minutes == 0:
            quota_exhausted = True
            quota_remaining_after_exhaustion = 0

    return {"results": results}


def _batch_transcript_status_from_admission(admission: dict[str, Any]) -> str:
    if bool(admission.get("request_enqueued")):
        return "queued"
    transcript_state = str(admission.get("transcript_state") or "").strip().lower()
    if transcript_state in {"ready", "partial"}:
        return "already_ready"
    if transcript_state in {"queued", "running"}:
        return "already_queued"
    return "rejected_invalid"


def forecast_podcast_transcripts_for_viewer(
    db: Session,
    viewer_id: UUID,
    requests: list[tuple[UUID, str]],
) -> list[dict[str, Any]]:
    """Return dry-run transcript forecasts for many podcast episodes in one commit."""

    if not requests:
        return []

    results: list[dict[str, Any]] = []
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


def retry_transcript_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict[str, Any]:
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media_row = db.execute(
        text(
            """
            SELECT kind, created_by_user_id, processing_status, failure_stage
            FROM media
            WHERE id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if media_row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    kind = str(media_row[0] or "")
    created_by_user_id = media_row[1]
    processing_status = str(media_row[2] or "")
    failure_stage = str(media_row[3] or "").strip() or None

    if kind not in {"podcast_episode", "video"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Retry is only supported for PDF/EPUB/podcast/video media.",
        )
    if created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can retry transcription.",
        )

    if processing_status == "extracting":
        return {
            "media_id": str(media_id),
            "processing_status": "extracting",
            "retry_enqueued": False,
        }

    if processing_status != "failed":
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be in failed state to retry.",
        )
    if failure_stage not in {None, "transcribe"}:
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Retry not allowed for this failure stage.",
        )

    if kind == "podcast_episode":
        admission = request_podcast_transcript_for_viewer(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            reason="operator_requeue",
            dry_run=False,
        )
        return {
            "media_id": admission["media_id"],
            "processing_status": admission["processing_status"],
            "retry_enqueued": bool(admission["request_enqueued"]),
        }

    now = datetime.now(UTC)
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
            "now": now,
        },
    )

    enqueued = _enqueue_video_transcription_retry(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_id=request_id,
    )
    if not enqueued:
        db.execute(
            text(
                """
                UPDATE media
                SET
                    processing_status = 'failed',
                    failure_stage = 'transcribe',
                    last_error_code = :error_code,
                    last_error_message = :error_message,
                    failed_at = :now,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "error_code": ApiErrorCode.E_INTERNAL.value,
                "error_message": "Failed to enqueue video transcription job",
                "now": now,
            },
        )
        db.commit()
        return {
            "media_id": str(media_id),
            "processing_status": "failed",
            "retry_enqueued": False,
        }

    db.commit()
    return {
        "media_id": str(media_id),
        "processing_status": "extracting",
        "retry_enqueued": True,
    }


def _enqueue_podcast_transcription_job(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
) -> bool:
    try:
        enqueue_job(
            db,
            kind="podcast_transcribe_episode_job",
            payload={
                "media_id": str(media_id),
                "requested_by_user_id": (
                    str(requested_by_user_id) if requested_by_user_id is not None else None
                ),
                "request_id": request_id,
            },
        )
        return True
    except Exception as exc:
        logger.warning(
            "podcast_transcription_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            error=str(exc),
        )
        settings = get_settings()
        if settings.nexus_env == Environment.TEST:
            logger.info(
                "podcast_transcription_enqueue_deferred_in_test",
                media_id=str(media_id),
                requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            )
            return True
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
    except Exception as exc:
        logger.warning(
            "podcast_semantic_repair_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
            request_reason=request_reason,
            error=str(exc),
        )
        settings = get_settings()
        if settings.nexus_env == Environment.TEST:
            logger.info(
                "podcast_semantic_repair_enqueue_deferred_in_test",
                media_id=str(media_id),
                requested_by_user_id=(str(requested_by_user_id) if requested_by_user_id else None),
                request_reason=request_reason,
            )
            return True
        return False


def _try_enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID,
    request_id: str | None = None,
) -> bool:
    try:
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload={"media_id": str(media_id), "request_id": request_id},
            max_attempts=1,
        )
        return True
    except Exception as exc:
        logger.warning(
            "metadata_enrichment_enqueue_failed",
            media_id=str(media_id),
            request_id=request_id,
            error=str(exc),
        )
        return False


def _enqueue_video_transcription_retry(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_id: str | None,
) -> bool:
    try:
        enqueue_job(
            db,
            kind="ingest_youtube_video",
            payload={
                "media_id": str(media_id),
                "actor_user_id": str(requested_by_user_id),
                "request_id": request_id,
            },
        )
        return True
    except Exception as exc:
        logger.warning(
            "video_transcription_retry_enqueue_failed",
            media_id=str(media_id),
            requested_by_user_id=str(requested_by_user_id),
            request_id=request_id,
            error=str(exc),
        )
        settings = get_settings()
        if settings.nexus_env == Environment.TEST:
            logger.info(
                "video_transcription_retry_enqueue_deferred_in_test",
                media_id=str(media_id),
                requested_by_user_id=str(requested_by_user_id),
                request_id=request_id,
            )
            return True
        return False


def _mark_podcast_transcription_failure(
    db: Session,
    *,
    media_id: UUID,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    if error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value:
        transcript_state = "unavailable"
    elif error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value:
        transcript_state = "failed_quota"
    else:
        transcript_state = "failed_provider"

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
    _set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=transcript_state,
        transcript_coverage="none",
        semantic_status="none",
        active_transcript_version_id=None,
        last_error_code=error_code,
        now=now,
    )


def mark_podcast_transcription_failure_for_recovery(
    db: Session,
    *,
    media_id: UUID,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    """Fail-close podcast transcription with full job/quota/transcript-state repair.

    Used by operational recovery paths (for example stale-ingest reconciler) that
    must not leave orphaned running jobs or reserved quota.
    """
    _mark_podcast_transcription_failure(
        db,
        media_id=media_id,
        error_code=error_code,
        error_message=error_message,
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
        heartbeat_now = datetime.now(UTC)
        try:
            with session_factory() as heartbeat_db:
                heartbeat_db.execute(
                    text(
                        """
                        UPDATE podcast_transcription_jobs
                        SET updated_at = :now
                        WHERE media_id = :media_id
                          AND status = 'running'
                        """
                    ),
                    {"media_id": media_id, "now": heartbeat_now},
                )
                heartbeat_db.execute(
                    text(
                        """
                        UPDATE media
                        SET updated_at = :now
                        WHERE id = :media_id
                          AND processing_status = 'extracting'
                        """
                    ),
                    {"media_id": media_id, "now": heartbeat_now},
                )
                heartbeat_db.commit()
        except Exception:
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
) -> dict[str, Any]:
    _ = request_id
    claim_now = datetime.now(UTC)
    stale_extracting_seconds = get_settings().ingest_stale_extracting_seconds
    # Allow recovery workers to reclaim stale running jobs. We intentionally
    # reuse the ingest stale threshold so media/job stale detection is aligned.
    running_lease_cutoff = claim_now - timedelta(seconds=stale_extracting_seconds)
    claimed = db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                status = 'running',
                error_code = NULL,
                attempts = attempts + 1,
                started_at = :now,
                completed_at = NULL,
                updated_at = :now
            WHERE media_id = :media_id
              AND (
                    status IN ('pending', 'failed')
                    OR (
                        status = 'running'
                        AND COALESCE(updated_at, started_at) < :running_lease_cutoff
                    )
              )
            RETURNING request_reason
            """
        ),
        {
            "media_id": media_id,
            "now": claim_now,
            "running_lease_cutoff": running_lease_cutoff,
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
            return {"status": "skipped", "reason": "job_not_found"}
        return {
            "status": "skipped",
            "reason": "not_pending",
            "job_status": str(snapshot[0]),
            "error_code": snapshot[1],
        }

    request_reason = str(claimed[0] or "episode_open")
    _set_media_transcript_state(
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
        return {"status": "failed", "error_code": ApiErrorCode.E_MEDIA_NOT_FOUND.value}

    if str(media_row[0]) != "podcast_episode":
        _mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_INVALID_KIND.value,
            error_message="Invalid media kind for podcast transcription",
            now=claim_now,
        )
        db.commit()
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_KIND.value}

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
    _set_media_transcript_state(
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
    except Exception:
        logger.warning(
            "podcast_transcription_heartbeat_start_failed",
            media_id=str(media_id),
        )
    try:
        transcription_result = _transcribe_podcast_audio(audio_url)
    except Exception as exc:
        now = datetime.now(UTC)
        logger.exception(
            "podcast_transcription_unhandled_error",
            media_id=str(media_id),
            error=str(exc),
        )
        _mark_podcast_transcription_failure(
            db,
            media_id=media_id,
            error_code=ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            error_message="Transcription failed",
            now=now,
        )
        db.commit()
        return {"status": "failed", "error_code": ApiErrorCode.E_TRANSCRIPTION_FAILED.value}
    finally:
        _stop_transcription_job_heartbeat(heartbeat)
    transcription_status = str(transcription_result.get("status") or "failed")
    transcript_segments = _normalize_transcript_segments(transcription_result.get("segments"))
    transcription_error_code = _normalize_terminal_transcription_error_code(
        transcription_result.get("error_code")
    )
    transcription_error_message = str(transcription_result.get("error_message") or "").strip()
    diagnostic_error_code = _normalize_diagnostic_transcription_error_code(
        transcription_result.get("diagnostic_error_code")
    )
    now = datetime.now(UTC)

    if transcription_status == "completed" and not transcript_segments:
        transcription_status = "failed"
        transcription_error_code = ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
        transcription_error_message = "Transcript unavailable"
        diagnostic_error_code = None

    if transcription_status == "completed" and transcript_segments:
        transcript_version_id = _create_next_transcript_version(
            db,
            media_id=media_id,
            created_by_user_id=requested_by_user_id,
            request_reason=request_reason,
            now=now,
        )
        db.execute(
            text(
                """
                UPDATE fragments
                SET idx = idx + 1000000
                WHERE media_id = :media_id
                """
            ),
            {"media_id": media_id},
        )
        _insert_transcript_fragments(
            db,
            media_id,
            transcript_segments,
            now=now,
            transcript_version_id=transcript_version_id,
        )
        _insert_transcript_segments_for_version(
            db,
            media_id=media_id,
            transcript_version_id=transcript_version_id,
            transcript_segments=transcript_segments,
            now=now,
        )
        semantic_status = "ready"
        semantic_error_code: str | None = None
        try:
            _insert_transcript_chunks_for_version(
                db,
                media_id=media_id,
                transcript_version_id=transcript_version_id,
                transcript_segments=transcript_segments,
                now=now,
            )
        except Exception as exc:
            # Transcript text remains usable even when semantic indexing fails.
            semantic_status = "failed"
            semantic_error_code = ApiErrorCode.E_INTERNAL.value
            logger.exception(
                "podcast_transcript_semantic_index_failed",
                media_id=str(media_id),
                transcript_version_id=str(transcript_version_id),
                error=str(exc),
            )
            db.execute(
                text(
                    """
                    DELETE FROM podcast_transcript_chunks
                    WHERE transcript_version_id = :transcript_version_id
                    """
                ),
                {"transcript_version_id": transcript_version_id},
            )
        db.execute(
            text(
                """
                UPDATE media
                SET
                    processing_status = 'ready_for_reading',
                    failure_stage = NULL,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    processing_completed_at = :now,
                    failed_at = NULL,
                    updated_at = :now
                WHERE id = :media_id
                """
            ),
            {
                "media_id": media_id,
                "now": now,
            },
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
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state="ready",
            transcript_coverage="full",
            semantic_status=semantic_status,
            active_transcript_version_id=transcript_version_id,
            last_request_reason=request_reason,
            last_error_code=semantic_error_code,
            now=now,
        )
        _commit_reserved_usage_for_media(db, media_id=media_id, now=now)
        db.commit()
        _try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id)
        return {
            "status": "completed",
            "segment_count": len(transcript_segments),
            "transcript_version_id": str(transcript_version_id),
        }

    terminal_error_code = transcription_error_code or ApiErrorCode.E_TRANSCRIPTION_FAILED.value
    terminal_error_message = transcription_error_message or "Transcription failed"
    _mark_podcast_transcription_failure(
        db,
        media_id=media_id,
        error_code=terminal_error_code,
        error_message=terminal_error_message,
        now=now,
    )
    db.commit()
    _try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id)
    return {"status": "failed", "error_code": terminal_error_code}


def repair_podcast_transcript_semantic_index_now(
    db: Session,
    *,
    media_id: UUID,
    request_reason: str = "operator_requeue",
    request_id: str | None = None,
) -> dict[str, Any]:
    _ = request_id
    now = datetime.now(UTC)
    active_embedding_model = current_transcript_embedding_model()
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
        return {"status": "skipped", "reason": "locked"}

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
              AND mts.active_transcript_version_id IS NOT NULL
              AND (
                  mts.semantic_status IN ('pending', 'failed')
                  OR (
                      mts.semantic_status = 'ready'
                      AND (
                          NOT EXISTS (
                              SELECT 1
                              FROM podcast_transcript_chunks tc
                              WHERE tc.transcript_version_id = mts.active_transcript_version_id
                          )
                          OR EXISTS (
                              SELECT 1
                              FROM podcast_transcript_chunks tc
                              WHERE tc.transcript_version_id = mts.active_transcript_version_id
                                AND (
                                    tc.embedding_vector IS NULL
                                    OR tc.embedding_model IS NULL
                                    OR tc.embedding_model <> :active_embedding_model
                                )
                          )
                      )
                  )
              )
            RETURNING mts.active_transcript_version_id, mts.transcript_state, mts.transcript_coverage
            """
        ),
        {
            "media_id": media_id,
            "request_reason": normalized_reason,
            "now": now,
            "active_embedding_model": active_embedding_model,
        },
    ).fetchone()
    if claim_row is None:
        return {"status": "skipped", "reason": "not_repairable"}

    transcript_version_id = claim_row[0]
    transcript_state = str(claim_row[1] or "ready")
    transcript_coverage = str(claim_row[2] or "full")
    segment_rows = db.execute(
        text(
            """
            SELECT canonical_text, t_start_ms, t_end_ms, speaker_label
            FROM podcast_transcript_segments
            WHERE transcript_version_id = :transcript_version_id
            ORDER BY segment_idx ASC
            """
        ),
        {"transcript_version_id": transcript_version_id},
    ).fetchall()

    transcript_segments: list[dict[str, Any]] = []
    for row in segment_rows:
        canonical_text = str(row[0] or "").strip()
        t_start_ms = row[1]
        t_end_ms = row[2]
        if not canonical_text or t_start_ms is None or t_end_ms is None:
            continue
        transcript_segments.append(
            {
                "text": canonical_text,
                "t_start_ms": int(t_start_ms),
                "t_end_ms": int(t_end_ms),
                "speaker_label": row[3],
            }
        )

    if not transcript_segments:
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="failed",
            active_transcript_version_id=transcript_version_id,
            last_request_reason=normalized_reason,
            last_error_code=ApiErrorCode.E_INTERNAL.value,
            now=now,
        )
        return {
            "status": "failed",
            "error_code": ApiErrorCode.E_INTERNAL.value,
            "reason": "segments_missing",
        }

    try:
        db.execute(
            text(
                """
                DELETE FROM podcast_transcript_chunks
                WHERE transcript_version_id = :transcript_version_id
                """
            ),
            {"transcript_version_id": transcript_version_id},
        )
        _insert_transcript_chunks_for_version(
            db,
            media_id=media_id,
            transcript_version_id=transcript_version_id,
            transcript_segments=transcript_segments,
            now=now,
        )
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="ready",
            active_transcript_version_id=transcript_version_id,
            last_request_reason=normalized_reason,
            last_error_code=None,
            now=now,
        )
        return {
            "status": "completed",
            "transcript_version_id": str(transcript_version_id),
            "chunk_count": len(transcript_segments),
        }
    except Exception as exc:
        logger.exception(
            "podcast_semantic_repair_failed",
            media_id=str(media_id),
            transcript_version_id=str(transcript_version_id),
            error=str(exc),
        )
        db.execute(
            text(
                """
                DELETE FROM podcast_transcript_chunks
                WHERE transcript_version_id = :transcript_version_id
                """
            ),
            {"transcript_version_id": transcript_version_id},
        )
        _set_media_transcript_state(
            db,
            media_id=media_id,
            transcript_state=transcript_state,
            transcript_coverage=transcript_coverage,
            semantic_status="failed",
            active_transcript_version_id=transcript_version_id,
            last_request_reason=normalized_reason,
            last_error_code=ApiErrorCode.E_INTERNAL.value,
            now=now,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INTERNAL.value}


def _insert_transcript_fragments(
    db: Session,
    media_id: UUID,
    transcript_segments: list[dict[str, Any]],
    *,
    now: datetime,
    transcript_version_id: UUID | None = None,
) -> None:
    _shared_insert_transcript_fragments(
        db,
        media_id,
        transcript_segments,
        now=now,
        transcript_version_id=transcript_version_id,
    )


def _ensure_media_transcript_state_row(
    db: Session,
    *,
    media_id: UUID,
    processing_status: str,
    last_error_code: str | None,
    now: datetime,
    request_reason: str | None = None,
) -> None:
    if processing_status in {"ready_for_reading", "embedding", "ready"}:
        transcript_state = "ready"
    elif processing_status == "extracting":
        transcript_state = "running"
    elif (
        processing_status == "failed"
        and last_error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
    ):
        transcript_state = "unavailable"
    elif (
        processing_status == "failed"
        and last_error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value
    ):
        transcript_state = "failed_quota"
    elif processing_status == "failed":
        transcript_state = "failed_provider"
    else:
        transcript_state = "not_requested"

    transcript_coverage = "full" if transcript_state == "ready" else "none"
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                active_transcript_version_id,
                last_request_reason,
                last_error_code,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :transcript_state,
                :transcript_coverage,
                'none',
                NULL,
                :last_request_reason,
                :last_error_code,
                :created_at,
                :updated_at
            )
            ON CONFLICT (media_id) DO NOTHING
            """
        ),
        {
            "media_id": media_id,
            "transcript_state": transcript_state,
            "transcript_coverage": transcript_coverage,
            "last_request_reason": request_reason,
            "last_error_code": last_error_code,
            "created_at": now,
            "updated_at": now,
        },
    )


def _set_media_transcript_state(
    db: Session,
    *,
    media_id: UUID,
    transcript_state: str,
    transcript_coverage: str,
    semantic_status: str | None = None,
    active_transcript_version_id: UUID | None = None,
    last_request_reason: str | None = None,
    last_error_code: str | None = None,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id,
                transcript_state,
                transcript_coverage,
                semantic_status,
                active_transcript_version_id,
                last_request_reason,
                last_error_code,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :transcript_state,
                :transcript_coverage,
                COALESCE(:semantic_status, 'none'),
                :active_transcript_version_id,
                :last_request_reason,
                :last_error_code,
                :updated_at,
                :updated_at
            )
            ON CONFLICT (media_id)
            DO UPDATE SET
                transcript_state = EXCLUDED.transcript_state,
                transcript_coverage = EXCLUDED.transcript_coverage,
                semantic_status = COALESCE(:semantic_status, media_transcript_states.semantic_status),
                active_transcript_version_id = COALESCE(
                    EXCLUDED.active_transcript_version_id,
                    media_transcript_states.active_transcript_version_id
                ),
                last_request_reason = COALESCE(
                    EXCLUDED.last_request_reason,
                    media_transcript_states.last_request_reason
                ),
                last_error_code = EXCLUDED.last_error_code,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "media_id": media_id,
            "transcript_state": transcript_state,
            "transcript_coverage": transcript_coverage,
            "semantic_status": semantic_status,
            "active_transcript_version_id": active_transcript_version_id,
            "last_request_reason": last_request_reason,
            "last_error_code": last_error_code,
            "updated_at": now,
        },
    )


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


def _create_next_transcript_version(
    db: Session,
    *,
    media_id: UUID,
    created_by_user_id: UUID | None,
    request_reason: str,
    transcript_coverage: str = "full",
    now: datetime,
) -> UUID:
    # Serialize version allocation per media to avoid MAX(version_no)+1 races.
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"podcast-transcript-version:{media_id}"},
    )
    db.execute(
        text(
            """
            UPDATE podcast_transcript_versions
            SET is_active = false, updated_at = :updated_at
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id, "updated_at": now},
    )
    next_version_no = db.execute(
        text(
            """
            SELECT COALESCE(MAX(version_no), 0) + 1
            FROM podcast_transcript_versions
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id},
    ).scalar()
    version_row = db.execute(
        text(
            """
            INSERT INTO podcast_transcript_versions (
                media_id,
                version_no,
                transcript_coverage,
                is_active,
                request_reason,
                created_by_user_id,
                created_at,
                updated_at
            )
            VALUES (
                :media_id,
                :version_no,
                :transcript_coverage,
                true,
                :request_reason,
                :created_by_user_id,
                :created_at,
                :updated_at
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "version_no": int(next_version_no or 1),
            "transcript_coverage": transcript_coverage,
            "request_reason": request_reason,
            "created_by_user_id": created_by_user_id,
            "created_at": now,
            "updated_at": now,
        },
    ).fetchone()
    assert version_row is not None
    return version_row[0]


def _insert_transcript_segments_for_version(
    db: Session,
    *,
    media_id: UUID,
    transcript_version_id: UUID,
    transcript_segments: list[dict[str, Any]],
    now: datetime,
) -> None:
    for segment_idx, segment in enumerate(transcript_segments):
        db.execute(
            text(
                """
                INSERT INTO podcast_transcript_segments (
                    transcript_version_id,
                    media_id,
                    segment_idx,
                    canonical_text,
                    t_start_ms,
                    t_end_ms,
                    speaker_label,
                    created_at
                )
                VALUES (
                    :transcript_version_id,
                    :media_id,
                    :segment_idx,
                    :canonical_text,
                    :t_start_ms,
                    :t_end_ms,
                    :speaker_label,
                    :created_at
                )
                """
            ),
            {
                "transcript_version_id": transcript_version_id,
                "media_id": media_id,
                "segment_idx": segment_idx,
                "canonical_text": segment["text"],
                "t_start_ms": segment["t_start_ms"],
                "t_end_ms": segment["t_end_ms"],
                "speaker_label": segment.get("speaker_label"),
                "created_at": now,
            },
        )


def _insert_transcript_chunks_for_version(
    db: Session,
    *,
    media_id: UUID,
    transcript_version_id: UUID,
    transcript_segments: list[dict[str, Any]],
    now: datetime,
) -> None:
    chunks = chunk_transcript_segments(transcript_segments)
    embedding_dims = transcript_embedding_dimensions()
    for chunk in chunks:
        db.execute(
            text(
                f"""
                INSERT INTO podcast_transcript_chunks (
                    transcript_version_id,
                    media_id,
                    chunk_idx,
                    chunk_text,
                    t_start_ms,
                    t_end_ms,
                    embedding,
                    embedding_vector,
                    embedding_model,
                    created_at
                )
                VALUES (
                    :transcript_version_id,
                    :media_id,
                    :chunk_idx,
                    :chunk_text,
                    :t_start_ms,
                    :t_end_ms,
                    CAST(:embedding AS jsonb),
                    CAST(:embedding_vector AS vector({embedding_dims})),
                    :embedding_model,
                    :created_at
                )
                """
            ),
            {
                "transcript_version_id": transcript_version_id,
                "media_id": media_id,
                "chunk_idx": chunk["chunk_idx"],
                "chunk_text": chunk["chunk_text"],
                "t_start_ms": chunk["t_start_ms"],
                "t_end_ms": chunk["t_end_ms"],
                "embedding": json.dumps(chunk["embedding"]),
                "embedding_vector": to_pgvector_literal(chunk["embedding"]),
                "embedding_model": chunk["embedding_model"],
                "created_at": now,
            },
        )


def _get_usage_snapshot(
    db: Session,
    *,
    viewer_id: UUID,
    usage_date: date,
) -> dict[str, int]:
    row = db.execute(
        text(
            """
            SELECT minutes_used, minutes_reserved
            FROM podcast_transcription_usage_daily
            WHERE user_id = :user_id AND usage_date = :usage_date
            """
        ),
        {"user_id": viewer_id, "usage_date": usage_date},
    ).fetchone()
    used_minutes = int((row[0] if row is not None else 0) or 0)
    reserved_minutes = int((row[1] if row is not None else 0) or 0)
    return {
        "used": used_minutes,
        "reserved": reserved_minutes,
        "total": used_minutes + reserved_minutes,
    }


def _reserve_usage_minutes_or_raise(
    db: Session,
    *,
    user_id: UUID,
    usage_date: date,
    usage_start_date: date,
    usage_end_date: date,
    required_minutes: int,
    monthly_limit_minutes: int,
    now: datetime,
) -> dict[str, int]:
    if required_minutes <= 0:
        usage_snapshot = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
        return {
            "used": usage_snapshot["used"],
            "reserved": usage_snapshot["reserved"],
            "total": usage_snapshot["used"] + usage_snapshot["reserved"],
        }

    usage_before = get_transcription_usage(db, user_id, usage_start_date, usage_end_date)
    if usage_before["used"] + usage_before["reserved"] + required_minutes > monthly_limit_minutes:
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

    row = db.execute(
        text(
            """
            INSERT INTO podcast_transcription_usage_daily (
                user_id,
                usage_date,
                minutes_used,
                minutes_reserved,
                updated_at
            )
            SELECT
                :user_id,
                :usage_date,
                0,
                :minutes_reserved,
                :updated_at
            WHERE :minutes_reserved <= :monthly_limit_minutes
            ON CONFLICT (user_id, usage_date)
            DO UPDATE SET
                minutes_reserved = (
                    podcast_transcription_usage_daily.minutes_reserved
                    + EXCLUDED.minutes_reserved
                ),
                updated_at = EXCLUDED.updated_at
            WHERE (
                podcast_transcription_usage_daily.minutes_used
                + podcast_transcription_usage_daily.minutes_reserved
                + EXCLUDED.minutes_reserved
                <= :monthly_limit_minutes
            )
            RETURNING minutes_used, minutes_reserved
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "minutes_reserved": required_minutes,
            "monthly_limit_minutes": monthly_limit_minutes,
            "updated_at": now,
        },
    ).fetchone()

    if row is None:
        usage_snapshot = _get_usage_snapshot(db, viewer_id=user_id, usage_date=usage_date)
        logger.warning(
            "podcast_quota_exceeded",
            viewer_id=str(user_id),
            usage_date=usage_date.isoformat(),
            used_minutes=usage_snapshot["used"],
            reserved_minutes=usage_snapshot["reserved"],
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


def _clear_job_reservation(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                reserved_minutes = 0,
                reservation_usage_date = NULL,
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {"media_id": media_id, "now": now},
    )


def _release_reserved_usage_for_media(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    reservation_row = db.execute(
        text(
            """
            SELECT requested_by_user_id, reservation_usage_date, reserved_minutes
            FROM podcast_transcription_jobs
            WHERE media_id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if reservation_row is None:
        return

    user_id = reservation_row[0]
    usage_date = reservation_row[1]
    reserved_minutes = int(reservation_row[2] or 0)
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
    _clear_job_reservation(db, media_id=media_id, now=now)


def _commit_reserved_usage_for_media(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
) -> None:
    reservation_row = db.execute(
        text(
            """
            SELECT requested_by_user_id, reservation_usage_date, reserved_minutes
            FROM podcast_transcription_jobs
            WHERE media_id = :media_id
            FOR UPDATE
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if reservation_row is None:
        return

    user_id = reservation_row[0]
    usage_date = reservation_row[1]
    reserved_minutes = int(reservation_row[2] or 0)
    if user_id is None or usage_date is None or reserved_minutes <= 0:
        _clear_job_reservation(db, media_id=media_id, now=now)
        return

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
                :minutes_used,
                0,
                :updated_at
            )
            ON CONFLICT (user_id, usage_date)
            DO UPDATE SET
                minutes_used = (
                    podcast_transcription_usage_daily.minutes_used + EXCLUDED.minutes_used
                ),
                minutes_reserved = GREATEST(
                    podcast_transcription_usage_daily.minutes_reserved - EXCLUDED.minutes_used,
                    0
                ),
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "user_id": user_id,
            "usage_date": usage_date,
            "minutes_used": reserved_minutes,
            "updated_at": now,
        },
    )
    _clear_job_reservation(db, media_id=media_id, now=now)


def _episode_minutes(episode: dict[str, Any]) -> int:
    seconds = _coerce_positive_int(episode.get("duration_seconds"))
    if seconds is None:
        return 1
    return max(1, (seconds + 59) // 60)


def _coerce_positive_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value


def _coerce_non_negative_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value


def _normalize_terminal_transcription_error_code(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    allowed = {
        ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
        ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
        ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
    }
    if value in allowed:
        return value
    return ApiErrorCode.E_TRANSCRIPTION_FAILED.value


def _normalize_diagnostic_transcription_error_code(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    if value == ApiErrorCode.E_DIARIZATION_FAILED.value:
        return value
    return None


def _transcription_failure_result(error_code: str, error_message: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "error_code": error_code,
        "error_message": error_message,
    }


def _transcribe_podcast_audio(audio_url: str | None) -> dict[str, Any]:
    normalized_audio_url = str(audio_url or "").strip()
    if not normalized_audio_url:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "Transcript unavailable",
        )

    try:
        validate_requested_url(normalized_audio_url)
    except InvalidRequestError:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "Transcript unavailable",
        )

    settings = get_settings()
    if not settings.deepgram_api_key:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "Transcription provider credentials are not configured",
        )

    diarized_result = _transcribe_with_deepgram(normalized_audio_url, diarize=True)
    if diarized_result.get("status") == "completed":
        diarized_result["diagnostic_error_code"] = None
        return diarized_result

    fallback_result = _transcribe_with_deepgram(normalized_audio_url, diarize=False)
    if fallback_result.get("status") == "completed":
        fallback_result["diagnostic_error_code"] = ApiErrorCode.E_DIARIZATION_FAILED.value
        return fallback_result

    return fallback_result


def _transcribe_with_deepgram(audio_url: str, *, diarize: bool) -> dict[str, Any]:
    settings = get_settings()
    request_url = f"{settings.deepgram_base_url.rstrip('/')}{_DEEPGRAM_LISTEN_PATH}"
    diarize_str = "true" if diarize else "false"
    try:
        response = httpx.post(
            request_url,
            headers={
                "Authorization": f"Token {settings.deepgram_api_key}",
                "Content-Type": "application/json",
            },
            params={
                "model": settings.deepgram_model,
                "diarize": diarize_str,
                "utterances": "true",
                "smart_format": "true",
                "punctuate": "true",
                "language": "en",
            },
            json={"url": audio_url},
            timeout=settings.podcast_transcription_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.TimeoutException:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
            "Transcription timed out",
        )
    except httpx.HTTPStatusError as exc:
        code = (
            ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value
            if exc.response.status_code in {408, 504}
            else ApiErrorCode.E_TRANSCRIPTION_FAILED.value
        )
        logger.warning(
            "podcast_transcription_provider_http_error",
            audio_url=audio_url,
            diarize=diarize,
            status_code=exc.response.status_code,
        )
        return _transcription_failure_result(code, "Transcription failed")
    except Exception as exc:
        logger.warning(
            "podcast_transcription_provider_request_failed",
            audio_url=audio_url,
            diarize=diarize,
            error=str(exc),
        )
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "Transcription failed",
        )

    segments = _extract_deepgram_segments(payload)
    if not segments:
        return _transcription_failure_result(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "Transcript unavailable",
        )

    return {
        "status": "completed",
        "segments": segments,
    }


def _extract_deepgram_segments(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    results = payload.get("results")
    if not isinstance(results, dict):
        return []

    utterances = results.get("utterances")
    if isinstance(utterances, list):
        segments: list[dict[str, Any]] = []
        for utterance in utterances:
            if not isinstance(utterance, dict):
                continue
            transcript = str(utterance.get("transcript") or "").strip()
            if not transcript:
                continue
            t_start_ms = _seconds_to_ms(utterance.get("start"))
            t_end_ms = _seconds_to_ms(utterance.get("end"))
            if t_start_ms is None or t_end_ms is None:
                continue
            speaker_value = utterance.get("speaker")
            speaker_label = str(speaker_value).strip() if speaker_value is not None else None
            if speaker_label == "":
                speaker_label = None
            segments.append(
                {
                    "text": transcript,
                    "t_start_ms": t_start_ms,
                    "t_end_ms": t_end_ms,
                    "speaker_label": speaker_label,
                }
            )
        if segments:
            return segments

    channels = results.get("channels")
    if not isinstance(channels, list) or not channels:
        return []
    first_channel = channels[0]
    if not isinstance(first_channel, dict):
        return []
    alternatives = first_channel.get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        return []
    first_alt = alternatives[0]
    if not isinstance(first_alt, dict):
        return []

    transcript = str(first_alt.get("transcript") or "").strip()
    duration_seconds = None
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        duration_seconds = metadata.get("duration")
    duration_ms = _seconds_to_ms(duration_seconds)
    if duration_ms is None:
        words = first_alt.get("words")
        duration_ms = _word_range_end_ms(words)
    if not transcript or duration_ms is None:
        return []

    return [
        {
            "text": transcript,
            "t_start_ms": 0,
            "t_end_ms": duration_ms,
            "speaker_label": None,
        }
    ]


def _seconds_to_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        seconds = float(raw_value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds):
        return None
    if seconds < 0:
        return None
    return int(round(seconds * 1000))


def _word_range_end_ms(raw_words: Any) -> int | None:
    if not isinstance(raw_words, list) or not raw_words:
        return None
    max_end_ms: int | None = None
    for word in raw_words:
        if not isinstance(word, dict):
            continue
        end_ms = _seconds_to_ms(word.get("end"))
        if end_ms is None:
            continue
        if max_end_ms is None or end_ms > max_end_ms:
            max_end_ms = end_ms
    return max_end_ms


def _normalize_transcript_segments(raw_segments: Any) -> list[dict[str, Any]]:
    return _shared_normalize_transcript_segments(raw_segments)


def _canonicalize_transcript_segment_text(raw_value: Any) -> str:
    return _shared_canonicalize_transcript_segment_text(raw_value)
