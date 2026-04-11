"""Helpers for deriving typed playback-source contracts."""

from nexus.db.models import MediaKind
from nexus.schemas.media import PlaybackSourceOut
from nexus.services.youtube_identity import classify_youtube_url


def derive_playback_source(
    *,
    kind: str,
    external_playback_url: str | None,
    canonical_source_url: str | None,
    provider: str | None = None,
    provider_id: str | None = None,
) -> PlaybackSourceOut | None:
    """Return typed playback metadata for media kinds with external playback."""
    if kind not in {MediaKind.podcast_episode.value, MediaKind.video.value}:
        return None

    resolved_url = _normalize_url(external_playback_url) or _normalize_url(canonical_source_url)
    if resolved_url is None:
        return None

    stream_url = resolved_url
    source_url = resolved_url

    normalized_provider = _normalize_provider(provider)
    if kind == MediaKind.podcast_episode.value:
        return PlaybackSourceOut(
            kind="external_audio",
            stream_url=stream_url,
            source_url=source_url,
            provider=normalized_provider,
        )

    youtube_video_id = _normalize_id(provider_id) if normalized_provider == "youtube" else None
    if youtube_video_id is None:
        for candidate in (stream_url, source_url, canonical_source_url):
            if not candidate:
                continue
            identity = classify_youtube_url(candidate)
            if identity is None:
                continue
            youtube_video_id = identity.provider_video_id
            normalized_provider = identity.provider
            break

    if youtube_video_id is not None:
        watch_url = f"https://www.youtube.com/watch?v={youtube_video_id}"
        embed_url = f"https://www.youtube.com/embed/{youtube_video_id}"
        # Keep compatibility fields aligned to canonical watch URL.
        return PlaybackSourceOut(
            kind="external_video",
            stream_url=watch_url,
            source_url=watch_url,
            provider="youtube",
            provider_video_id=youtube_video_id,
            watch_url=watch_url,
            embed_url=embed_url,
        )

    return PlaybackSourceOut(
        kind="external_video",
        stream_url=stream_url,
        source_url=source_url,
        provider=normalized_provider,
    )


def _normalize_url(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip()
    return normalized or None


def _normalize_id(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip()
    return normalized or None


def _normalize_provider(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None
    normalized = str(raw_value).strip().lower()
    return normalized or None
