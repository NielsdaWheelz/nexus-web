"""Canonical YouTube URL identity helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs

from nexus.services.url_identity import ParsedIdentityUrl, parse_identity_url

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


def classify_youtube_provider_video_id(provider_video_id: str | None) -> YouTubeIdentity | None:
    """Classify a raw provider video id when it satisfies YouTube's ID contract."""
    normalized = provider_video_id.strip() if provider_video_id is not None else None
    if normalized is None or not _is_valid_video_id(normalized):
        return None
    return _build_youtube_identity(normalized)


def _build_youtube_identity(provider_video_id: str) -> YouTubeIdentity:
    watch_url = f"https://www.youtube.com/watch?v={provider_video_id}"
    embed_url = f"https://www.youtube.com/embed/{provider_video_id}"
    return YouTubeIdentity(
        provider=_YOUTUBE_PROVIDER,
        provider_video_id=provider_video_id,
        watch_url=watch_url,
        embed_url=embed_url,
    )


def is_youtube_url(url: str) -> bool:
    """Return True when URL host is one of the YouTube host variants."""
    return parse_identity_url(url).host in _YOUTUBE_HOSTS


def classify_youtube_url(url: str) -> YouTubeIdentity | None:
    """Classify URL as YouTube video identity when possible.

    Returns None for non-YouTube URLs and for YouTube URLs that do not
    include a valid canonical video ID.
    """
    parsed = parse_identity_url(url)
    if parsed.host not in _YOUTUBE_HOSTS:
        return None

    provider_video_id = _extract_video_id(parsed)
    if provider_video_id is None:
        return None

    return classify_youtube_provider_video_id(provider_video_id)


def _extract_video_id(parsed: ParsedIdentityUrl) -> str | None:
    if parsed.host == "youtu.be":
        video_id = _first_path_segment(parsed.path_segments)
        return video_id if _is_valid_video_id(video_id) else None

    if parsed.path_segments == ("watch",):
        value = parse_qs(parsed.query).get("v", [None])[0]
        return value if _is_valid_video_id(value) else None

    for prefix in ("embed", "shorts", "live", "v"):
        if len(parsed.path_segments) >= 2 and parsed.path_segments[0] == prefix:
            video_id = parsed.path_segments[1]
            return video_id if _is_valid_video_id(video_id) else None

    return None


def _first_path_segment(segments: tuple[str, ...]) -> str | None:
    return segments[0] if segments else None


def _is_valid_video_id(video_id: str | None) -> bool:
    if video_id is None:
        return False
    return _VIDEO_ID_RE.match(video_id) is not None
