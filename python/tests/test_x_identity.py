"""Unit tests for canonical X/Twitter URL identity parsing."""

import pytest

from nexus.services.x_identity import classify_x_url, is_x_url

pytestmark = pytest.mark.unit


class TestClassifyXUrl:
    def test_x_status_url_returns_canonical_identity(self):
        identity = classify_x_url("https://x.com/user/status/1234567890")

        assert identity is not None
        assert identity.provider == "x"
        assert identity.provider_id == "1234567890"
        assert identity.canonical_url == "https://x.com/i/status/1234567890"

    def test_twitter_statuses_url_strips_query_and_fragment(self):
        identity = classify_x_url(
            "https://mobile.twitter.com/user/statuses/9876543210?ref_src=twsrc%5Etfw#fragment"
        )

        assert identity is not None
        assert identity.provider == "x"
        assert identity.provider_id == "9876543210"
        assert identity.canonical_url == "https://x.com/i/status/9876543210"

    def test_non_x_host_returns_none(self):
        assert classify_x_url("https://example.com/user/status/1234567890") is None

    def test_invalid_post_id_returns_none(self):
        assert classify_x_url("https://x.com/user/status/not-a-number") is None

    def test_status_url_with_trailing_media_path_returns_canonical_identity(self):
        identity = classify_x_url("https://x.com/user/status/1234567890/photo/1")

        assert identity is not None
        assert identity.provider_id == "1234567890"
        assert identity.canonical_url == "https://x.com/i/status/1234567890"

    def test_is_x_url_matches_supported_hosts_only(self):
        assert is_x_url("https://twitter.com/user/status/1234567890") is True
        assert is_x_url("https://example.com/user/status/1234567890") is False
