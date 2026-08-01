"""Podcast Index client and provider-owned parsing helpers."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

from nexus.coerce import coerce_positive_int
from nexus.config import get_settings
from nexus.errors import (
    ApiError,
    ApiErrorCode,
)
from nexus.logging import get_logger
from nexus.services.net.http_retry import get_json_with_retry

from ._normalize import normalize_provider_published_at

logger = get_logger(__name__)

PODCAST_PROVIDER = "podcast_index"
PODCAST_INDEX_EPISODE_PAGE_SIZE = 100
PODCAST_PROVIDER_MAX_ATTEMPTS = 3
PODCAST_PROVIDER_BACKOFF_SECONDS = (0.25, 0.5, 1.0)


class PodcastIndexClient:
    """Thin HTTP client for Podcast Index discovery + episode metadata."""

    def __init__(self, *, api_key: str | None, api_secret: str | None, base_url: str):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")

    def _auth_headers(self) -> dict[str, str]:
        if not self.api_key or not self.api_secret:
            raise ApiError(
                ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
                "Podcast provider credentials are not configured",
            )
        now_epoch = str(int(datetime.now(UTC).timestamp()))
        digest = hashlib.sha1(f"{self.api_key}{self.api_secret}{now_epoch}".encode()).hexdigest()
        return {
            "X-Auth-Date": now_epoch,
            "X-Auth-Key": self.api_key,
            "Authorization": digest,
            "User-Agent": "nexus-podcast-client/1.0",
        }

    def _get_json(self, path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        return get_json_with_retry(
            f"{self.base_url}{path}",
            headers=self._auth_headers(),
            params=params,
            timeout_s=15.0,
            backoff_seconds=PODCAST_PROVIDER_BACKOFF_SECONDS[: PODCAST_PROVIDER_MAX_ATTEMPTS - 1],
            error_code=ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            provider_name=PODCAST_PROVIDER,
            honor_retry_after=True,
        )

    def browse_search_payload(self, query: str, limit: int) -> dict[str, Any]:
        """Return the provider payload for Browse's strict adapter to parse."""
        return self._get_json(
            "/search/byterm",
            params={"q": query, "max": max(1, min(limit, 100))},
        )

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

    def lookup_podcast_by_feed_url(self, feed_url: str) -> dict[str, Any] | None:
        payload = self._get_json(
            "/podcasts/byfeedurl",
            params={"url": feed_url},
        )
        candidate: dict[str, Any] | None = None
        if isinstance(payload.get("feed"), dict):
            candidate = payload["feed"]
        elif isinstance(payload.get("feeds"), list):
            feeds = payload["feeds"]
            first = feeds[0] if feeds else None
            if isinstance(first, dict):
                candidate = first
        if candidate is None:
            return None

        provider_podcast_id = str(candidate.get("id") or "").strip()
        normalized_feed_url = str(candidate.get("url") or feed_url or "").strip()
        if not provider_podcast_id or not normalized_feed_url:
            return None

        return {
            "provider_podcast_id": provider_podcast_id,
            "title": str(candidate.get("title") or "Untitled Podcast"),
            "author": (
                str(candidate.get("author")) if candidate.get("author") is not None else None
            ),
            "feed_url": normalized_feed_url,
            "website_url": (
                str(candidate.get("link")) if candidate.get("link") is not None else None
            ),
            "image_url": (
                str(candidate.get("image")) if candidate.get("image") is not None else None
            ),
            "description": (
                str(candidate.get("description"))
                if candidate.get("description") is not None
                else None
            ),
        }

    def fetch_recent_episodes(self, provider_podcast_id: str, limit: int) -> list[dict[str, Any]]:
        payload = self._get_json(
            "/episodes/byfeedid",
            params={
                "id": provider_podcast_id,
                "max": max(1, min(limit, PODCAST_INDEX_EPISODE_PAGE_SIZE)),
            },
        )
        items = payload.get("items", [])
        if not isinstance(items, list):
            return []

        episodes: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            podcast_index_episode_ref = str(item.get("id") or "").strip()

            guid_raw = item.get("guid")
            guid = str(guid_raw).strip() if guid_raw is not None and str(guid_raw).strip() else None

            published_at = normalize_provider_published_at(item.get("datePublished"))
            duration_seconds = coerce_positive_int(item.get("duration"))
            audio_url = str(item.get("enclosureUrl") or item.get("enclosure_url") or "").strip()
            if not audio_url:
                audio_url = str(item.get("url") or "").strip()

            episodes.append(
                {
                    "podcast_index_episode_ref": podcast_index_episode_ref or None,
                    "guid": guid,
                    "title": str(item.get("title") or "Untitled Episode"),
                    "authors": (
                        [str(item.get("author")).strip()]
                        if str(item.get("author") or "").strip()
                        else None
                    ),
                    "audio_url": audio_url,
                    "published_at": published_at,
                    "duration_seconds": duration_seconds,
                    "transcript_segments": None,
                    "rss_transcript_refs": None,
                    "language": None,
                    "feed_language": None,
                }
            )
        return episodes[: max(1, min(limit, PODCAST_INDEX_EPISODE_PAGE_SIZE))]


def get_podcast_index_client() -> PodcastIndexClient:
    settings = get_settings()
    return PodcastIndexClient(
        api_key=settings.podcast_index_api_key,
        api_secret=settings.podcast_index_api_secret,
        base_url=settings.podcast_index_base_url,
    )
