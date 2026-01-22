"""Tests for capabilities derivation.

Tests cover:
- Capability rules for all media kinds
- Status-based capability changes
- Failed + playback-ok semantics
- PDF special cases
"""

import pytest

from nexus.services.capabilities import derive_capabilities


class TestPdfCapabilities:
    """Tests for PDF media capabilities."""

    def test_pdf_pending_with_file(self):
        """PDF with file in pending status can be read (pdf.js renders)."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="pending",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_download_file is True
        # PDF can_quote requires plain_text extraction
        assert caps.can_quote is False
        assert caps.can_search is False
        assert caps.can_play is False

    def test_pdf_ready_for_reading_with_plain_text(self):
        """PDF ready_for_reading with plain_text can quote."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            has_plain_text=True,
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_search is True
        assert caps.can_download_file is True

    def test_pdf_no_file(self):
        """PDF without file cannot be read."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="pending",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
        )

        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_download_file is False


class TestEpubCapabilities:
    """Tests for EPUB media capabilities."""

    def test_epub_pending(self):
        """EPUB in pending status cannot be read (no fragments)."""
        caps = derive_capabilities(
            kind="epub",
            processing_status="pending",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
        )

        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_quote is False
        assert caps.can_download_file is True

    def test_epub_ready_for_reading(self):
        """EPUB ready_for_reading can be read."""
        caps = derive_capabilities(
            kind="epub",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_search is True
        assert caps.can_download_file is True


class TestWebArticleCapabilities:
    """Tests for web article media capabilities."""

    def test_web_article_pending(self):
        """Web article in pending cannot be read."""
        caps = derive_capabilities(
            kind="web_article",
            processing_status="pending",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
        )

        assert caps.can_read is False
        assert caps.can_download_file is False

    def test_web_article_ready(self):
        """Web article ready can be read."""
        caps = derive_capabilities(
            kind="web_article",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True


class TestVideoCapabilities:
    """Tests for video media capabilities."""

    def test_video_ready_with_playback_url(self):
        """Video ready with playback URL can play and read."""
        caps = derive_capabilities(
            kind="video",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_play is True
        assert caps.can_download_file is False

    def test_video_transcript_unavailable(self):
        """Video with transcript unavailable can play but not read."""
        caps = derive_capabilities(
            kind="video",
            processing_status="failed",
            last_error_code="E_TRANSCRIPT_UNAVAILABLE",
            media_file_exists=False,
            external_playback_url_exists=True,
        )

        # Can play but cannot read/highlight/quote
        assert caps.can_play is True
        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_quote is False
        assert caps.can_search is False

    def test_video_failed_no_playback(self):
        """Video failed without playback URL cannot play."""
        caps = derive_capabilities(
            kind="video",
            processing_status="failed",
            last_error_code="E_EXTRACTION_FAILED",
            media_file_exists=False,
            external_playback_url_exists=False,
        )

        assert caps.can_play is False
        assert caps.can_read is False


class TestPodcastEpisodeCapabilities:
    """Tests for podcast episode media capabilities."""

    def test_podcast_episode_ready(self):
        """Podcast episode ready can read and play."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_play is True

    def test_podcast_transcript_unavailable(self):
        """Podcast with unavailable transcript can play only."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="failed",
            last_error_code="E_TRANSCRIPT_UNAVAILABLE",
            media_file_exists=False,
            external_playback_url_exists=True,
        )

        assert caps.can_play is True
        assert caps.can_read is False
        assert caps.can_highlight is False


class TestDownloadCapability:
    """Tests for can_download_file capability."""

    def test_download_requires_media_file(self):
        """can_download_file requires media_file to exist."""
        caps_no_file = derive_capabilities(
            kind="pdf",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
        )

        caps_with_file = derive_capabilities(
            kind="pdf",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
        )

        assert caps_no_file.can_download_file is False
        assert caps_with_file.can_download_file is True

    def test_download_independent_of_status(self):
        """can_download_file works even in failed status if file exists."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="failed",
            last_error_code="E_EXTRACTION_FAILED",
            media_file_exists=True,
            external_playback_url_exists=False,
        )

        assert caps.can_download_file is True


class TestProcessingStatusProgression:
    """Tests for capability changes across processing statuses."""

    @pytest.mark.parametrize(
        "status,expected_read",
        [
            ("pending", False),
            ("extracting", False),
            ("ready_for_reading", True),
            ("embedding", True),
            ("ready", True),
            ("failed", False),
        ],
    )
    def test_web_article_status_progression(self, status, expected_read):
        """Web article read capability follows status progression."""
        caps = derive_capabilities(
            kind="web_article",
            processing_status=status,
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
        )

        assert caps.can_read is expected_read
