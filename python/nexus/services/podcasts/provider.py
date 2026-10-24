"""Podcast Index: signed directory HTTP. Feed traversal never requires directory evidence."""

import hashlib
import time
from typing import Any

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.net.http_retry import get_json_with_retry

PROVIDER = "podcast_index"


class PodcastIndexClient:
    def __init__(self, *, api_key: str | None, api_secret: str | None, base_url: str):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")

    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        """One signed GET; an unconfigured or failing provider is E_PODCAST_PROVIDER_UNAVAILABLE."""
        if not self.api_key or not self.api_secret:
            raise ApiError(
                ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
                "Podcast provider credentials are not configured",
            )
        epoch = str(int(time.time()))
        digest = hashlib.sha1(f"{self.api_key}{self.api_secret}{epoch}".encode()).hexdigest()
        return get_json_with_retry(
            f"{self.base_url}{path}",
            headers={
                "X-Auth-Date": epoch,
                "X-Auth-Key": self.api_key,
                "Authorization": digest,
                "User-Agent": "nexus-podcast-client/1.0",
            },
            params=params,
            timeout_s=15.0,
            backoff_seconds=(0.25, 0.5),
            error_code=ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE,
            provider_name=PROVIDER,
            honor_retry_after=True,
        )


def get_podcast_index_client() -> PodcastIndexClient:
    settings = get_settings()
    return PodcastIndexClient(
        api_key=settings.podcast_index_api_key,
        api_secret=settings.podcast_index_api_secret,
        base_url=settings.podcast_index_base_url,
    )
