# Frozen for migration 0293 from d6f04890c:python/nexus/services/youtube_identity.py.
"""Canonical YouTube URL identity."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs

from .url_normalize import parse_identity_url

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_HOSTS = frozenset(
    {"youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "youtu.be"}
)
_PATH_PREFIXES = frozenset({"embed", "shorts", "live", "v"})


@dataclass(frozen=True, slots=True)
class YouTubeIdentity:
    provider: str
    provider_video_id: str
    watch_url: str
    embed_url: str


def classify_youtube_provider_video_id(provider_video_id: str | None) -> YouTubeIdentity | None:
    """The canonical identity for a raw provider video id, or ``None``."""
    video_id = (provider_video_id or "").strip()
    if not _VIDEO_ID.match(video_id):
        return None
    return YouTubeIdentity(
        provider="youtube",
        provider_video_id=video_id,
        watch_url=f"https://www.youtube.com/watch?v={video_id}",
        embed_url=f"https://www.youtube.com/embed/{video_id}",
    )


def classify_youtube_url(url: str) -> YouTubeIdentity | None:
    """Classify a watch/shorts/embed/live/youtu.be URL, or ``None`` when it has no id."""
    parsed = parse_identity_url(url)
    segments = parsed.path_segments
    if parsed.host not in _HOSTS:
        return None
    if parsed.host == "youtu.be":
        video_id = segments[0] if segments else None
    elif segments == ("watch",):
        video_id = parse_qs(parsed.query).get("v", [None])[0]
    elif len(segments) >= 2 and segments[0] in _PATH_PREFIXES:
        video_id = segments[1]
    else:
        return None
    return classify_youtube_provider_video_id(video_id)
