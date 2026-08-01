"""HTTP composition for provider-runtime traffic.

Provider endpoint substitution is a product capability for operator-owned API
gateways. The test harness uses the same boundary with a loopback protocol
server; provider behavior is never selected inside product logic.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from urllib.parse import urlparse

import httpx

from nexus.config import Environment, Settings, get_settings

_OPENAI_API_BASE_URL = "https://api.openai.com/v1"


def provider_request_event_hooks(
    settings: Settings | None = None,
) -> dict[str, list[Callable[[httpx.Request], Awaitable[None]]]]:
    """Return the exact request rewrite used for an operator-owned OpenAI gateway."""
    active = settings or get_settings()
    configured = _validated_openai_base_url(active)
    if configured == _OPENAI_API_BASE_URL:
        return {}

    async def rewrite_openai_request(request: httpx.Request) -> None:
        raw_url = str(request.url)
        if raw_url == _OPENAI_API_BASE_URL or raw_url.startswith(f"{_OPENAI_API_BASE_URL}/"):
            rewritten = httpx.URL(f"{configured}{raw_url[len(_OPENAI_API_BASE_URL) :]}")
            request.url = rewritten
            request.headers["host"] = rewritten.netloc.decode("ascii")

    return {"request": [rewrite_openai_request]}


def _validated_openai_base_url(settings: Settings) -> str:
    value = settings.openai_api_base_url.rstrip("/")
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("OPENAI_API_BASE_URL must be an absolute HTTP(S) URL without credentials")
    if settings.nexus_env in {Environment.STAGING, Environment.PROD} and parsed.scheme != "https":
        raise ValueError("OPENAI_API_BASE_URL must use HTTPS in staging and production")
    return value
