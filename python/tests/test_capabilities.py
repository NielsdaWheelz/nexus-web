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

    def test_failed_web_article_cannot_retry_without_failed_source_attempt(self):
        caps = derive_capabilities(
            kind="web_article",
            processing_status="failed",
            last_error_code="E_INGEST_FAILED",
            media_file_exists=False,
            external_playback_url_exists=False,
            is_creator=True,
            requested_url_exists=True,
        )

        assert caps.can_retry is False

    def test_failed_pdf_password_error_cannot_retry(self):
        caps = derive_capabilities(
            kind="pdf",
            processing_status="failed",
            last_error_code="E_PDF_PASSWORD_REQUIRED",
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
            source_refresh_available=True,
        )

        assert caps.can_retry is False

    def test_failed_remote_pdf_source_attempt_can_retry_without_file(self):
        caps = derive_capabilities(
            kind="pdf",
            processing_status="failed",
            last_error_code="E_INGEST_FAILED",
            media_file_exists=False,
            external_playback_url_exists=False,
            is_creator=True,
            source_retry_available=True,
            source_refresh_available=True,
        )

        assert caps.can_retry is True
        assert caps.can_refresh_source is True

    def test_failed_epub_archive_error_cannot_retry(self):
        caps = derive_capabilities(
            kind="epub",
            processing_status="failed",
            last_error_code="E_ARCHIVE_UNSAFE",
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
            source_refresh_available=True,
        )

        assert caps.can_retry is False


class TestSourceRefreshUploadedFiles:
    """Tests for can_refresh_source on uploaded pdf/epub media (spec section 4.3)."""

    @pytest.mark.parametrize("status", ["ready", "ready_for_reading"])
    def test_pdf_creator_can_refresh_source_when_file_exists_and_ready(self, status):
        """PDF creator can refresh source when file present and status is ready-like."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status=status,
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
            source_refresh_available=True,
        )

        assert caps.can_refresh_source is True, (
            f"Expected can_refresh_source=True for pdf creator with file in status={status}"
        )

    def test_pdf_can_refresh_source_when_failed(self):
        """PDF can be refreshed when failed (failed is in _REFRESHABLE_PROCESSING_STATUSES)."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="failed",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
            source_refresh_available=True,
        )

        assert caps.can_refresh_source is True

    def test_pdf_cannot_refresh_source_when_file_missing(self):
        """PDF cannot refresh source without the underlying file."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_refresh_source is False

    def test_pdf_cannot_refresh_source_when_not_creator(self):
        """Non-creator viewers never get the refresh capability."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=False,
        )

        assert caps.can_refresh_source is False

    def test_epub_can_refresh_source_when_file_exists(self):
        """EPUB creator can refresh source when file present."""
        caps = derive_capabilities(
            kind="epub",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
            source_refresh_available=True,
        )

        assert caps.can_refresh_source is True

    def test_epub_cannot_refresh_source_when_file_missing(self):
        """EPUB cannot refresh source without the underlying file."""
        caps = derive_capabilities(
            kind="epub",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=False,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_refresh_source is False


class TestCanRetryMetadata:
    """Tests for can_retry_metadata capability (spec section 4.3)."""

    @pytest.mark.parametrize("kind", ["pdf", "epub"])
    def test_can_retry_metadata_true_when_ready_and_creator(self, kind):
        """can_retry_metadata is true for any ready document kind when viewer is creator."""
        caps = derive_capabilities(
            kind=kind,
            processing_status="ready",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_retry_metadata is True, (
            f"Expected can_retry_metadata=True for creator on ready {kind}"
        )

    def test_can_retry_metadata_false_when_not_creator(self):
        """can_retry_metadata is false for non-creator viewers."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="ready",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=False,
        )

        assert caps.can_retry_metadata is False

    def test_can_retry_metadata_false_when_failed(self):
        """can_retry_metadata is false for failed docs (status must be ready-like)."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="failed",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_retry_metadata is False

    def test_can_retry_metadata_false_when_extracting(self):
        """can_retry_metadata is false during extraction (not yet ready)."""
        caps = derive_capabilities(
            kind="pdf",
            processing_status="extracting",
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
        )

        assert caps.can_retry_metadata is False

    @pytest.mark.parametrize(
        "status",
        ["ready", "ready_for_reading", "embedding", "failed"],
    )
    @pytest.mark.parametrize("kind", ["pdf", "epub", "web_article"])
    def test_can_retry_metadata_and_can_retry_mutually_exclusive(self, status, kind):
        """Invariant I6: can_retry and can_retry_metadata are never both true."""
        caps = derive_capabilities(
            kind=kind,
            processing_status=status,
            last_error_code=None,
            media_file_exists=True,
            external_playback_url_exists=False,
            is_creator=True,
            requested_url_exists=True,
        )

        assert not (caps.can_retry and caps.can_retry_metadata), (
            f"Mutual exclusion violated for kind={kind} status={status}: "
            f"can_retry={caps.can_retry}, can_retry_metadata={caps.can_retry_metadata}"
        )
