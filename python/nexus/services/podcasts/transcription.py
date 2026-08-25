"""Podcast transcript admission, execution, and repair services."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.coerce import coerce_positive_int
from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
)
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
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.rss_transcript_fetch import fetch_rss_transcript
from nexus.services.source_publication import (
    SourcePublicationFence,
    run_source_publication_phase,
)
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import (
    TranscriptRequestReason,
    publish_source_transcript,
    write_current_transcript,
)
from nexus.services.transcripts.semantic import request_transcript_semantic_repair
from nexus.services.transcripts.state import (
    ensure_media_transcript_state_row,
    set_media_transcript_state,
)
from nexus.services.youtube_transcripts import fetch_youtube_transcript

from .deepgram_adapter import (
    get_deepgram_client,
)
from .episodes import (
    episode_selection_fingerprint,
    resolve_transcript_eligible_episode_ids,
)
from .transcription_reservation_settlement import (
    commit_transcription_reservation,
    release_transcription_reservation,
)
from .transcription_usage import (
    TranscriptionBudget,
    read_transcription_budget,
    reserve_transcription_usage,
)

logger = get_logger(__name__)


def _bump_library_entry_collections(db: Session, *, viewer_id: UUID) -> None:
    bump_collection_families(
        db,
        viewer_ids=(viewer_id,),
        families=(CollectionFamily.LibraryEntries,),
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


@dataclass(frozen=True)
class _TranscriptRequestMedia:
    kind: str
    processing_status: str
    duration_seconds: int | None
    job_status: str | None
    transcript_state: str | None
    transcript_coverage: str | None
    semantic_status: str
    rss_transcript_url: str | None
    provider: str | None
    provider_id: str | None


@dataclass(frozen=True)
class PodcastTranscriptionAdmitted:
    kind: Literal["Admitted"] = "Admitted"


@dataclass(frozen=True)
class PodcastTranscriptionRejectedQuota:
    error: ApiError
    kind: Literal["RejectedQuota"] = "RejectedQuota"


type PodcastTranscriptionPreparation = (
    PodcastTranscriptionAdmitted | PodcastTranscriptionRejectedQuota
)
_PodcastTranscriptRequestResult = TranscriptRequestResponse | PodcastTranscriptionRejectedQuota


def _read_transcript_request_media(
    db: Session,
    *,
    media_id: UUID,
) -> _TranscriptRequestMedia | None:
    row = db.execute(
        text(
            """
            SELECT
                m.kind,
                m.processing_status,
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
                    SELECT pe.rss_transcript_url
                    FROM podcast_episodes pe
                    WHERE pe.media_id = m.id
                ) AS rss_transcript_url,
                m.provider,
                m.provider_id
            FROM media m
            WHERE m.id = :media_id
            FOR UPDATE OF m
            """
        ),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        return None
    return _TranscriptRequestMedia(
        kind=str(row[0] or ""),
        processing_status=str(row[1] or ""),
        duration_seconds=coerce_positive_int(row[2]),
        job_status=str(row[3] or "").strip() or None,
        transcript_state=str(row[4] or "").strip() or None,
        transcript_coverage=str(row[5] or "").strip() or None,
        semantic_status=str(row[6] or "").strip() or "none",
        rss_transcript_url=str(row[7] or "").strip() or None,
        provider=str(row[8] or "").strip() or None,
        provider_id=str(row[9] or "").strip() or None,
    )


def request_media_transcript_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    reason: TranscriptResponseReason,
    dry_run: bool = False,
    request_id: str | None = None,
) -> TranscriptRequestResponse:
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    now = datetime.now(UTC)
    media = _read_transcript_request_media(db, media_id=media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.kind == "video":
        return _request_youtube_video_transcript(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            media=media,
            request_reason=reason,
            dry_run=dry_run,
            now=now,
        )
    if media.kind == "podcast_episode":
        with transaction(db):
            result = _request_podcast_episode_transcript(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                media=media,
                request_reason=reason,
                dry_run=dry_run,
                request_id=request_id,
                now=now,
            )
        if isinstance(result, PodcastTranscriptionRejectedQuota):
            raise result.error
        return result

    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_KIND,
        "Transcript request is only supported for podcast episodes.",
    )


def _request_podcast_episode_transcript(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media: _TranscriptRequestMedia,
    request_reason: TranscriptResponseReason,
    dry_run: bool,
    request_id: str | None,
    now: datetime,
) -> _PodcastTranscriptRequestResult:
    already_ready = media.transcript_state in {
        "ready",
        "partial",
    } and media.transcript_coverage in {"partial", "full"}
    already_inflight = media.transcript_state in {"queued", "running"} or media.job_status in {
        "pending",
        "running",
    }
    if media.rss_transcript_url is not None and not already_ready and not already_inflight:
        response = _request_rss_podcast_transcript(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            media=media,
            request_reason=request_reason,
            dry_run=dry_run,
            request_id=request_id,
            now=now,
        )
        return response

    if already_ready:
        return _request_ready_podcast_transcript(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            media=media,
            request_reason=request_reason,
            dry_run=dry_run,
            request_id=request_id,
            now=now,
        )

    budget = read_transcription_budget(
        db,
        user_id=viewer_id,
        duration_seconds=media.duration_seconds,
        now=now,
    )
    effective_status = "extracting" if already_inflight else media.processing_status

    if dry_run:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=request_reason,
            dry_run=True,
            outcome="forecast",
            required_minutes=budget.required_minutes,
            remaining_minutes=budget.remaining_minutes,
            fits_budget=budget.fits,
            now=now,
        )
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=cast(MediaProcessingStatus, effective_status),
            transcript_state=media.transcript_state or "not_requested",
            transcript_coverage=media.transcript_coverage or "none",
            request_reason=request_reason,
            required_minutes=budget.required_minutes,
            remaining_minutes=budget.remaining_minutes,
            fits_budget=budget.fits,
            request_enqueued=False,
        )

    if not budget.fits and not already_inflight:
        return PodcastTranscriptionRejectedQuota(
            error=_transcript_quota_rejection(
                db,
                media_id=media_id,
                requested_by_user_id=viewer_id,
                request_reason=request_reason,
                budget=budget,
                now=now,
            )
        )

    if already_inflight:
        _record_podcast_transcript_request_audit(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=request_reason,
            dry_run=False,
            outcome="idempotent",
            required_minutes=budget.required_minutes,
            remaining_minutes=budget.remaining_minutes,
            fits_budget=True,
            now=now,
        )
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=cast(MediaProcessingStatus, effective_status),
            transcript_state=media.transcript_state or "queued",
            transcript_coverage=media.transcript_coverage or "none",
            request_reason=request_reason,
            required_minutes=budget.required_minutes,
            remaining_minutes=budget.remaining_minutes,
            fits_budget=True,
            request_enqueued=False,
        )

    if media.transcript_state is None:
        ensure_media_transcript_state_row(
            db,
            media_id=media_id,
            now=now,
            request_reason=request_reason,
        )

    remaining_minutes_after = reserve_transcription_usage(
        db,
        user_id=viewer_id,
        budget=budget,
        now=now,
    )

    _reset_podcast_transcription_job_for_source_attempt(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=request_reason,
        reserved_minutes=budget.required_minutes,
        reservation_usage_date=budget.usage_date,
        now=now,
    )

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

    from nexus.services.media_source_ingest import (
        enqueue_podcast_episode_transcript_source_attempt,
    )

    source_admission = enqueue_podcast_episode_transcript_source_attempt(
        db=db,
        media_id=media_id,
        viewer_id=viewer_id,
        request_reason=request_reason,
        request_id=request_id,
    )
    if source_admission != "created":
        # justify-defect: the Media lock and transcript state gate make a
        # pre-existing in-flight source attempt unreachable on this branch.
        raise AssertionError("podcast transcript source admission lost its state invariant")

    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=request_reason,
        dry_run=False,
        outcome="queued",
        required_minutes=budget.required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        now=now,
    )
    return TranscriptRequestResponse(
        media_id=str(media_id),
        processing_status="extracting",
        transcript_state="queued",
        transcript_coverage="none",
        request_reason=request_reason,
        required_minutes=budget.required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        request_enqueued=True,
    )


def _request_ready_podcast_transcript(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media: _TranscriptRequestMedia,
    request_reason: TranscriptResponseReason,
    dry_run: bool,
    request_id: str | None,
    now: datetime,
) -> TranscriptRequestResponse:
    if dry_run:
        outcome: Literal["forecast", "queued", "idempotent"] = "forecast"
        transcript_state = media.transcript_state or "ready"
        transcript_coverage = media.transcript_coverage or "full"
    else:
        admission = request_transcript_semantic_repair(
            db,
            media_id=media_id,
            requested_by_user_id=viewer_id,
            request_reason=request_reason,
            request_id=request_id,
            now=now,
        )
        outcome = admission.outcome
        transcript_state = admission.transcript_state
        transcript_coverage = admission.transcript_coverage

    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=request_reason,
        dry_run=dry_run,
        outcome=outcome,
        required_minutes=0,
        remaining_minutes=None,
        fits_budget=True,
        now=now,
    )
    return TranscriptRequestResponse(
        media_id=str(media_id),
        processing_status="ready_for_reading",
        transcript_state=transcript_state,
        transcript_coverage=transcript_coverage,
        request_reason=request_reason,
        required_minutes=0,
        remaining_minutes=None,
        fits_budget=True,
        request_enqueued=outcome == "queued",
    )


def _request_youtube_video_transcript(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media: _TranscriptRequestMedia,
    request_reason: str,
    dry_run: bool,
    now: datetime,
) -> TranscriptRequestResponse:
    if media.provider != "youtube" or media.provider_id is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Explicit imported captions require canonical YouTube Media.",
        )
    if dry_run:
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=cast(MediaProcessingStatus, media.processing_status),
            transcript_state=media.transcript_state or "not_requested",
            transcript_coverage=media.transcript_coverage or "none",
            request_reason=cast(TranscriptResponseReason, request_reason),
            required_minutes=0,
            remaining_minutes=None,
            fits_budget=True,
            request_enqueued=False,
        )

    db.rollback()
    caption_result = fetch_youtube_transcript(media.provider_id)
    caption_segments = normalize_transcript_segments(caption_result.get("segments"))
    if caption_result.get("status") != "completed" or not caption_segments:
        raise ApiError(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE,
            "YouTube captions are unavailable",
        )

    from nexus.auth.permissions import can_read_media

    with transaction(db):
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        write_current_transcript(
            db,
            media_id=media_id,
            request_reason=cast(TranscriptRequestReason, request_reason),
            transcript_coverage="full",
            transcript_segments=caption_segments,
            transcript_origin="Imported",
            now=now,
        )
        _bump_library_entry_collections(db, viewer_id=viewer_id)
    return TranscriptRequestResponse(
        media_id=str(media_id),
        processing_status="ready_for_reading",
        transcript_state="ready",
        transcript_coverage="full",
        request_reason=cast(TranscriptResponseReason, request_reason),
        required_minutes=0,
        remaining_minutes=None,
        fits_budget=True,
        request_enqueued=False,
    )


def _request_rss_podcast_transcript(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media: _TranscriptRequestMedia,
    request_reason: str,
    dry_run: bool,
    request_id: str | None,
    now: datetime,
) -> TranscriptRequestResponse:
    if dry_run:
        return TranscriptRequestResponse(
            media_id=str(media_id),
            processing_status=cast(MediaProcessingStatus, media.processing_status),
            transcript_state=media.transcript_state or "not_requested",
            transcript_coverage=media.transcript_coverage or "none",
            request_reason=cast(TranscriptResponseReason, request_reason),
            required_minutes=0,
            remaining_minutes=None,
            fits_budget=True,
            request_enqueued=False,
        )

    ensure_media_transcript_state_row(
        db,
        media_id=media_id,
        now=now,
        request_reason=request_reason,
    )
    release_transcription_reservation(db, media_id=media_id, now=now)
    _reset_podcast_transcription_job_for_source_attempt(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=request_reason,
        reserved_minutes=0,
        reservation_usage_date=None,
        now=now,
    )
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
    from nexus.services.media_source_ingest import (
        enqueue_podcast_episode_transcript_source_attempt,
    )

    source_admission = enqueue_podcast_episode_transcript_source_attempt(
        db=db,
        media_id=media_id,
        viewer_id=viewer_id,
        request_reason=request_reason,
        request_id=request_id,
    )
    if source_admission != "created":
        # justify-defect: the Media lock and transcript state gate make a
        # pre-existing in-flight source attempt unreachable on this branch.
        raise AssertionError("podcast transcript source admission lost its state invariant")
    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=viewer_id,
        request_reason=request_reason,
        dry_run=False,
        outcome="queued",
        required_minutes=0,
        remaining_minutes=None,
        fits_budget=True,
        now=now,
    )
    return TranscriptRequestResponse(
        media_id=str(media_id),
        processing_status="extracting",
        transcript_state="queued",
        transcript_coverage="none",
        request_reason=cast(TranscriptResponseReason, request_reason),
        required_minutes=0,
        remaining_minutes=None,
        fits_budget=True,
        request_enqueued=True,
    )


def _request_podcast_transcript_for_viewer_in_current_transaction(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    reason: TranscriptResponseReason,
    dry_run: bool,
    request_id: str | None = None,
) -> _PodcastTranscriptRequestResult:
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = _read_transcript_request_media(db, media_id=media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.kind != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript batch admission only supports podcast episodes.",
        )
    return _request_podcast_episode_transcript(
        db,
        viewer_id=viewer_id,
        media_id=media_id,
        media=media,
        request_reason=reason,
        dry_run=dry_run,
        request_id=request_id,
        now=datetime.now(UTC),
    )


def forecast_podcast_episode_query_transcripts(
    db: Session,
    *,
    viewer_id: UUID,
    target: PodcastEpisodeQueryTranscriptTarget,
) -> PodcastEpisodeQueryTranscriptForecastOut:
    with transaction(db):
        media_ids = resolve_transcript_eligible_episode_ids(
            db,
            viewer_id=viewer_id,
            podcast_id=target.podcast_id,
            selection=target.selection,
        )
        forecasts: list[TranscriptRequestResponse] = []
        for media_id in media_ids:
            forecast = _request_podcast_transcript_for_viewer_in_current_transaction(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                reason=target.reason,
                dry_run=True,
            )
            if isinstance(forecast, PodcastTranscriptionRejectedQuota):
                # justify-defect: dry-run admission never rejects quota.
                raise AssertionError("podcast transcript forecast returned a quota rejection")
            forecasts.append(forecast)
        required_minutes = sum(item.required_minutes for item in forecasts)
        remaining_values = [
            item.remaining_minutes for item in forecasts if item.remaining_minutes is not None
        ]
        remaining_minutes = min(remaining_values) if remaining_values else None
        result = PodcastEpisodeQueryTranscriptForecastOut(
            eligible_count=len(media_ids),
            required_minutes=required_minutes,
            remaining_minutes=(
                present(remaining_minutes) if remaining_minutes is not None else absent()
            ),
            fits_budget=remaining_minutes is None or required_minutes <= remaining_minutes,
            selection_fingerprint=episode_selection_fingerprint(media_ids),
        )
    return result


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
            admission = _request_podcast_transcript_for_viewer_in_current_transaction(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                reason=target.reason,
                dry_run=False,
            )
            if isinstance(admission, PodcastTranscriptionRejectedQuota):
                raise admission.error
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


def admit_generated_podcast_transcription_for_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_reason: str,
) -> PodcastTranscriptionPreparation:
    """Reserve generated work for an existing durable source attempt.

    Current readable transcript artifacts remain authoritative until the source
    publication fence replaces them. The caller owns authorization, source
    status, and commit.
    """
    now = datetime.now(UTC)
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
    budget = read_transcription_budget(
        db,
        user_id=requested_by_user_id,
        duration_seconds=duration_seconds,
        now=now,
    )
    if not budget.fits:
        return PodcastTranscriptionRejectedQuota(
            error=_transcript_quota_rejection(
                db,
                media_id=media_id,
                requested_by_user_id=requested_by_user_id,
                request_reason=request_reason,
                budget=budget,
                now=now,
            )
        )

    remaining_minutes_after = reserve_transcription_usage(
        db,
        user_id=requested_by_user_id,
        budget=budget,
        now=now,
    )
    _reset_podcast_transcription_job_for_source_attempt(
        db,
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_reason=request_reason,
        reserved_minutes=budget.required_minutes,
        reservation_usage_date=budget.usage_date,
        now=now,
    )
    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_reason=request_reason,
        dry_run=False,
        outcome="queued",
        required_minutes=budget.required_minutes,
        remaining_minutes=remaining_minutes_after,
        fits_budget=True,
        now=now,
    )
    return PodcastTranscriptionAdmitted()


def run_podcast_transcription_now(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
    publication_fence: SourcePublicationFence,
) -> TranscriptionRunResult:
    snapshot = session_factory()
    try:
        sidecar = snapshot.execute(
            text(
                """
                SELECT
                    episode.rss_transcript_url,
                    episode.duration_seconds,
                    media.language,
                    job.reserved_minutes,
                    job.requested_by_user_id,
                    job.request_reason
                FROM podcast_episodes episode
                JOIN media ON media.id = episode.media_id
                JOIN podcast_transcription_jobs job ON job.media_id = episode.media_id
                WHERE episode.media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        snapshot.rollback()
    finally:
        snapshot.close()
    if sidecar is None:
        raise AssertionError("podcast source attempt is missing its domain job")

    rss_transcript_url = str(sidecar[0] or "").strip() or None
    reserved_minutes = int(sidecar[3] or 0)
    effective_requester = UUID(str(sidecar[4])) if sidecar[4] is not None else requested_by_user_id
    if rss_transcript_url is not None and reserved_minutes == 0:
        rss_result = fetch_rss_transcript(
            [{"url": rss_transcript_url, "type": None, "language": sidecar[2]}],
            episode_duration_ms=(int(sidecar[1]) * 1000 if sidecar[1] is not None else None),
            episode_language=str(sidecar[2] or "").strip() or None,
        )
        rss_segments = normalize_transcript_segments(rss_result.get("segments"))
        if rss_result.get("status") == "completed" and rss_segments:
            now = datetime.now(UTC)

            def publish_publisher_transcript(db: Session, _attempt: object) -> None:
                publish_source_transcript(
                    db,
                    media_id=media_id,
                    request_reason=cast(
                        TranscriptRequestReason,
                        str(sidecar[5] or "episode_open"),
                    ),
                    transcript_coverage="full",
                    transcript_segments=rss_segments,
                    transcript_origin="Publisher",
                    now=now,
                )
                db.execute(
                    text(
                        """
                        UPDATE podcast_transcription_jobs
                        SET status = 'completed',
                            error_code = NULL,
                            attempts = attempts + 1,
                            started_at = COALESCE(started_at, :now),
                            completed_at = :now,
                            updated_at = :now
                        WHERE media_id = :media_id
                          AND reserved_minutes = 0
                        """
                    ),
                    {"media_id": media_id, "now": now},
                )

            run_source_publication_phase(
                session_factory=session_factory,
                label="publish_podcast_publisher_transcript",
                fence=publication_fence,
                media_ids=(media_id,),
                mutate=publish_publisher_transcript,
            )
            return TranscriptionRunResult(
                status="completed",
                segment_count=len(rss_segments),
            )

        if effective_requester is None:
            raise ApiError(
                ApiErrorCode.E_BILLING_REQUIRED,
                "Generated transcript fallback requires an AI tier.",
            )

        def admit_generated_fallback(
            db: Session, _attempt: object
        ) -> PodcastTranscriptionPreparation:
            return admit_generated_podcast_transcription_for_source_attempt(
                db,
                media_id=media_id,
                requested_by_user_id=effective_requester,
                request_reason=str(sidecar[5] or "episode_open"),
            )

        admission = run_source_publication_phase(
            session_factory=session_factory,
            label="admit_podcast_generated_fallback",
            fence=publication_fence,
            media_ids=(media_id,),
            mutate=admit_generated_fallback,
        )
        if isinstance(admission, PodcastTranscriptionRejectedQuota):
            raise admission.error

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
                transcript_origin="Generated",
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
            commit_transcription_reservation(db, media_id=media_id, now=now)

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
    reservation_usage_date: date | None,
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


def _transcript_quota_rejection(
    db: Session,
    *,
    media_id: UUID,
    requested_by_user_id: UUID,
    request_reason: str,
    budget: TranscriptionBudget,
    now: datetime,
) -> ApiError:
    assert not budget.fits  # justify-service-invariant-check: caller gates on budget.fits.
    _record_podcast_transcript_request_audit(
        db,
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_reason=request_reason,
        dry_run=False,
        outcome="rejected_quota",
        required_minutes=budget.required_minutes,
        remaining_minutes=budget.remaining_minutes,
        fits_budget=False,
        now=now,
    )
    return ApiError(
        ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
        "Monthly transcription quota exceeded",
    )
