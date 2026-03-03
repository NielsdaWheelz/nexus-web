"""Unit tests for canonical YouTube URL identity parsing."""

import pytest

from nexus.services.youtube_identity import classify_youtube_url

pytestmark = pytest.mark.unit


class TestClassifyYoutubeUrl:
    def test_watch_url_with_query_params_returns_canonical_identity(self):
        identity = classify_youtube_url(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&feature=youtu.be"
        )

        assert identity is not None
        assert identity.provider == "youtube"
        assert identity.provider_video_id == "dQw4w9WgXcQ"
        assert identity.watch_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        assert identity.embed_url == "https://www.youtube.com/embed/dQw4w9WgXcQ"

    def test_short_url_returns_canonical_identity(self):
        identity = classify_youtube_url("https://youtu.be/dQw4w9WgXcQ?t=7")

        assert identity is not None
        assert identity.provider_video_id == "dQw4w9WgXcQ"
        assert identity.watch_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        assert identity.embed_url == "https://www.youtube.com/embed/dQw4w9WgXcQ"

    def test_embed_url_returns_canonical_identity(self):
        identity = classify_youtube_url("https://www.youtube.com/embed/dQw4w9WgXcQ")

        assert identity is not None
        assert identity.provider_video_id == "dQw4w9WgXcQ"

    def test_shorts_url_returns_canonical_identity(self):
        identity = classify_youtube_url("https://www.youtube.com/shorts/dQw4w9WgXcQ")

        assert identity is not None
        assert identity.provider_video_id == "dQw4w9WgXcQ"

    def test_non_youtube_url_returns_none(self):
        assert classify_youtube_url("https://example.com/watch?v=dQw4w9WgXcQ") is None

    def test_invalid_youtube_id_returns_none(self):
        assert classify_youtube_url("https://www.youtube.com/watch?v=too-short") is None
