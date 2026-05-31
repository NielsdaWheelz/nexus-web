"""Shared URL parsing helpers for provider identity classifiers."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from nexus.services.url_normalize import normalize_host


@dataclass(frozen=True)
class ParsedIdentityUrl:
    host: str
    path_segments: tuple[str, ...]
    query: str


def parse_identity_url(url: str) -> ParsedIdentityUrl:
    parsed = urlparse(url)
    return ParsedIdentityUrl(
        host=normalize_host(parsed.hostname),
        path_segments=tuple(segment for segment in parsed.path.split("/") if segment),
        query=parsed.query,
    )
