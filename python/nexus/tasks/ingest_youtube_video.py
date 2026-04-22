"""Worker job handler for YouTube video transcript ingestion."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import FailureStage, Media, MediaAuthor, MediaKind, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import enqueue_job
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
    _upsert_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="running",
        transcript_coverage="none",
        last_error_code=None,
        now=now,
    )
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

    metadata = _fetch_youtube_metadata(provider_video_id)
    if metadata is not None:
        _persist_youtube_metadata(db, media_id, metadata)

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
            _upsert_media_transcript_state(
                db,
                media_id=media_id,
                transcript_state="ready",
                transcript_coverage="full",
                last_error_code=None,
                now=now,
            )
            db.commit()
            logger.info(
                "ingest_youtube_video_success",
                media_id=str(media_id),
                actor_user_id=str(actor_user_id),
                request_id=request_id,
                segment_count=len(transcript_segments),
            )
            _try_enrich_dispatch(str(media_id), request_id)
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
        _try_enrich_dispatch(str(media_id), request_id)
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
        _try_enrich_dispatch(str(media_id), request_id)
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


def _fetch_youtube_metadata(provider_video_id: str) -> dict[str, str] | None:
    settings = get_settings()
    if not settings.youtube_data_api_key:
        return None

    try:
        response = httpx.get(
            f"{settings.youtube_data_base_url.rstrip('/')}/videos",
            params={
                "key": settings.youtube_data_api_key,
                "part": "snippet",
                "id": provider_video_id,
                "maxResults": 1,
            },
            headers={"Accept": "application/json"},
            timeout=15,
        )
        response.raise_for_status()
    except Exception as exc:
        logger.warning(
            "youtube_metadata_fetch_failed",
            provider_video_id=provider_video_id,
            error=str(exc),
        )
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return None
    first_item = items[0]
    if not isinstance(first_item, dict):
        return None
    snippet = first_item.get("snippet")
    if not isinstance(snippet, dict):
        return None

    metadata: dict[str, str] = {}
    title = str(snippet.get("title") or "").strip()
    if title:
        metadata["title"] = title
    description = str(snippet.get("description") or "").strip()
    if description:
        metadata["description"] = description
    channel_title = str(snippet.get("channelTitle") or "").strip()
    if channel_title:
        metadata["author"] = channel_title
    published_at = str(snippet.get("publishedAt") or "").strip()
    if published_at:
        metadata["published_date"] = published_at
    language = str(
        snippet.get("defaultAudioLanguage") or snippet.get("defaultLanguage") or ""
    ).strip()
    if language:
        metadata["language"] = language
    return metadata or None


def _persist_youtube_metadata(db: Session, media_id: UUID, metadata: dict[str, str]) -> None:
    media = db.get(Media, media_id)
    if media is None:
        return

    title = metadata.get("title")
    if title and str(media.title or "").startswith("YouTube Video "):
        media.title = title[:255]

    description = metadata.get("description")
    if description and not media.description:
        media.description = description[:2000]

    published_date = metadata.get("published_date")
    if published_date and not media.published_date:
        media.published_date = published_date[:64]

    language = metadata.get("language")
    if language and not media.language:
        media.language = language[:32]

    author = metadata.get("author")
    if author:
        if not media.publisher:
            media.publisher = author[:255]
        db.execute(
            text("DELETE FROM media_authors WHERE media_id = :media_id"),
            {"media_id": media_id},
        )
        db.add(
            MediaAuthor(
                media_id=media_id,
                name=author[:255],
                role="author",
                sort_order=0,
            )
        )

    media.updated_at = datetime.now(UTC)


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
    transcript_state = (
        "unavailable"
        if error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
        else "failed_provider"
    )
    _upsert_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=transcript_state,
        transcript_coverage="none",
        last_error_code=error_code,
        now=now,
    )
    db.commit()


def _upsert_media_transcript_state(
    db: Session,
    *,
    media_id: UUID,
    transcript_state: str,
    transcript_coverage: str,
    last_error_code: str | None,
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
                'none',
                NULL,
                NULL,
                :last_error_code,
                :created_at,
                :updated_at
            )
            ON CONFLICT (media_id) DO UPDATE
            SET
                transcript_state = EXCLUDED.transcript_state,
                transcript_coverage = EXCLUDED.transcript_coverage,
                semantic_status = 'none',
                active_transcript_version_id = NULL,
                last_request_reason = NULL,
                last_error_code = EXCLUDED.last_error_code,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "media_id": media_id,
            "transcript_state": transcript_state,
            "transcript_coverage": transcript_coverage,
            "last_error_code": last_error_code,
            "created_at": now,
            "updated_at": now,
        },
    )


def _try_enrich_dispatch(media_id: str, request_id: str | None) -> None:
    session_factory = get_session_factory()
    db = session_factory()
    try:
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload={"media_id": media_id, "request_id": request_id},
            max_attempts=1,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)
    finally:
        db.close()


def _fetch_youtube_transcript(provider_video_id: str) -> dict[str, Any]:
    return fetch_youtube_transcript(provider_video_id)
