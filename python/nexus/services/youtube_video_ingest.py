"""YouTube video transcript materialization service."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.transcript_segments import normalize_transcript_segments
from nexus.services.transcripts.current import (
    set_media_transcript_state,
    write_current_transcript,
)
from nexus.services.youtube_identity import classify_youtube_url
from nexus.services.youtube_transcripts import fetch_youtube_transcript

logger = get_logger(__name__)


def run_youtube_video_ingest(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
    mark_media_ready: bool = True,
    dispatch_metadata_enrichment: bool = True,
) -> dict[str, Any]:
    """Materialize one accepted YouTube source attempt."""
    media = db.get(Media, media_id)
    if media is None:
        return {"status": "skipped", "reason": "media_not_found"}

    if media.processing_status == ProcessingStatus.ready_for_reading:
        ready_row = db.execute(
            text(
                """
                SELECT
                    EXISTS(SELECT 1 FROM fragments WHERE media_id = :media_id),
                    mcis.status
                FROM media m
                LEFT JOIN content_index_states mcis
                  ON mcis.owner_kind = 'media' AND mcis.owner_id = m.id
                WHERE m.id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        if ready_row is not None and ready_row[0] and ready_row[1] == "ready":
            return {"status": "skipped", "reason": "already_ready"}

    now = datetime.now(UTC)
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state="running",
        transcript_coverage="none",
        semantic_status="pending",
        last_request_reason="episode_open",
        last_error_code=None,
        now=now,
    )
    db.commit()

    media = db.get(Media, media_id)
    if media is None:
        return {"status": "skipped", "reason": "media_not_found_after_extracting"}
    if media.kind != MediaKind.video.value:
        error_message = "YouTube ingest only supports kind=video"
        _mark_transcript_failed(
            db,
            media_id,
            ApiErrorCode.E_INGEST_FAILED.value,
            error_message,
        )
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, error_message)

    provider_video_id, watch_url = _resolve_provider_identity(media)
    if provider_video_id is None:
        error_message = "Missing canonical YouTube provider identity"
        _mark_transcript_failed(
            db,
            media_id,
            ApiErrorCode.E_INGEST_FAILED.value,
            error_message,
        )
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, error_message)

    metadata = fetch_youtube_metadata(provider_video_id)
    if metadata is not None:
        _persist_youtube_metadata(db, media_id, metadata)

    try:
        transcript_result = fetch_youtube_transcript(provider_video_id)
        transcript_status = str(transcript_result.get("status") or "failed")
        transcript_segments = normalize_transcript_segments(transcript_result.get("segments"))
        error_code = _normalize_terminal_error_code(transcript_result.get("error_code"))
        error_message = str(transcript_result.get("error_message") or "").strip()

        if transcript_status == "completed" and transcript_segments:
            now = datetime.now(UTC)
            write_current_transcript(
                db,
                media_id=media_id,
                request_reason="episode_open",
                transcript_coverage="full",
                transcript_segments=transcript_segments,
                mark_media_ready=mark_media_ready,
                now=now,
            )
            media = db.get(Media, media_id)
            if media is None:
                return {"status": "skipped", "reason": "media_deleted_during_ingest"}
            media.provider = "youtube"
            media.provider_id = provider_video_id
            if watch_url is not None:
                media.canonical_url = watch_url
                media.canonical_source_url = watch_url
                media.external_playback_url = watch_url
            media.updated_at = now
            db.commit()
            logger.info(
                "youtube_video_ingest_success",
                media_id=str(media_id),
                actor_user_id=str(actor_user_id),
                request_id=request_id,
                segment_count=len(transcript_segments),
            )
            if dispatch_metadata_enrichment:
                from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment

                if try_enqueue_metadata_enrichment(
                    db,
                    media_id=media_id,
                    request_id=request_id,
                ):
                    db.commit()
            return {
                "status": "success",
                "segment_count": len(transcript_segments),
                "provider_fixture": transcript_result.get("provider_fixture"),
                "metadata_enrichment": not dispatch_metadata_enrichment,
            }

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

        _mark_transcript_failed(db, media_id, error_code, error_message)
        logger.info(
            "youtube_video_ingest_failed",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error_code=error_code,
        )
        raise ApiError(_source_api_error_code(error_code), error_message)
    except Exception as exc:
        if isinstance(exc, ApiError):
            raise
        logger.exception(
            "youtube_video_ingest_unhandled_error",
            media_id=str(media_id),
            actor_user_id=str(actor_user_id),
            request_id=request_id,
            error=str(exc),
        )
        db.rollback()
        error_code = ApiErrorCode.E_TRANSCRIPTION_FAILED.value
        error_message = "Transcription failed"
        _mark_transcript_failed(db, media_id, error_code, error_message)
        raise ApiError(ApiErrorCode.E_TRANSCRIPTION_FAILED, error_message) from exc


def fetch_youtube_metadata(provider_video_id: str) -> dict[str, str] | None:
    settings = get_settings()
    if settings.real_media_provider_fixtures:
        if provider_video_id == "drrP_Iss0gA":
            return {
                "title": "Picturing Earth: Behind the Scenes",
                "description": "NASA Earth Observatory video transcript fixture.",
                "author": "NASA Earth Observatory",
                "published_date": "2020-04-22T00:00:00Z",
                "language": "en",
            }
        return None

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
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "youtube_metadata_fetch_failed",
            provider_video_id=provider_video_id,
            error_type=type(exc).__name__,
            status_code=exc.response.status_code,
        )
        return None
    except Exception as exc:
        logger.warning(
            "youtube_metadata_fetch_failed",
            provider_video_id=provider_video_id,
            error_type=type(exc).__name__,
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
    if author and not media.publisher:
        media.publisher = author[:255]
    replace_media_contributor_credits(
        db,
        media_id=media_id,
        source="youtube_metadata",
        credits=[
            {
                "name": author[:255],
                "role": "author",
                "ordinal": 0,
                "source": "youtube_metadata",
            }
        ]
        if author
        else [],
    )

    media.updated_at = datetime.now(UTC)


def _mark_transcript_failed(db: Session, media_id: UUID, error_code: str, message: str) -> None:
    now = datetime.now(UTC)
    transcript_state = (
        "unavailable"
        if error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
        else "failed_provider"
    )
    set_media_transcript_state(
        db,
        media_id=media_id,
        transcript_state=transcript_state,
        transcript_coverage="none",
        semantic_status="failed",
        last_request_reason="episode_open",
        last_error_code=error_code,
        now=now,
    )
    db.commit()


def _source_api_error_code(error_code: str | None) -> ApiErrorCode:
    try:
        return ApiErrorCode(str(error_code or ""))
    except ValueError:
        return ApiErrorCode.E_TRANSCRIPTION_FAILED
