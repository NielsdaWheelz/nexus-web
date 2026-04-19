"""Global acquisition browse service."""

from __future__ import annotations

from typing import Literal

from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services import podcasts as podcast_service

BrowseType = Literal["all", "podcasts", "podcast_episodes", "videos", "documents"]

MAX_BROWSE_LIMIT = 50
EPISODE_PREFETCH_PODCAST_LIMIT = 3
EPISODES_PER_PODCAST_LIMIT = 3


def browse_content(
    db: Session,
    query: str,
    *,
    result_type: BrowseType = "all",
    limit: int = 20,
    cursor: str | None = None,
) -> dict[str, object]:
    """Return explicit browse results for acquisition surfaces."""
    trimmed_query = query.strip()
    if not trimmed_query:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Query must not be empty")
    if limit <= 0 or limit > MAX_BROWSE_LIMIT:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid browse limit")
    if result_type not in {"all", "podcasts", "podcast_episodes", "videos", "documents"}:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid browse type")

    if cursor:
        return {
            "results": [],
            "page": {"has_more": False, "next_cursor": None},
        }

    podcast_rows = []
    if result_type in {"all", "podcasts", "podcast_episodes"}:
        podcast_rows = podcast_service.discover_podcasts(db, trimmed_query, limit=limit)
    results: list[dict[str, object]] = []

    if result_type in {"all", "podcasts"}:
        for podcast in podcast_rows:
            if len(results) >= limit:
                break
            results.append(
                {
                    "type": "podcasts",
                    "podcast_id": str(podcast.podcast_id)
                    if podcast.podcast_id is not None
                    else None,
                    "provider_podcast_id": podcast.provider_podcast_id,
                    "title": podcast.title,
                    "author": podcast.author,
                    "feed_url": podcast.feed_url,
                    "website_url": podcast.website_url,
                    "image_url": podcast.image_url,
                    "description": podcast.description,
                }
            )

    if result_type in {"all", "podcast_episodes"} and len(results) < limit:
        remaining = limit - len(results)
        client = podcast_service.get_podcast_index_client()
        for podcast in podcast_rows[:EPISODE_PREFETCH_PODCAST_LIMIT]:
            if remaining <= 0:
                break
            episode_rows = client.fetch_recent_episodes(
                podcast.provider_podcast_id,
                min(remaining, EPISODES_PER_PODCAST_LIMIT),
            )
            for episode in episode_rows:
                results.append(
                    {
                        "type": "podcast_episodes",
                        "podcast_id": str(podcast.podcast_id)
                        if podcast.podcast_id is not None
                        else None,
                        "provider_podcast_id": podcast.provider_podcast_id,
                        "provider_episode_id": episode["provider_episode_id"],
                        "podcast_title": podcast.title,
                        "podcast_author": podcast.author,
                        "podcast_image_url": podcast.image_url,
                        "title": episode["title"],
                        "audio_url": episode["audio_url"],
                        "published_at": episode["published_at"],
                        "duration_seconds": episode["duration_seconds"],
                        "feed_url": podcast.feed_url,
                        "website_url": podcast.website_url,
                        "description": podcast.description,
                    }
                )
                remaining -= 1
                if remaining <= 0:
                    break

    return {
        "results": results,
        "page": {"has_more": False, "next_cursor": None},
    }
