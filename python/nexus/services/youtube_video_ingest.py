"""YouTube video transcript materialization service."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import Media, MediaKind
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
)
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    RawIdentityClaim,
    build_observation,
)
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.source_publication import (
    SourcePublicationFence,
    run_source_publication_phase,
)
from nexus.services.youtube_identity import classify_youtube_url

logger = get_logger(__name__)


def run_youtube_video_ingest(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
    *,
    publication_fence: SourcePublicationFence,
) -> dict[str, Any]:
    """Materialize playable YouTube Media without implicit transcript work."""
    snapshot = session_factory()
    try:
        media = snapshot.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.kind != MediaKind.video.value:
            raise AssertionError("YouTube source media kind changed")
        provider_video_id, watch_url = _resolve_provider_identity(media)
        if provider_video_id is None:
            raise AssertionError("YouTube source has no canonical provider identity")
        snapshot.rollback()
    finally:
        snapshot.close()

    metadata = fetch_youtube_metadata(provider_video_id)

    def publish_playable_media(db: Session, _attempt: object) -> ContributorObservationBatch:
        now = datetime.now(UTC)
        media = db.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        observation: ContributorObservationBatch = NOT_OBSERVED
        if metadata is not None:
            observation = _persist_youtube_metadata(db, media_id, metadata)
        media.provider = "youtube"
        media.provider_id = provider_video_id
        if watch_url is not None:
            media.canonical_url = watch_url
            media.canonical_source_url = watch_url
            media.external_playback_url = watch_url
        media.updated_at = now
        return observation

    author_observation = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_youtube_playable_media",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish_playable_media,
    )
    logger.info(
        "youtube_video_ingest_success",
        media_id=str(media_id),
        actor_user_id=str(actor_user_id),
        request_id=request_id,
    )
    result: dict[str, Any] = {
        "status": "success",
        "metadata_enrichment": metadata is not None,
    }
    attach_author_observation(
        result,
        observation=author_observation,
        source="youtube_metadata",
    )
    return result


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
    # snippet.channelId is already in this response (no extra HTTP, spec 5); it
    # is the exact youtube_channel identity key for the author observation.
    channel_id = str(snippet.get("channelId") or "").strip()
    if channel_id:
        metadata["channel_id"] = channel_id
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


def _persist_youtube_metadata(
    db: Session, media_id: UUID, metadata: dict[str, str]
) -> ContributorObservationBatch:
    """Persist YouTube metadata fields and return the author observation.

    Credits are no longer written here; the caller runs the fresh-session author
    mutation after the source transaction commits. Absent channel title is
    ``not_observed`` (no erase).
    """
    media = db.get(Media, media_id)
    if media is None:
        return NOT_OBSERVED

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

    media.updated_at = datetime.now(UTC)
    bump_all_collection_families(
        db,
        families=(
            CollectionFamily.AuthorWorks,
            CollectionFamily.LibraryEntries,
        ),
    )
    return _build_youtube_observation(author, metadata.get("channel_id"))


def _build_youtube_observation(
    channel_title: str | None, channel_id: str | None
) -> ContributorObservationBatch:
    if not channel_title:
        return NOT_OBSERVED
    claims = (RawIdentityClaim("youtube_channel", channel_id),) if channel_id else ()
    batch, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=channel_title, identity_claims=claims)]}
    )
    if truncated:
        logger.info("youtube_author_truncated", truncated=truncated)
    return batch
