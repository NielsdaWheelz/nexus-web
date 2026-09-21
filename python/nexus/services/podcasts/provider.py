"""Podcast Index HTTP client and provider episode parsing."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

from nexus.coerce import coerce_positive_int
from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.net.http_retry import get_json_with_retry

from ._normalize import normalize_optional_text, normalize_provider_published_at

PODCAST_PROVIDER = "podcast_index"
PODCAST_INDEX_EPISODE_PAGE_SIZE = 100
_BACKOFF_SECONDS = (0.25, 0.5)


class PodcastIndexClient:
    """Thin HTTP client for Podcast Index discovery and episode metadata."""

    def __init__(self, *, api_key: str | None, api_secret: str | None, base_url: str):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")

    def _get_json(self, path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        if not self.api_key or not self.api_secret:
            raise ApiError(
                ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
                "Podcast provider credentials are not configured",
            )
        now_epoch = str(int(datetime.now(UTC).timestamp()))
        digest = hashlib.sha1(f"{self.api_key}{self.api_secret}{now_epoch}".encode()).hexdigest()
        return get_json_with_retry(
            f"{self.base_url}{path}",
            headers={
                "X-Auth-Date": now_epoch,
                "X-Auth-Key": self.api_key,
                "Authorization": digest,
                "User-Agent": "nexus-podcast-client/1.0",
            },
            params=params,
            timeout_s=15.0,
            backoff_seconds=_BACKOFF_SECONDS,
            error_code=ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            provider_name=PODCAST_PROVIDER,
            honor_retry_after=True,
        )

    def browse_search_payload(self, query: str, limit: int) -> dict[str, Any]:
        """Return the provider payload for Browse's strict adapter to parse."""
        return self._get_json("/search/byterm", params={"q": query, "max": max(1, min(limit, 100))})

    def browse_podcast_payload(self, podcast_ref: str) -> dict[str, Any]:
        """Return one Podcast Index feed payload without domain parsing."""
        return self._get_json("/podcasts/byfeedid", params={"id": podcast_ref})

    def browse_episode_page_payload(
        self,
        podcast_ref: str,
        limit: int,
        before_published: int | None,
    ) -> dict[str, Any]:
        """Return a provider episode page without domain parsing."""
        params: dict[str, Any] = {
            "id": podcast_ref,
            "max": max(1, min(limit, PODCAST_INDEX_EPISODE_PAGE_SIZE)),
        }
        if before_published is not None:
            params["before"] = before_published
        return self._get_json("/episodes/byfeedid", params=params)

    def browse_episode_payload(self, episode_ref: str) -> dict[str, Any]:
        """Return one Podcast Index episode payload without domain parsing."""
        return self._get_json("/episodes/byid", params={"id": episode_ref})

    def fetch_recent_episodes(self, provider_podcast_id: str, limit: int) -> list[dict[str, Any]]:
        """Return the provider's recent-episode window as episode dicts."""
        capped = max(1, min(limit, PODCAST_INDEX_EPISODE_PAGE_SIZE))
        payload = self._get_json(
            "/episodes/byfeedid",
            params={"id": provider_podcast_id, "max": capped},
        )
        items = payload.get("items")
        if not isinstance(items, list):
            return []

        episodes: list[dict[str, Any]] = []
        for item in items[:capped]:
            if not isinstance(item, dict):
                continue
            author = normalize_optional_text(item.get("author"))
            audio_url = normalize_optional_text(
                item.get("enclosureUrl") or item.get("enclosure_url") or item.get("url")
            )
            episodes.append(
                {
                    "podcast_index_episode_ref": normalize_optional_text(item.get("id")),
                    "guid": normalize_optional_text(item.get("guid")),
                    "title": str(item.get("title") or "Untitled Episode"),
                    "authors": [author] if author else None,
                    "audio_url": audio_url or "",
                    "published_at": normalize_provider_published_at(item.get("datePublished")),
                    "duration_seconds": coerce_positive_int(item.get("duration")),
                    "rss_transcript_url": None,
                    "language": None,
                    "feed_language": None,
                }
            )
        return episodes


def get_podcast_index_client() -> PodcastIndexClient:
    settings = get_settings()
    return PodcastIndexClient(
        api_key=settings.podcast_index_api_key,
        api_secret=settings.podcast_index_api_secret,
        base_url=settings.podcast_index_base_url,
    )
