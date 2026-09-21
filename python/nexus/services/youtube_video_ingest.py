"""YouTube video acquisition: Data API metadata plus the playable-media publication.

No transcript work happens here; captions materialize only through the separate
explicit Transcribe command.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import get_settings
from nexus.db.models import Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.presence import Present
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    RawIdentityClaim,
    build_observation,
)
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.youtube_identity import YouTubeIdentity

logger = get_logger(__name__)


def run_youtube_video_ingest(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
    *,
    identity: YouTubeIdentity,
    publication_fence: SourcePublicationFence,
) -> dict[str, Any]:
    """Fetch metadata outside any transaction, then publish playable media once."""
    metadata = fetch_youtube_metadata(identity.provider_video_id)

    def publish(db: Session, _attempt: object) -> ContributorObservationBatch:
        media = db.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        media.provider = identity.provider
        media.provider_id = identity.provider_video_id
        media.canonical_url = identity.watch_url
        media.canonical_source_url = identity.watch_url
        media.external_playback_url = identity.watch_url
        media.updated_at = datetime.now(UTC)
        return NOT_OBSERVED if metadata is None else _persist_metadata(db, media, metadata)

    observation = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_youtube_playable_media",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish,
    )
    logger.info(
        "youtube_video_ingest_success",
        media_id=str(media_id),
        actor_user_id=str(actor_user_id),
        request_id=request_id,
    )
    result: dict[str, Any] = {"status": "success", "metadata_enrichment": metadata is not None}
    attach_author_observation(result, observation=observation, source="youtube_metadata")
    return result


def fetch_youtube_metadata(provider_video_id: str) -> dict[str, str] | None:
    """The video's snippet fields, or ``None`` when the API is unset or unhelpful."""
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
        payload = response.json()
    # justify-ignore-error: metadata is an optional enrichment; any provider or
    # decode failure degrades to "no metadata", never to a failed ingest.
    except Exception as exc:
        logger.warning(
            "youtube_metadata_fetch_failed",
            provider_video_id=provider_video_id,
            error_type=type(exc).__name__,
        )
        return None

    items = payload.get("items") if isinstance(payload, dict) else None
    snippet = items[0].get("snippet") if isinstance(items, list) and items else None
    if not isinstance(snippet, dict):
        return None
    fields = {
        "title": snippet.get("title"),
        "description": snippet.get("description"),
        "author": snippet.get("channelTitle"),
        # channelId is already in this response: the exact author identity key.
        "channel_id": snippet.get("channelId"),
        "published_at": snippet.get("publishedAt"),
        "language": snippet.get("defaultAudioLanguage") or snippet.get("defaultLanguage"),
    }
    metadata = {
        key: str(value).strip() for key, value in fields.items() if str(value or "").strip()
    }
    return metadata or None


def _persist_metadata(
    db: Session, media: Media, metadata: dict[str, str]
) -> ContributorObservationBatch:
    """Fill the empty metadata fields and return the channel author observation."""
    title = metadata.get("title")
    if title and str(media.title or "").startswith("YouTube Video "):
        media.title = title[:255]
    description = metadata.get("description")
    if description and not media.description:
        media.description = description[:2000]
    edition_date = normalize_source_publication_date(metadata.get("published_at"))
    if isinstance(edition_date, Present):
        media.edition_published_date = edition_date.value
    language = metadata.get("language")
    if language and not media.language:
        media.language = language[:32]
    channel_title = metadata.get("author")
    if channel_title and not media.publisher:
        media.publisher = channel_title[:255]
    media.updated_at = datetime.now(UTC)
    bump_all_collection_families(
        db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
    )
    if not channel_title:
        return NOT_OBSERVED
    channel_id = metadata.get("channel_id")
    claims = (RawIdentityClaim("youtube_channel", channel_id),) if channel_id else ()
    batch, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=channel_title, identity_claims=claims)]}
    )
    if truncated:
        logger.info("youtube_author_truncated", truncated=truncated)
    return batch
