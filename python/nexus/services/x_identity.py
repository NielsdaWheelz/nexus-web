"""Canonical X/Twitter URL identity helpers."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

_X_PROVIDER = "x"
_X_HOSTS = {
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
}
_POST_PATH_PREFIXES = {"status", "statuses"}


@dataclass(frozen=True)
class XIdentity:
    provider: str
    provider_id: str
    canonical_url: str


def is_x_url(url: str) -> bool:
    """Return True when URL host is one of the X/Twitter host variants."""
    parsed = urlparse(url)
    return _normalize_host(parsed.hostname) in _X_HOSTS


def classify_x_url(url: str) -> XIdentity | None:
    """Classify URL as an X/Twitter post identity when possible.

    Returns None for non-X URLs and for X URLs that do not include a valid
    decimal post ID.
    """
    parsed = urlparse(url)
    if _normalize_host(parsed.hostname) not in _X_HOSTS:
        return None

    provider_id = _extract_post_id(parsed.path)
    if provider_id is None:
        return None

    return XIdentity(
        provider=_X_PROVIDER,
        provider_id=provider_id,
        canonical_url=f"https://x.com/i/status/{provider_id}",
    )


def _normalize_host(hostname: str | None) -> str:
    if hostname is None:
        return ""
    host = hostname.strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


def _extract_post_id(path: str) -> str | None:
    segments = [segment for segment in path.split("/") if segment]
    for idx, segment in enumerate(segments):
        if segment in _POST_PATH_PREFIXES and idx + 1 < len(segments):
            post_id = segments[idx + 1]
            return post_id if post_id.isdecimal() else None
    return None
