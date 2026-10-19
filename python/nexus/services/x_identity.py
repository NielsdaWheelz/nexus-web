"""X/Twitter URL and provider identity."""

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


def canonical_x_article_url(article_id: str) -> str:
    return f"https://x.com/i/article/{article_id}"


def x_post_provider_id(post_id: str) -> str:
    return f"post:{post_id}"


def x_article_provider_id(article_id: str) -> str:
    return f"article:{article_id}"


def x_author_thread_provider_id(author_id: str, conversation_id: str) -> str:
    return f"author-thread:{author_id}:{conversation_id}"


def is_x_url(url: str) -> bool:
    """True when the URL host is one of the X/Twitter host variants."""
    return parse_identity_url(url).host in _X_HOSTS


def classify_x_article_url(url: str) -> str | None:
    """An article URL's id; native identity additionally requires provider article metadata."""
    parsed = parse_identity_url(url)
    segments = parsed.path_segments
    if parsed.host not in _X_HOSTS or len(segments) != 3 or segments[:2] != ("i", "article"):
        return None
    article_id = segments[2]
    return article_id if article_id.isascii() and article_id.isdecimal() else None


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
                if post_id.isdecimal()
                else None
            )
    return None
