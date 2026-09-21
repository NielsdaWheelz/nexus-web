"""Canonical YouTube URL identity."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs

from nexus.services.url_normalize import ParsedIdentityUrl, parse_identity_url

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = {
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
}
_PATH_PREFIXES = ("embed", "shorts", "live", "v")


@dataclass(frozen=True, slots=True)
class YouTubeIdentity:
    provider: str
    provider_video_id: str
    watch_url: str
    embed_url: str


def is_youtube_url(url: str) -> bool:
    """True when the URL host is one of the YouTube host variants."""
    return parse_identity_url(url).host in _YOUTUBE_HOSTS


def classify_youtube_provider_video_id(provider_video_id: str | None) -> YouTubeIdentity | None:
    """Build the canonical identity for a raw provider video id, or ``None``."""
    video_id = (provider_video_id or "").strip()
    if _VIDEO_ID_RE.match(video_id) is None:
        return None
    return YouTubeIdentity(
        provider="youtube",
        provider_video_id=video_id,
        watch_url=f"https://www.youtube.com/watch?v={video_id}",
        embed_url=f"https://www.youtube.com/embed/{video_id}",
    )


def classify_youtube_url(url: str) -> YouTubeIdentity | None:
    """Classify a watch/short/embed/live/youtu.be URL, or ``None`` when it has no id."""
    parsed = parse_identity_url(url)
    if parsed.host not in _YOUTUBE_HOSTS:
        return None
    return classify_youtube_provider_video_id(_extract_video_id(parsed))


def _extract_video_id(parsed: ParsedIdentityUrl) -> str | None:
    if parsed.host == "youtu.be":
        return parsed.path_segments[0] if parsed.path_segments else None
    if parsed.path_segments == ("watch",):
        return parse_qs(parsed.query).get("v", [None])[0]
    if len(parsed.path_segments) >= 2 and parsed.path_segments[0] in _PATH_PREFIXES:
        return parsed.path_segments[1]
    return None
