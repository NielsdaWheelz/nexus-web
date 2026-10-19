"""Exact X/Twitter permalink identity; canonical posts are resolved through aliases."""

from __future__ import annotations

from dataclasses import dataclass

from nexus.services.url_normalize import parse_identity_url

_X_HOSTS = frozenset({"x.com", "twitter.com", "mobile.twitter.com"})


@dataclass(frozen=True, slots=True)
class XIdentity:
    provider: str
    provider_id: str  # the decimal post id
    canonical_url: str


def canonical_x_post_url(post_id: str) -> str:
    return f"https://x.com/i/status/{post_id}"


def is_x_url(url: str) -> bool:
    """True when the URL host is one of the X/Twitter host variants."""
    return parse_identity_url(url).host in _X_HOSTS


def classify_x_url(url: str) -> XIdentity | None:
    """An X status URL's post identity, or ``None`` when it names no decimal post id."""
    parsed = parse_identity_url(url)
    if parsed.host not in _X_HOSTS:
        return None
    segments = parsed.path_segments
    for index, segment in enumerate(segments[:-1]):
        if segment in {"status", "statuses"}:
            post_id = segments[index + 1]
            return (
                XIdentity("x", post_id, canonical_x_post_url(post_id))
                if post_id.isascii() and post_id.isdecimal()
                else None
            )
    return None
