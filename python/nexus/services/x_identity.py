"""Canonical X/Twitter URL identity helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass

from nexus.services.url_identity import parse_identity_url
from nexus.services.x_types import canonical_x_post_url

_X_PROVIDER = "x"
_X_HOSTS = {
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
}
_POST_PATH_PREFIXES = {"status", "statuses"}
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")


@dataclass(frozen=True)
class XIdentity:
    provider: str
    provider_id: str
    canonical_url: str
    username: str | None = None


def is_x_url(url: str) -> bool:
    """Return True when URL host is one of the X/Twitter host variants."""
    return parse_identity_url(url).host in _X_HOSTS


def classify_x_url(url: str) -> XIdentity | None:
    """Classify URL as an X/Twitter post identity when possible.

    Returns None for non-X URLs and for X URLs that do not include a valid
    decimal post ID.
    """
    parsed = parse_identity_url(url)
    if parsed.host not in _X_HOSTS:
        return None

    provider_id = _extract_post_id(parsed.path_segments)
    if provider_id is None:
        return None

    return XIdentity(
        provider=_X_PROVIDER,
        provider_id=provider_id,
        canonical_url=canonical_x_post_url(provider_id),
        username=_extract_username(parsed.path_segments),
    )


def normalize_x_username(value: str | None) -> str | None:
    username = (value or "").strip().removeprefix("@")
    return username if _USERNAME_RE.fullmatch(username) else None


def _extract_post_id(segments: tuple[str, ...]) -> str | None:
    for idx, segment in enumerate(segments):
        if segment in _POST_PATH_PREFIXES and idx + 1 < len(segments):
            post_id = segments[idx + 1]
            return post_id if post_id.isdecimal() else None
    return None


def _extract_username(segments: tuple[str, ...]) -> str | None:
    for idx, segment in enumerate(segments):
        if segment in _POST_PATH_PREFIXES and idx > 0:
            username = segments[idx - 1].strip("@")
            if username.lower() == "i":
                return None
            return normalize_x_username(username)
    return None
