"""Episode transcripts: admit one request or a whole selection, and run one attempt.

Admission precedence for an episode: a readable transcript only re-requests a stale index;
one in flight writes nothing; otherwise the episode's one job row is reset and a source
attempt is enqueued. The run prefers the publisher's rss sidecar, else Deepgram. Failure
raises to the source-attempt owner, which publishes it (transcription_failure.py).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session, sessionmaker

from nexus.auth.permissions import can_read_media
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas import podcast as wire
from nexus.schemas.media import TranscriptCoverage, TranscriptRequestOut, TranscriptState
from nexus.schemas.media import TranscriptRequestReason as RequestReason
from nexus.schemas.media_summary import MediaProcessingStatus
from nexus.services.content_indexing import request_stale_media_content_reindex
from nexus.services.rss_transcript_fetch import fetch_rss_transcript
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import publish_source_transcript, write_current_transcript
from nexus.services.transcripts.request_reason import (
    TranscriptRequestReason,
    require_transcript_request_reason,
)
from nexus.services.transcripts.state import (
    TranscriptOrigin,
    ensure_media_transcript_state_row,
    set_media_transcript_state,
)
from nexus.services.youtube import fetch_youtube_transcript

from .episodes import selection_fingerprint, selection_ids


@dataclass(frozen=True)
class PodcastTranscriptionCompleted:
    segment_count: int
    status: Literal["completed"] = "completed"


def _out(
    media_id: UUID,
    processing: MediaProcessingStatus,
    state: TranscriptState,
    coverage: TranscriptCoverage,
    reason: RequestReason,
    queued: bool = False,
) -> TranscriptRequestOut:
    return TranscriptRequestOut(
        media_id=str(media_id),
        processing_status=processing,
        transcript_state=state,
        transcript_coverage=coverage,
        request_reason=reason,
        request_enqueued=queued,
    )


def request_transcript(
    db: Session, viewer_id: UUID, media_id: UUID, *, reason: RequestReason
) -> TranscriptRequestOut:
    """One explicit request: episodes are admitted, YouTube videos import their captions."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = db.execute(
        text("SELECT kind, provider, provider_id FROM media WHERE id = :id"), {"id": media_id}
    ).one()
    if media.kind == "video":
        return _import_youtube_captions(db, media_id, media, reason)
    if media.kind != "podcast_episode":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Transcript request is only supported for podcast episodes.",
        )
    with transaction(db):
        return _admit(db, viewer_id, media_id, reason)


def forecast(
    db: Session, viewer_id: UUID, target: wire.PodcastEpisodeQueryTranscriptTarget
) -> wire.PodcastEpisodeQueryTranscriptForecastOut:
    """How many episodes "transcribe all ⟨state⟩" would queue, and the selection's name."""
    ids = selection_ids(
        db, viewer_id, target.podcast_id, target.selection.state, transcribable=True
    )
    return wire.PodcastEpisodeQueryTranscriptForecastOut(
        eligible_count=len(ids), selection_fingerprint=selection_fingerprint(ids)
    )


def request_batch(
    db: Session, viewer_id: UUID, body: wire.PodcastEpisodeQueryTranscriptRequest
) -> wire.PodcastEpisodeQueryTranscriptRequestOut:
    """Queue the whole forecast selection or nothing: a moved selection is 409."""
    target = body.target
    with transaction(db):
        ids = selection_ids(
            db, viewer_id, target.podcast_id, target.selection.state, transcribable=True
        )
        if selection_fingerprint(ids) != body.selection_fingerprint:
            raise ConflictError(
                ApiErrorCode.E_SELECTION_CHANGED, "Episode selection changed before the request"
            )
        queued = sum(
            _admit(db, viewer_id, media_id, target.reason).request_enqueued for media_id in ids
        )
        return wire.PodcastEpisodeQueryTranscriptRequestOut(
            matched_count=len(ids), queued_count=queued
        )


def _admit(
    db: Session, viewer_id: UUID, media_id: UUID, reason: RequestReason
) -> TranscriptRequestOut:
    from nexus.services.media_source_ingest import (
        enqueue_podcast_episode_transcript_source_attempt,
    )

    row = db.execute(
        text("""
            SELECT j.status, s.transcript_state, s.transcript_coverage
            FROM media m
            LEFT JOIN podcast_transcription_jobs j ON j.media_id = m.id
            LEFT JOIN media_transcript_states s ON s.media_id = m.id
            WHERE m.id = :id FOR NO KEY UPDATE OF m
        """),
        {"id": media_id},
    ).one()
    now = datetime.now(UTC)
    readable = row.transcript_state in ("ready", "partial")
    if readable and row.transcript_coverage in ("partial", "full"):
        queued = request_stale_media_content_reindex(db, media_id=media_id, reason="reconciliation")
        return _out(
            media_id,
            "ready_for_reading",
            row.transcript_state,
            row.transcript_coverage,
            reason,
            queued=queued,
        )
    if row.transcript_state in ("queued", "running") or row.status in ("pending", "running"):
        state = row.transcript_state or "queued"
        coverage = row.transcript_coverage or "none"
        return _out(media_id, "extracting", state, coverage, reason)
    ensure_media_transcript_state_row(db, media_id=media_id, now=now, request_reason=reason)
    reset_podcast_transcription_job(db, media_id=media_id, request_reason=reason)
    _set_state(db, media_id, "queued", reason)
    enqueue_podcast_episode_transcript_source_attempt(
        db=db, media_id=media_id, viewer_id=viewer_id, request_reason=reason, request_id=None
    )
    return _out(media_id, "extracting", "queued", "none", reason, queued=True)


def _set_state(db: Session, media_id: UUID, state: str, reason: str) -> None:
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=state,
        transcript_coverage="none",
        last_request_reason=reason,
        last_error_code=None,
        now=datetime.now(UTC),
    )


def reset_podcast_transcription_job(
    db: Session, *, media_id: UUID, request_reason: TranscriptRequestReason
) -> None:
    """The episode's one job row back to pending; the caller holds the media row lock,
    which is what keeps at most one queued job per episode."""
    db.execute(
        text("""
            INSERT INTO podcast_transcription_jobs (media_id, request_reason, status)
            VALUES (:media_id, :reason, 'pending')
            ON CONFLICT (media_id) DO UPDATE
            SET request_reason = EXCLUDED.request_reason, status = 'pending', error_code = NULL,
                started_at = NULL, completed_at = NULL, updated_at = now()
        """),
        {"media_id": media_id, "reason": request_reason},
    )


def run_podcast_transcription_now(
    session_factory: sessionmaker[Session],
    *,
    media_id: UUID,
    publication_fence: SourcePublicationFence,
) -> PodcastTranscriptionCompleted:
    """One source attempt: the publisher's sidecar if it yields text, else Deepgram in the
    episode's language. Failure raises; the source-attempt owner publishes it."""
    from .deepgram_adapter import get_deepgram_client

    with session_factory() as db:
        job = db.execute(
            text("""
                SELECT e.rss_transcript_url, e.duration_seconds, j.request_reason,
                       m.external_playback_url, m.language
                FROM podcast_episodes e
                JOIN podcast_transcription_jobs j ON j.media_id = e.media_id
                JOIN media m ON m.id = e.media_id
                WHERE e.media_id = :id
            """),
            {"id": media_id},
        ).one()
    reason = require_transcript_request_reason(job.request_reason)
    duration_ms = None if job.duration_seconds is None else job.duration_seconds * 1000
    segments = (
        normalize_transcript_segments(
            fetch_rss_transcript(job.rss_transcript_url, episode_duration_ms=duration_ms)
        )
        if job.rss_transcript_url
        else []
    )
    origin: TranscriptOrigin = "Publisher"
    diagnostic = None
    if not segments:
        origin = "Generated"
        run_source_publication_phase(
            session_factory=session_factory,
            label="publish_podcast_transcription_running",
            fence=publication_fence,
            media_ids=(media_id,),
            mutate=lambda db, _: _mark_running(db, media_id, reason),
        )
        raw, diagnostic = get_deepgram_client().transcribe(job.external_playback_url, job.language)
        segments = normalize_transcript_segments(raw)
        if not segments:
            raise ApiError(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE, "Transcript unavailable")
    now = datetime.now(UTC)

    def publish(db: Session, _attempt: object) -> None:
        publish_source_transcript(
            db,
            media_id=media_id,
            request_reason=reason,
            transcript_coverage="full",
            transcript_segments=segments,
            transcript_origin=origin,
            now=now,
        )
        db.execute(
            text("""
                UPDATE podcast_transcription_jobs
                SET status = 'completed', error_code = :diagnostic, completed_at = now(),
                    started_at = COALESCE(started_at, now()), updated_at = now(),
                    attempts = attempts + CASE WHEN :publisher THEN 1 ELSE 0 END
                WHERE media_id = :id
            """),
            {"id": media_id, "diagnostic": diagnostic, "publisher": origin == "Publisher"},
        )

    run_source_publication_phase(
        session_factory=session_factory,
        label="publish_podcast_transcript",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish,
    )
    return PodcastTranscriptionCompleted(segment_count=len(segments))


def _mark_running(db: Session, media_id: UUID, reason: str) -> None:
    db.execute(
        text("""
            UPDATE podcast_transcription_jobs
            SET status = 'running', error_code = NULL, attempts = attempts + 1,
                started_at = now(), completed_at = NULL, updated_at = now()
            WHERE media_id = :id
        """),
        {"id": media_id},
    )
    _set_state(db, media_id, "running", reason)


def _import_youtube_captions(
    db: Session, media_id: UUID, media: Row, reason: RequestReason
) -> TranscriptRequestOut:
    """A YouTube video's published captions become its current transcript."""
    if media.provider != "youtube" or media.provider_id is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_KIND,
            "Explicit imported captions require canonical YouTube Media.",
        )
    db.rollback()  # no transaction open across the provider call
    captions = fetch_youtube_transcript(str(media.provider_id))
    segments = normalize_transcript_segments(captions.get("segments"))
    if captions.get("status") != "completed" or not segments:
        raise ApiError(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE, "YouTube captions are unavailable")
    with transaction(db):
        write_current_transcript(
            db,
            media_id=media_id,
            request_reason=reason,
            transcript_coverage="full",
            transcript_segments=segments,
            transcript_origin="Imported",
            now=datetime.now(UTC),
        )
    return _out(media_id, "ready_for_reading", "ready", "full", reason)
