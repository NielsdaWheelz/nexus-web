"""Helpers for deriving typed playback-source contracts."""

from nexus.db.models import MediaKind
from nexus.schemas.media import PlaybackSourceOut


def derive_playback_source(
    *,
    kind: str,
    external_playback_url: str | None,
    canonical_source_url: str | None,
) -> PlaybackSourceOut | None:
    """Return typed playback metadata for media kinds with external playback."""
    if kind not in {MediaKind.podcast_episode.value, MediaKind.video.value}:
        return None

    stream_url = _normalize_url(external_playback_url) or _normalize_url(canonical_source_url)
    source_url = _normalize_url(external_playback_url) or _normalize_url(canonical_source_url)

    if not stream_url and not source_url:
        return None
    if stream_url is None:
        stream_url = source_url
    if source_url is None:
        source_url = stream_url

    if stream_url is None or source_url is None:
        return None

    source_kind = "external_audio" if kind == MediaKind.podcast_episode.value else "external_video"
    return PlaybackSourceOut(
        kind=source_kind,
        stream_url=stream_url,
        source_url=source_url,
    )


def _normalize_url(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip()
    return normalized or None
