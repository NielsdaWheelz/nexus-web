"""Podcast Index client and provider-owned parsing helpers."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from nexus.config import get_settings, real_media_provider_fixtures_requested
from nexus.errors import (
    ApiError,
    ApiErrorCode,
)
from nexus.logging import get_logger

logger = get_logger(__name__)

PODCAST_PROVIDER = "podcast_index"
PODCAST_INDEX_EPISODE_PAGE_SIZE = 100
PODCAST_PROVIDER_RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
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

    def _retry_delay_seconds(
        self, *, attempt_index: int, response: httpx.Response | None = None
    ) -> float:
        # Respect Retry-After when provider rate-limits requests.
        if response is not None and response.status_code == 429:
            retry_after = str(response.headers.get("Retry-After") or "").strip()
            if retry_after:
                try:
                    retry_after_seconds = float(retry_after)
                    if retry_after_seconds > 0:
                        return min(retry_after_seconds, 10.0)
                except ValueError:
                    pass
        return PODCAST_PROVIDER_BACKOFF_SECONDS[
            min(attempt_index, len(PODCAST_PROVIDER_BACKOFF_SECONDS) - 1)
        ]

    def _get_json(self, path: str, *, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt_index in range(PODCAST_PROVIDER_MAX_ATTEMPTS):
            try:
                response = httpx.get(
                    url,
                    params=params,
                    headers=self._auth_headers(),
                    timeout=15.0,
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ApiError(
                        ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
                        "Podcast provider returned an invalid response",
                    )
                return payload
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                status_code = exc.response.status_code
                if (
                    status_code in PODCAST_PROVIDER_RETRYABLE_STATUS_CODES
                    and attempt_index < PODCAST_PROVIDER_MAX_ATTEMPTS - 1
                ):
                    delay_seconds = self._retry_delay_seconds(
                        attempt_index=attempt_index,
                        response=exc.response,
                    )
                    logger.warning(
                        "podcast_provider_retryable_http_error",
                        provider=PODCAST_PROVIDER,
                        path=path,
                        status_code=status_code,
                        attempt=attempt_index + 1,
                        max_attempts=PODCAST_PROVIDER_MAX_ATTEMPTS,
                        retry_delay_seconds=delay_seconds,
                    )
                    time.sleep(delay_seconds)
                    continue
                break
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_exc = exc
                if attempt_index < PODCAST_PROVIDER_MAX_ATTEMPTS - 1:
                    delay_seconds = self._retry_delay_seconds(attempt_index=attempt_index)
                    logger.warning(
                        "podcast_provider_retryable_transport_error",
                        provider=PODCAST_PROVIDER,
                        path=path,
                        attempt=attempt_index + 1,
                        max_attempts=PODCAST_PROVIDER_MAX_ATTEMPTS,
                        retry_delay_seconds=delay_seconds,
                        error=str(exc),
                    )
                    time.sleep(delay_seconds)
                    continue
                break
            except Exception as exc:
                last_exc = exc
                break

        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            "Podcast provider request failed",
        ) from last_exc

    def search_podcasts(self, query: str, limit: int) -> list[dict[str, Any]]:
        if real_media_provider_fixtures_requested():
            settings = get_settings()
            if not settings.real_media_provider_fixtures:
                payload = None
            elif "houston we have a podcast" not in str(query or "").casefold():
                return []
            else:
                payload = _read_real_media_json_fixture(
                    settings.real_media_fixture_dir,
                    "nasa-hwhap-podcast-index-search.json",
                    548,
                    "e305e72eac4aa73d6c002d703627316c64dd8140ee7627abaad29851e2771b29",
                )
        else:
            payload = None

        if payload is None:
            payload = self._get_json(
                "/search/byterm",
                params={"q": query, "max": max(1, min(limit, 100))},
            )
        feeds = payload.get("feeds", [])
        if not isinstance(feeds, list):
            return []

        results: list[dict[str, Any]] = []
        for feed in feeds:
            if not isinstance(feed, dict):
                continue
            provider_podcast_id = str(feed.get("id") or "").strip()
            feed_url = str(feed.get("url") or "").strip()
            if not provider_podcast_id or not feed_url:
                continue
            results.append(
                {
                    "provider_podcast_id": provider_podcast_id,
                    "title": str(feed.get("title") or "Untitled Podcast"),
                    "author": (str(feed.get("author")) if feed.get("author") is not None else None),
                    "feed_url": feed_url,
                    "website_url": (
                        str(feed.get("link")) if feed.get("link") is not None else None
                    ),
                    "image_url": (
                        str(feed.get("image")) if feed.get("image") is not None else None
                    ),
                    "description": (
                        str(feed.get("description"))
                        if feed.get("description") is not None
                        else None
                    ),
                }
            )
        return results[: max(1, min(limit, 100))]

    def lookup_podcast_by_feed_url(self, feed_url: str) -> dict[str, Any] | None:
        if real_media_provider_fixtures_requested():
            settings = get_settings()
            if settings.real_media_provider_fixtures:
                if str(feed_url or "").strip() != (
                    "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/feed/"
                ):
                    return None
                payload = _read_real_media_json_fixture(
                    settings.real_media_fixture_dir,
                    "nasa-hwhap-podcast-index-byfeedurl.json",
                    522,
                    "bd819ebd4fee93d475854727cba8c4a8e5415c1bf6a3c5c281dd5ed284538058",
                )
            else:
                payload = None
        else:
            payload = None

        if payload is None:
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
        if real_media_provider_fixtures_requested():
            settings = get_settings()
            if settings.real_media_provider_fixtures:
                if str(provider_podcast_id or "").strip() != "nasa-hwhap-real-media":
                    return []
                payload = _read_real_media_json_fixture(
                    settings.real_media_fixture_dir,
                    "nasa-hwhap-podcast-index-episodes.json",
                    706,
                    "3ef17f4c96f1c40dc3044092a25d7eb9ecef361d19e647caab558c1a2e0b926b",
                )
            else:
                payload = None
        else:
            payload = None

        if payload is None:
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
            provider_episode_id = str(item.get("id") or item.get("guid") or "").strip()
            if not provider_episode_id:
                provider_episode_id = f"episode-{uuid4()}"

            guid_raw = item.get("guid")
            guid = str(guid_raw).strip() if guid_raw is not None and str(guid_raw).strip() else None

            published_at = _normalize_provider_published_at(item.get("datePublished"))
            duration_seconds = _coerce_positive_int(item.get("duration"))
            audio_url = str(item.get("enclosureUrl") or item.get("enclosure_url") or "").strip()
            if not audio_url:
                audio_url = str(item.get("url") or "").strip()

            episodes.append(
                {
                    "provider_episode_id": provider_episode_id,
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
                    # External providers usually do not supply transcript segments.
                    # Tests patch this field through the same boundary seam.
                    "transcript_segments": item.get("transcript_segments"),
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


def _read_real_media_json_fixture(
    fixture_dir: str | None,
    filename: str,
    expected_bytes: int,
    expected_sha256: str,
) -> dict[str, Any]:
    if fixture_dir is None:
        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            "REAL_MEDIA_FIXTURE_DIR is required for podcast provider fixtures",
        )

    path = Path(fixture_dir) / filename
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            f"Podcast provider fixture unavailable: {exc}",
        ) from exc

    if len(payload) != expected_bytes or hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            f"Podcast provider fixture hash mismatch: {filename}",
        )

    try:
        raw = json.loads(payload.decode("utf-8"))
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            f"Podcast provider fixture is invalid JSON: {filename}",
        ) from exc

    if not isinstance(raw, dict) or not isinstance(raw.get("payload"), dict):
        raise ApiError(
            ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            f"Podcast provider fixture missing payload: {filename}",
        )
    return raw["payload"]


def _normalize_provider_published_at(raw_value: Any) -> str | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, (int, float)):
        if raw_value <= 0:
            return None
        return datetime.fromtimestamp(raw_value, UTC).isoformat().replace("+00:00", "Z")
    raw_text = str(raw_value).strip()
    if not raw_text:
        return None
    parsed = _parse_iso_datetime(raw_text)
    if parsed is None:
        return None
    return parsed.isoformat().replace("+00:00", "Z")


def _parse_iso_datetime(raw_value: Any) -> datetime | None:
    if raw_value is None:
        return None
    value = str(raw_value).strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _coerce_positive_int(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value
