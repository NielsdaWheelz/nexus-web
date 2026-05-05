"""Tests for capabilities derivation.

Tests cover:
- Capability rules for all media kinds
- Status-based capability changes
- Failed + playback-ok semantics
- PDF special cases
"""

import pytest

from nexus.services.capabilities import derive_capabilities

pytestmark = pytest.mark.unit


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
        """PDF ready_for_reading with full quote readiness can quote."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            pdf_quote_text_ready=True,
            retrieval_status="ready",
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_search is True
        assert caps.can_download_file is True

    def test_pr03_capabilities_pdf_quote_search_gate_uses_explicit_pdf_quote_text_ready_input(
        self,
    ):
        """PDF can_quote/can_search follow the explicit pdf_quote_text_ready input,
        not has_plain_text."""
        caps_no_ready = derive_capabilities(
            kind="pdf",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            pdf_quote_text_ready=False,
        )
        assert caps_no_ready.can_read is True
        assert caps_no_ready.can_quote is False
        assert caps_no_ready.can_search is False

        caps_ready = derive_capabilities(
            kind="pdf",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            pdf_quote_text_ready=True,
            retrieval_status="ready",
        )
        assert caps_ready.can_read is True
        assert caps_ready.can_quote is True
        assert caps_ready.can_search is True

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
            retrieval_status="ready",
        )

        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_search is True
        assert caps.can_download_file is True

    def test_epub_search_uses_active_ready_retrieval_gate(self):
        """Search remains available when the active run is ready even if latest state failed."""
        caps = derive_capabilities(
            kind="epub",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            retrieval_status="failed",
            retrieval_active_ready=True,
        )

        assert caps.can_read is True
        assert caps.can_quote is True
        assert caps.can_search is True

    def test_epub_search_excludes_missing_active_ready_run(self):
        """A ready status is not enough when the caller knows no active ready run exists."""
        caps = derive_capabilities(
            kind="epub",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            retrieval_status="ready",
            retrieval_active_ready=False,
        )

        assert caps.can_read is True
        assert caps.can_quote is True
        assert caps.can_search is False


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
        """Video with ready transcript state and playback URL can play and read."""
        caps = derive_capabilities(
            kind="video",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state="ready",
            transcript_coverage="full",
            retrieval_status="ready",
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
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state="unavailable",
            transcript_coverage="none",
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

    def test_podcast_episode_pending_is_playable_but_not_readable(self):
        """Metadata-only podcast episodes should allow playback before transcript request."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="pending",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
        )

        assert caps.can_play is True
        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_quote is False
        assert caps.can_search is False

    def test_podcast_episode_ready(self):
        """Podcast episode with ready transcript state can read and play."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state="ready",
            transcript_coverage="full",
            retrieval_status="ready",
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
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state="unavailable",
            transcript_coverage="none",
        )

        assert caps.can_play is True
        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_quote is False
        assert caps.can_search is False

    def test_podcast_capabilities_require_transcript_state_to_read(self):
        """Transcript media stays unreadable when transcript state has not been seeded."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="ready_for_reading",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state="not_requested",
            transcript_coverage="none",
        )

        assert caps.can_play is True
        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_quote is False
        assert caps.can_search is False

    def test_podcast_capabilities_allow_ready_transcript_regardless_of_processing_status(self):
        """Dedicated transcript state controls readability even if processing status lags."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="pending",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state="ready",
            transcript_coverage="full",
            retrieval_status="ready",
        )

        assert caps.can_play is True
        assert caps.can_read is True
        assert caps.can_highlight is True
        assert caps.can_quote is True
        assert caps.can_search is True

    def test_podcast_last_error_code_does_not_stand_in_for_transcript_state(self):
        """Transcript media no longer infers unavailability from processing failure residue."""
        caps = derive_capabilities(
            kind="podcast_episode",
            processing_status="failed",
            last_error_code="E_TRANSCRIPT_UNAVAILABLE",
            media_file_exists=False,
            external_playback_url_exists=True,
            transcript_state=None,
            transcript_coverage=None,
        )

        assert caps.can_play is True
        assert caps.can_read is False
        assert caps.can_highlight is False
        assert caps.can_quote is False
        assert caps.can_search is False


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

    def test_failed_web_article_can_retry_when_creator_and_original_url_exists(self):
        caps = derive_capabilities(
            kind="web_article",
            processing_status="failed",
            last_error_code="E_INGEST_FAILED",
            media_file_exists=False,
            external_playback_url_exists=False,
            is_creator=True,
            requested_url_exists=True,
        )

        assert caps.can_retry is True

    def test_failed_pdf_password_error_cannot_retry(self):
        caps = derive_capabilities(
            kind="pdf",
            processing_status="failed",
            last_error_code="E_PDF_PASSWORD_REQUIRED",
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_retry is False

    def test_failed_epub_archive_error_cannot_retry(self):
        caps = derive_capabilities(
            kind="epub",
            processing_status="failed",
            last_error_code="E_ARCHIVE_UNSAFE",
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_retry is False
