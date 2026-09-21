"""Canonical X/Twitter URL identity."""

from __future__ import annotations

import re
from dataclasses import dataclass

from nexus.services.url_normalize import parse_identity_url
from nexus.services.x_types import canonical_x_post_url

_X_HOSTS = {"x.com", "twitter.com", "mobile.twitter.com"}
_POST_PATH_PREFIXES = {"status", "statuses"}
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")


@dataclass(frozen=True, slots=True)
class XIdentity:
    provider: str
    provider_id: str
    canonical_url: str
    username: str | None = None


def is_x_url(url: str) -> bool:
    """True when the URL host is one of the X/Twitter host variants."""
    return parse_identity_url(url).host in _X_HOSTS


def normalize_x_username(value: str | None) -> str | None:
    """Strip a leading ``@`` and accept only a well-formed X handle."""
    username = (value or "").strip().removeprefix("@")
    return username if _USERNAME_RE.fullmatch(username) else None


def classify_x_url(url: str) -> XIdentity | None:
    """Classify an X status URL, or ``None`` when it carries no decimal post id."""
    parsed = parse_identity_url(url)
    if parsed.host not in _X_HOSTS:
        return None
    segments = parsed.path_segments
    for idx, segment in enumerate(segments):
        if segment not in _POST_PATH_PREFIXES or idx + 1 >= len(segments):
            continue
        post_id = segments[idx + 1]
        if not post_id.isdecimal():
            return None
        handle = segments[idx - 1].strip("@") if idx > 0 else None
        return XIdentity(
            provider="x",
            provider_id=post_id,
            canonical_url=canonical_x_post_url(post_id),
            username=None
            if handle is None or handle.lower() == "i"
            else normalize_x_username(handle),
        )
    return None
