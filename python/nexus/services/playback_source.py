"""Helpers for deriving typed playback-source contracts."""

from nexus.db.models import MediaKind
from nexus.schemas.media import PlaybackSourceOut
from nexus.services.youtube_identity import build_youtube_identity, classify_youtube_url


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

    normalized_provider = str(provider).strip().lower() if provider is not None else None
    normalized_provider = normalized_provider or None
    if kind == MediaKind.podcast_episode.value:
        return PlaybackSourceOut(
            kind="external_audio",
            stream_url=stream_url,
            source_url=source_url,
            provider=normalized_provider,
        )

    provider_video_id = (
        str(provider_id).strip()
        if normalized_provider == "youtube" and provider_id is not None
        else None
    )
    provider_video_id = provider_video_id or None
    youtube_identity = (
        build_youtube_identity(provider_video_id) if provider_video_id is not None else None
    )
    if youtube_identity is None:
        for candidate in (stream_url, source_url, canonical_source_url):
            if not candidate:
                continue
            identity = classify_youtube_url(candidate)
            if identity is None:
                continue
            youtube_identity = identity
            break

    if youtube_identity is not None:
        # Expose every video URL field through the canonical watch/embed pair.
        return PlaybackSourceOut(
            kind="external_video",
            stream_url=youtube_identity.watch_url,
            source_url=youtube_identity.watch_url,
            provider="youtube",
            provider_video_id=youtube_identity.provider_video_id,
            watch_url=youtube_identity.watch_url,
            embed_url=youtube_identity.embed_url,
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
