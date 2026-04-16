"""Unit tests for PDF quote helper branches in context_rendering."""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from nexus.db.models import Highlight, HighlightPdfAnchor, Media
from nexus.errors import ApiErrorCode
from nexus.services import context_rendering
from nexus.services.pdf_quote_match import (
    MatcherAnomaly,
    MatcherAnomalyKind,
    MatchResult,
    MatchStatus,
)
from nexus.services.pdf_quote_match_policy import (
    CoherenceAnomalyKind,
    CoherenceFallbackAction,
    PdfQuoteMatchInternalError,
)
from nexus.services.quote_context_errors import QuoteContextBlockingError

pytestmark = pytest.mark.unit


def _make_media(plain_text: str) -> Media:
    return Media(id=uuid4(), kind="pdf", title="Test PDF", plain_text=plain_text)


def _make_highlight(exact: str) -> Highlight:
    return Highlight(
        id=uuid4(),
        user_id=uuid4(),
        color="yellow",
        exact=exact,
        prefix="",
        suffix="",
    )


def _make_pdf_anchor(
    *,
    media_id,
    status: str,
    match_version: int | None,
    start_offset: int | None,
    end_offset: int | None,
    page_number: int = 1,
) -> HighlightPdfAnchor:
    return HighlightPdfAnchor(
        highlight_id=uuid4(),
        media_id=media_id,
        page_number=page_number,
        geometry_version=1,
        geometry_fingerprint="fp",
        sort_top=Decimal("0"),
        sort_left=Decimal("0"),
        plain_text_match_status=status,
        plain_text_match_version=match_version,
        plain_text_start_offset=start_offset,
        plain_text_end_offset=end_offset,
        rect_count=1,
    )


class TestValidateUniquePdfOffsets:
    def test_returns_offsets_for_coherent_metadata(self):
        plain_text = "prefix quoted-text suffix"
        highlight = _make_highlight("quoted-text")
        media = _make_media(plain_text)
        start = plain_text.index(highlight.exact)
        end = start + len(highlight.exact)
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=1,
            start_offset=start,
            end_offset=end,
        )

        with patch(
            "nexus.services.context_rendering._load_pdf_page_span",
            return_value=SimpleNamespace(start_offset=0, end_offset=len(plain_text)),
        ):
            offsets = context_rendering._validate_unique_pdf_offsets(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert offsets == (start, end)

    def test_unsupported_match_version_routes_through_coherence_policy(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=2,
            start_offset=7,
            end_offset=18,
        )

        with patch(
            "nexus.services.context_rendering.handle_recoverable_coherence_anomaly",
            return_value=CoherenceFallbackAction.retry_as_pending,
        ) as mock_handle:
            offsets = context_rendering._validate_unique_pdf_offsets(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert offsets is None
        mock_handle.assert_called_once()
        assert mock_handle.call_args.args[0] == CoherenceAnomalyKind.unsupported_match_version


class TestResolvePdfNearbyContext:
    def test_unique_status_uses_persisted_offsets_without_recompute(self):
        plain_text = "prefix quoted-text suffix"
        highlight = _make_highlight("quoted-text")
        media = _make_media(plain_text)
        start = plain_text.index(highlight.exact)
        end = start + len(highlight.exact)
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=1,
            start_offset=start,
            end_offset=end,
        )

        with (
            patch(
                "nexus.services.context_rendering._validate_unique_pdf_offsets",
                return_value=(start, end),
            ),
            patch("nexus.services.context_rendering.compute_match") as mock_compute,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is not None
        assert highlight.exact in context
        mock_compute.assert_not_called()

    def test_unknown_status_uses_coherence_mapping_and_omits_context(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status="legacy_status",
            match_version=1,
            start_offset=None,
            end_offset=None,
        )

        with (
            patch(
                "nexus.services.context_rendering.handle_recoverable_coherence_anomaly",
                return_value=CoherenceFallbackAction.omit_nearby_context,
            ) as mock_handle,
            patch("nexus.services.context_rendering.compute_match") as mock_compute,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is None
        mock_compute.assert_not_called()
        mock_handle.assert_called_once()
        assert mock_handle.call_args.args[0] == CoherenceAnomalyKind.unknown_match_status

    def test_unknown_status_retry_action_falls_through_to_pending_recompute(self):
        plain_text = "prefix quoted-text suffix"
        highlight = _make_highlight("quoted-text")
        media = _make_media(plain_text)
        start = plain_text.index(highlight.exact)
        end = start + len(highlight.exact)
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status="legacy_status",
            match_version=1,
            start_offset=None,
            end_offset=None,
        )

        with (
            patch(
                "nexus.services.context_rendering.handle_recoverable_coherence_anomaly",
                return_value=CoherenceFallbackAction.retry_as_pending,
            ),
            patch("nexus.services.context_rendering._load_pdf_page_span", return_value=None),
            patch(
                "nexus.services.context_rendering.compute_match",
                return_value=MatchResult(
                    status=MatchStatus.unique,
                    match_version=1,
                    start_offset=start,
                    end_offset=end,
                    prefix="",
                    suffix="",
                ),
            ) as mock_compute,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is not None
        assert highlight.exact in context
        mock_compute.assert_called_once()

    def test_pending_matcher_anomaly_degrades_without_blocking(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.pending.value,
            match_version=None,
            start_offset=None,
            end_offset=None,
        )
        anomaly = MatcherAnomaly(MatcherAnomalyKind.page_span_inconsistent, "bad span")

        with (
            patch("nexus.services.context_rendering._load_pdf_page_span", return_value=None),
            patch("nexus.services.context_rendering.compute_match", side_effect=anomaly),
            patch("nexus.services.context_rendering.handle_recoverable_anomaly") as mock_handle,
        ):
            context = context_rendering._resolve_pdf_nearby_context(
                MagicMock(), highlight, media, pdf_anchor
            )

        assert context is None
        mock_handle.assert_called_once()

    def test_pending_unclassified_matcher_exception_blocks_with_internal_error(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.pending.value,
            match_version=None,
            start_offset=None,
            end_offset=None,
        )

        with (
            patch("nexus.services.context_rendering._load_pdf_page_span", return_value=None),
            patch(
                "nexus.services.context_rendering.compute_match", side_effect=RuntimeError("boom")
            ),
            patch(
                "nexus.services.context_rendering.handle_unclassified_exception",
                side_effect=PdfQuoteMatchInternalError("internal"),
            ) as mock_handle,
        ):
            with pytest.raises(QuoteContextBlockingError) as exc_info:
                context_rendering._resolve_pdf_nearby_context(
                    MagicMock(), highlight, media, pdf_anchor
                )

        assert exc_info.value.error_code == ApiErrorCode.E_INTERNAL
        mock_handle.assert_called_once()

    def test_unique_validator_exception_blocks_with_internal_error(self):
        highlight = _make_highlight("quoted-text")
        media = _make_media("prefix quoted-text suffix")
        pdf_anchor = _make_pdf_anchor(
            media_id=media.id,
            status=MatchStatus.unique.value,
            match_version=1,
            start_offset=7,
            end_offset=18,
        )

        with (
            patch(
                "nexus.services.context_rendering._validate_unique_pdf_offsets",
                side_effect=RuntimeError("validator crashed"),
            ),
            patch(
                "nexus.services.context_rendering.handle_coherence_unclassified_exception",
                side_effect=PdfQuoteMatchInternalError("internal"),
            ) as mock_handle,
        ):
            with pytest.raises(QuoteContextBlockingError) as exc_info:
                context_rendering._resolve_pdf_nearby_context(
                    MagicMock(), highlight, media, pdf_anchor
                )

        assert exc_info.value.error_code == ApiErrorCode.E_INTERNAL
        mock_handle.assert_called_once()
