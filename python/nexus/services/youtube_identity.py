"""Canonical YouTube URL identity helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

_YOUTUBE_PROVIDER = "youtube"
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

_YOUTUBE_HOSTS = {
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
}


@dataclass(frozen=True)
class YouTubeIdentity:
    provider: str
    provider_video_id: str
    watch_url: str
    embed_url: str


def is_youtube_url(url: str) -> bool:
    """Return True when URL host is one of the YouTube host variants."""
    parsed = urlparse(url)
    return _normalize_host(parsed.hostname) in _YOUTUBE_HOSTS


def classify_youtube_url(url: str) -> YouTubeIdentity | None:
    """Classify URL as YouTube video identity when possible.

    Returns None for non-YouTube URLs and for YouTube URLs that do not
    include a valid canonical video ID.
    """
    parsed = urlparse(url)
    host = _normalize_host(parsed.hostname)
    if host not in _YOUTUBE_HOSTS:
        return None

    provider_video_id = _extract_video_id(parsed, host)
    if provider_video_id is None:
        return None

    watch_url = f"https://www.youtube.com/watch?v={provider_video_id}"
    embed_url = f"https://www.youtube.com/embed/{provider_video_id}"
    return YouTubeIdentity(
        provider=_YOUTUBE_PROVIDER,
        provider_video_id=provider_video_id,
        watch_url=watch_url,
        embed_url=embed_url,
    )


def _normalize_host(hostname: str | None) -> str:
    if hostname is None:
        return ""
    host = hostname.strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


def _extract_video_id(parsed, host: str) -> str | None:
    if host == "youtu.be":
        video_id = _first_path_segment(parsed.path)
        return video_id if _is_valid_video_id(video_id) else None

    path = parsed.path.strip("/")
    if path == "watch":
        value = parse_qs(parsed.query).get("v", [None])[0]
        return value if _is_valid_video_id(value) else None

    for prefix in ("embed", "shorts", "live", "v"):
        if path.startswith(f"{prefix}/"):
            video_id = path.split("/", 1)[1].split("/", 1)[0]
            return video_id if _is_valid_video_id(video_id) else None

    return None


def _first_path_segment(path: str) -> str | None:
    normalized = path.strip("/")
    if not normalized:
        return None
    return normalized.split("/", 1)[0]


def _is_valid_video_id(video_id: str | None) -> bool:
    if video_id is None:
        return False
    return _VIDEO_ID_RE.match(video_id) is not None
