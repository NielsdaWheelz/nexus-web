"""Unit tests for typed playback-source derivation."""

import pytest

from nexus.db.models import MediaKind
from nexus.services.playback_source import derive_playback_source

pytestmark = pytest.mark.unit


def test_youtube_provider_id_must_match_youtube_id_contract() -> None:
    playback_source = derive_playback_source(
        kind=MediaKind.video.value,
        external_playback_url="https://cdn.example.com/video.mp4",
        canonical_source_url="https://example.com/video",
        provider="youtube",
        provider_id="not-a-youtube-id",
    )

    assert playback_source is not None
    assert playback_source.kind == "external_video"
    assert playback_source.stream_url == "https://cdn.example.com/video.mp4"
    assert playback_source.provider == "youtube"
    assert playback_source.provider_video_id is None
    assert playback_source.watch_url is None
    assert playback_source.embed_url is None


def test_valid_youtube_provider_id_derives_canonical_playback_urls() -> None:
    playback_source = derive_playback_source(
        kind=MediaKind.video.value,
        external_playback_url="https://cdn.example.com/video.mp4",
        canonical_source_url="https://example.com/video",
        provider="youtube",
        provider_id="dQw4w9WgXcQ",
    )

    assert playback_source is not None
    assert playback_source.kind == "external_video"
    assert playback_source.stream_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert playback_source.source_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert playback_source.provider == "youtube"
    assert playback_source.provider_video_id == "dQw4w9WgXcQ"
    assert playback_source.watch_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert playback_source.embed_url == "https://www.youtube.com/embed/dQw4w9WgXcQ"
