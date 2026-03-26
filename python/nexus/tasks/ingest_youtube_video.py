"""Worker job handler for YouTube video transcript ingestion."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, MediaKind, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.transcript_segments import (
    insert_transcript_fragments,
    normalize_transcript_segments,
)
from nexus.services.youtube_identity import classify_youtube_url
from nexus.services.youtube_transcripts import fetch_youtube_transcript

logger = get_logger(__name__)


def ingest_youtube_video(
    media_id: str,
    actor_user_id: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Ingest YouTube transcript asynchronously for one media row."""
    media_uuid = UUID(media_id)
    actor_uuid = UUID(actor_user_id)
    session_factory = get_session_factory()
    db = session_factory()

    try:
        return _do_ingest(db, media_uuid, actor_uuid, request_id=request_id)
    finally:
        db.close()


def run_ingest_sync(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Run YouTube ingest synchronously (tests/dev)."""
    return _do_ingest(db, media_id, actor_user_id, request_id=request_id)


def _do_ingest(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
) -> dict[str, Any]:
    media = db.get(Media, media_id)
    if media is None:
        return {"status": "skipped", "reason": "media_not_found"}

    if media.processing_status == ProcessingStatus.ready_for_reading:
        fragment_exists = db.execute(
            text("SELECT EXISTS(SELECT 1 FROM fragments WHERE media_id = :media_id)"),
            {"media_id": media_id},
        ).scalar()
        if fragment_exists:
            return {"status": "skipped", "reason": "already_ready"}

    now = datetime.now(UTC)
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_status = ProcessingStatus.extracting
    media.processing_started_at = now
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.updated_at = now
    db.commit()

    media = db.get(Media, media_id)
    if media is None:
        return {"status": "skipped", "reason": "media_not_found_after_extracting"}
    if media.kind != MediaKind.video.value:
        _mark_failed(
            db,
            media_id,
            ApiErrorCode.E_INGEST_FAILED.value,
            "YouTube ingest only supports kind=video",
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INGEST_FAILED.value}

    provider_video_id, watch_url = _resolve_provider_identity(media)
    if provider_video_id is None:
        _mark_failed(
            db,
            media_id,
            ApiErrorCode.E_INGEST_FAILED.value,
            "Missing canonical YouTube provider identity",
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INGEST_FAILED.value}

    try:
        transcript_result = _fetch_youtube_transcript(provider_video_id)
        transcript_status = str(transcript_result.get("status") or "failed")
        transcript_segments = normalize_transcript_segments(transcript_result.get("segments"))
        error_code = _normalize_terminal_error_code(transcript_result.get("error_code"))
        error_message = str(transcript_result.get("error_message") or "").strip()

        if transcript_status == "completed" and transcript_segments:
            now = datetime.now(UTC)
            db.execute(
                text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id}
            )
            insert_transcript_fragments(db, media_id, transcript_segments, now=now)

            media = db.get(Media, media_id)
            if media is None:
                return {"status": "skipped", "reason": "media_deleted_during_ingest"}
            media.processing_status = ProcessingStatus.ready_for_reading
            media.failure_stage = None
            media.last_error_code = None
            media.last_error_message = None
            media.processing_completed_at = now
            media.updated_at = now
            media.failed_at = None
            media.provider = "youtube"
            media.provider_id = provider_video_id
            if watch_url is not None:
                media.canonical_url = watch_url
                media.canonical_source_url = watch_url
                media.external_playback_url = watch_url
            db.commit()
            logger.info(
                "ingest_youtube_video_success",
                media_id=str(media_id),
                actor_user_id=str(actor_user_id),
                request_id=request_id,
                segment_count=len(transcript_segments),
            )
            return {"status": "success", "segment_count": len(transcript_segments)}

        if transcript_status == "completed" and not transcript_segments:
            error_code = ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
            if not error_message:
                error_message = "Transcript unavailable"

        if error_code is None:
            error_code = ApiErrorCode.E_TRANSCRIPTION_FAILED.value
        if not error_message:
            error_message = (
                "Transcript unavailable"
                if error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
                else "Transcription failed"
            )

        _mark_failed(db, media_id, error_code, error_message)
        logger.info(
            "ingest_youtube_video_failed",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error_code=error_code,
        )
        return {"status": "failed", "error_code": error_code}
    except Exception as exc:
        logger.exception(
            "ingest_youtube_video_unhandled_error",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error=str(exc),
        )
        error_code = ApiErrorCode.E_TRANSCRIPTION_FAILED.value
        _mark_failed(db, media_id, error_code, "Transcription failed")
        return {"status": "failed", "error_code": error_code}


def _resolve_provider_identity(media: Media) -> tuple[str | None, str | None]:
    provider_video_id = str(media.provider_id or "").strip() or None
    if provider_video_id:
        identity = classify_youtube_url(f"https://www.youtube.com/watch?v={provider_video_id}")
        if identity is not None:
            return identity.provider_video_id, identity.watch_url

    identity = classify_youtube_url(
        str(media.canonical_url or media.canonical_source_url or media.requested_url or "").strip()
    )
    if identity is None:
        return None, None
    return identity.provider_video_id, identity.watch_url


def _normalize_terminal_error_code(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    allowed = {
        ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
        ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
        ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
    }
    if value in allowed:
        return value
    return ApiErrorCode.E_TRANSCRIPTION_FAILED.value


def _mark_failed(db: Session, media_id: UUID, error_code: str, message: str) -> None:
    now = datetime.now(UTC)
    db.execute(
        text(
            """
            UPDATE media
            SET
                processing_status = :processing_status,
                failure_stage = :failure_stage,
                last_error_code = :last_error_code,
                last_error_message = :last_error_message,
                processing_completed_at = NULL,
                failed_at = :failed_at,
                updated_at = :updated_at
            WHERE id = :media_id
            """
        ),
        {
            "processing_status": ProcessingStatus.failed.value,
            "failure_stage": FailureStage.transcribe.value,
            "last_error_code": error_code,
            "last_error_message": message[:1000],
            "failed_at": now,
            "updated_at": now,
            "media_id": media_id,
        },
    )
    db.commit()


def _fetch_youtube_transcript(provider_video_id: str) -> dict[str, Any]:
    return fetch_youtube_transcript(provider_video_id)
