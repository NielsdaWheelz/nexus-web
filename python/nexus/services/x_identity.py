"""Exact X/Twitter permalink identity; canonical posts are resolved through aliases."""

from __future__ import annotations

import re
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


def canonical_x_article_url(article_id: str) -> str:
    return f"https://x.com/i/article/{article_id}"


def x_article_provider_id(article_id: str) -> str:
    return f"article:{article_id}"


def native_x_article_id(*, kind: str, provider: str | None, provider_id: str | None) -> str | None:
    """Native article identity; ordinary captures and canonical X posts are distinct."""
    if kind != "web_article" or provider != "x" or provider_id is None:
        return None
    prefix, _, article_id = provider_id.partition(":")
    return (
        article_id
        if prefix == "article" and article_id.isascii() and article_id.isdecimal()
        else None
    )


def classify_x_article_url(url: str) -> str | None:
    """An article URL id; native identity additionally requires provider article metadata."""
    parsed = parse_identity_url(url)
    segments = parsed.path_segments
    if parsed.host not in _X_HOSTS or len(segments) != 3 or segments[:2] != ("i", "article"):
        return None
    article_id = segments[2]
    return article_id if article_id.isascii() and article_id.isdecimal() else None


def classify_x_article_carrier_url(url: str) -> str | None:
    """Qualified article-page redirect; its decimal id names the carrier, not the article."""
    parsed = parse_identity_url(url)
    segments = parsed.path_segments
    if (
        parsed.host not in _X_HOSTS
        or len(segments) != 3
        or segments[0] == "i"
        or re.fullmatch(r"[A-Za-z0-9_]{1,15}", segments[0]) is None
        or segments[1] != "article"
    ):
        return None
    carrier_id = segments[2]
    return carrier_id if carrier_id.isascii() and carrier_id.isdecimal() else None


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
