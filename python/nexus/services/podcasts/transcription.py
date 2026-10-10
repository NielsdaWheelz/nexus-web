"""Podcast transcript admission, batch admission and worker execution."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.session import transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    ConflictError,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
from nexus.schemas.media import TranscriptCoverage, TranscriptRequestOut, TranscriptState
from nexus.schemas.media import TranscriptRequestReason as TranscriptResponseReason
from nexus.schemas.media_summary import MediaProcessingStatus
from nexus.schemas.podcast import (
    PodcastEpisodeQueryTranscriptForecastOut,
    PodcastEpisodeQueryTranscriptRequestOut,
    PodcastEpisodeQueryTranscriptTarget,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
    bump_collection_families,
    read_collection_revision,
)
from nexus.services.rss_transcript_fetch import fetch_rss_transcript
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import publish_source_transcript, write_current_transcript
from nexus.services.transcripts.request_reason import (
    TranscriptRequestReason,
    require_transcript_request_reason,
)
from nexus.services.transcripts.semantic import request_transcript_semantic_repair
from nexus.services.transcripts.state import (
    ensure_media_transcript_state_row,
    set_media_transcript_state,
)
from nexus.services.youtube import fetch_youtube_transcript

from .deepgram_adapter import get_deepgram_client
from .episodes import episode_selection_fingerprint, resolve_episode_selection_ids

logger = get_logger(__name__)

_READY_STATES = {"ready", "partial"}
_READY_COVERAGES = {"partial", "full"}
_INFLIGHT_STATES = {"queued", "running"}
_INFLIGHT_JOB_STATUSES = {"pending", "running"}


@dataclass(frozen=True)
class PodcastTranscriptionCompleted:
    """Successful artifact result from one podcast transcription run."""

    segment_count: int
    status: Literal["completed"] = "completed"


def request_media_transcript_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    reason: TranscriptResponseReason,
    request_id: str | None = None,
) -> TranscriptRequestOut:
    """Admit one explicit transcript request for supported Media."""
    media = _read_transcript_media(db, viewer_id=viewer_id, media_id=media_id)
    now = datetime.now(UTC)
    if media["kind"] == "video":
        return _import_youtube_captions(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            media=media,
            request_reason=reason,
            now=now,
        )
    if media["kind"] != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript request is only supported for podcast episodes.",
        )
    with transaction(db):
        return _admit_episode_transcript(
            db,
            viewer_id=viewer_id,
            media_id=media_id,
            media=media,
            request_reason=reason,
            request_id=request_id,
            now=now,
        )


def forecast_podcast_episode_query_transcripts(
    db: Session,
    *,
    viewer_id: UUID,
    target: PodcastEpisodeQueryTranscriptTarget,
) -> PodcastEpisodeQueryTranscriptForecastOut:
    """Count and fingerprint every eligible episode of the selection."""
    media_ids = resolve_episode_selection_ids(
        db,
        viewer_id=viewer_id,
        podcast_id=target.podcast_id,
        selection=target.selection,
        transcript_eligible_only=True,
    )
    return PodcastEpisodeQueryTranscriptForecastOut(
        eligible_count=len(media_ids),
        selection_fingerprint=episode_selection_fingerprint(media_ids),
    )


def request_podcast_episode_query_transcripts(
    db: Session,
    *,
    viewer_id: UUID,
    target: PodcastEpisodeQueryTranscriptTarget,
    expected_fingerprint: str,
) -> PodcastEpisodeQueryTranscriptRequestOut:
    """Queue the whole fingerprinted selection, or nothing at all."""
    with transaction(db):
        media_ids = resolve_episode_selection_ids(
            db,
            viewer_id=viewer_id,
            podcast_id=target.podcast_id,
            selection=target.selection,
            transcript_eligible_only=True,
        )
        if episode_selection_fingerprint(media_ids) != expected_fingerprint:
            raise ConflictError(
                ApiErrorCode.E_SELECTION_CHANGED,
                "Episode selection changed before transcript request",
            )
        queued_count = 0
        for media_id in media_ids:
            media = _read_transcript_media(db, viewer_id=viewer_id, media_id=media_id)
            if media["kind"] != "podcast_episode":
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_KIND,
                    "Transcript batch admission only supports podcast episodes.",
                )
            admission = _admit_episode_transcript(
                db,
                viewer_id=viewer_id,
                media_id=media_id,
                media=media,
                request_reason=target.reason,
                request_id=None,
                now=datetime.now(UTC),
            )
            queued_count += int(admission.request_enqueued)
        return PodcastEpisodeQueryTranscriptRequestOut(
            matched_count=len(media_ids),
            queued_count=queued_count,
            collection_revision=read_collection_revision(
                db, viewer_id=viewer_id, family=CollectionFamily.PodcastEpisodes
            ),
        )


def reset_podcast_transcription_job(
    db: Session, *, media_id: UUID, request_reason: TranscriptRequestReason
) -> None:
    """Put the episode's one job row back to pending for a new source attempt.

    The caller holds the media row lock; that lock is what keeps at most one
    queued job per episode.
    """
    db.execute(
        text(
            """
            INSERT INTO podcast_transcription_jobs (media_id, request_reason, status)
            VALUES (:media_id, :request_reason, 'pending')
            ON CONFLICT (media_id) DO UPDATE
            SET request_reason = EXCLUDED.request_reason,
                status = 'pending',
                error_code = NULL,
                started_at = NULL,
                completed_at = NULL,
                updated_at = now()
            """
        ),
        {"media_id": media_id, "request_reason": request_reason},
    )


def run_podcast_transcription_now(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    publication_fence: SourcePublicationFence,
) -> PodcastTranscriptionCompleted:
    """Publish the publisher sidecar if there is one, else generate with Deepgram."""
    snapshot = session_factory()
    try:
        job = (
            snapshot.execute(
                text(
                    """
                    SELECT
                        episode.rss_transcript_url,
                        episode.duration_seconds,
                        job.request_reason
                    FROM podcast_episodes episode
                    JOIN podcast_transcription_jobs job ON job.media_id = episode.media_id
                    WHERE episode.media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one()
        )
        snapshot.rollback()
    finally:
        snapshot.close()

    sidecar_url = str(job["rss_transcript_url"] or "").strip() or None
    request_reason = require_transcript_request_reason(job["request_reason"])
    if sidecar_url is not None:
        duration_ms = (
            int(job["duration_seconds"]) * 1000 if job["duration_seconds"] is not None else None
        )
        segments = normalize_transcript_segments(
            fetch_rss_transcript(sidecar_url, episode_duration_ms=duration_ms)
        )
        if segments:
            now = datetime.now(UTC)

            def publish_publisher(db: Session, _attempt: object) -> None:
                publish_source_transcript(
                    db,
                    media_id=media_id,
                    request_reason=request_reason,
                    transcript_coverage="full",
                    transcript_segments=segments,
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
                        """
                    ),
                    {"media_id": media_id, "now": now},
                )

            run_source_publication_phase(
                session_factory=session_factory,
                label="publish_podcast_publisher_transcript",
                fence=publication_fence,
                media_ids=(media_id,),
                mutate=publish_publisher,
            )
            return PodcastTranscriptionCompleted(segment_count=len(segments))

    audio_url = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_podcast_transcription_running",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=lambda db, _attempt: _begin_generated_run(
            db, media_id=media_id, request_reason=request_reason
        ),
    )
    result = get_deepgram_client().transcribe(audio_url)
    segments = normalize_transcript_segments(result.segments)
    if result.status != "completed" or not segments:
        raise ApiError(
            ApiErrorCode(result.error_code or ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value),
            str(result.error_message or "").strip() or "Transcript unavailable",
        )
    now = datetime.now(UTC)

    def publish_generated(db: Session, _attempt: object) -> None:
        publish_source_transcript(
            db,
            media_id=media_id,
            request_reason=request_reason,
            transcript_coverage="full",
            transcript_segments=segments,
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
            {"media_id": media_id, "error_code": result.diagnostic_error_code, "now": now},
        )

    run_source_publication_phase(
        session_factory=session_factory,
        label="publish_podcast_transcript_artifacts",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish_generated,
    )
    return PodcastTranscriptionCompleted(segment_count=len(segments))


def _begin_generated_run(
    db: Session, *, media_id: UUID, request_reason: TranscriptRequestReason
) -> str | None:
    """Mark the job and transcript running, and read back the audio URL."""
    audio_url = db.scalar(
        text("SELECT external_playback_url FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
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
            """
        ),
        {"media_id": media_id},
    )
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
    bump_all_collection_families(
        db, families=(CollectionFamily.LibraryEntries, CollectionFamily.PodcastEpisodes)
    )
    return str(audio_url or "").strip() or None


def _admit_episode_transcript(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media: RowMapping,
    request_reason: TranscriptResponseReason,
    request_id: str | None,
    now: datetime,
) -> TranscriptRequestOut:
    """Precedence: already readable, in flight, then a new source attempt."""
    from nexus.services.media_source_ingest import (
        enqueue_podcast_episode_transcript_source_attempt,
    )

    state = media["transcript_state"]
    coverage = media["transcript_coverage"]
    if state in _READY_STATES and coverage in _READY_COVERAGES:
        repair = request_transcript_semantic_repair(
            db, media_id=media_id, request_reason=request_reason, now=now
        )
        return _response(
            media_id,
            "ready_for_reading",
            repair.transcript_state,
            repair.transcript_coverage,
            request_reason,
            enqueued=repair.outcome == "queued",
        )
    if state in _INFLIGHT_STATES or media["job_status"] in _INFLIGHT_JOB_STATUSES:
        return _response(
            media_id, "extracting", state or "queued", coverage or "none", request_reason
        )

    ensure_media_transcript_state_row(db, media_id=media_id, now=now, request_reason=request_reason)
    reset_podcast_transcription_job(db, media_id=media_id, request_reason=request_reason)
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
    enqueue_podcast_episode_transcript_source_attempt(
        db=db,
        media_id=media_id,
        viewer_id=viewer_id,
        request_reason=request_reason,
        request_id=request_id,
    )
    return _response(media_id, "extracting", "queued", "none", request_reason, enqueued=True)


def _import_youtube_captions(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    media: RowMapping,
    request_reason: TranscriptResponseReason,
    now: datetime,
) -> TranscriptRequestOut:
    """Install a YouTube video's published captions as its current transcript."""
    if media["provider"] != "youtube" or media["provider_id"] is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Explicit imported captions require canonical YouTube Media.",
        )
    db.rollback()
    caption_result = fetch_youtube_transcript(str(media["provider_id"]))
    segments = normalize_transcript_segments(caption_result.get("segments"))
    if caption_result.get("status") != "completed" or not segments:
        raise ApiError(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE, "YouTube captions are unavailable")
    with transaction(db):
        _read_transcript_media(db, viewer_id=viewer_id, media_id=media_id)
        write_current_transcript(
            db,
            media_id=media_id,
            request_reason=request_reason,
            transcript_coverage="full",
            transcript_segments=segments,
            transcript_origin="Imported",
            now=now,
        )
        bump_collection_families(
            db, viewer_ids=(viewer_id,), families=(CollectionFamily.LibraryEntries,)
        )
    return _response(media_id, "ready_for_reading", "ready", "full", request_reason)


def _read_transcript_media(db: Session, *, viewer_id: UUID, media_id: UUID) -> RowMapping:
    """Lock the Media row and read every fact the admission decision needs."""
    from nexus.auth.permissions import can_read_media

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = (
        db.execute(
            text(
                """
                SELECT
                    m.kind,
                    m.provider,
                    m.provider_id,
                    job.status AS job_status,
                    state.transcript_state,
                    state.transcript_coverage
                FROM media m
                LEFT JOIN podcast_transcription_jobs job ON job.media_id = m.id
                LEFT JOIN media_transcript_states state ON state.media_id = m.id
                WHERE m.id = :media_id
                FOR UPDATE OF m
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return row


def _response(
    media_id: UUID,
    processing_status: MediaProcessingStatus,
    transcript_state: TranscriptState,
    transcript_coverage: TranscriptCoverage,
    request_reason: TranscriptResponseReason,
    *,
    enqueued: bool = False,
) -> TranscriptRequestOut:
    """The one transcript-request body every admission branch returns."""
    return TranscriptRequestOut(
        media_id=str(media_id),
        processing_status=processing_status,
        transcript_state=transcript_state,
        transcript_coverage=transcript_coverage,
        request_reason=request_reason,
        request_enqueued=enqueued,
    )
