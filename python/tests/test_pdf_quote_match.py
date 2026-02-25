"""Pure unit tests for deterministic PDF quote-match (plain_text_match_version=1)."""

import pytest

from nexus.services.pdf_quote_match import (
    MatcherAnomaly,
    MatcherAnomalyKind,
    MatchStatus,
    compute_match,
)


class TestPageScopedUniqueMatch:
    """test_pr04_pdf_quote_match_v1_page_scoped_unique_match_derives_prefix_suffix"""

    def test_unique_match_with_context(self):
        plain_text = "prefix text hello world suffix text"
        # page span covers: "hello world"
        page_start = 12
        page_end = 23

        result = compute_match(
            exact="hello world",
            page_number=1,
            plain_text=plain_text,
            page_span_start=page_start,
            page_span_end=page_end,
        )

        assert result.status == MatchStatus.unique
        assert result.match_version == 1
        assert result.start_offset == 12
        assert result.end_offset == 23
        assert result.prefix != ""
        assert result.suffix != ""

    def test_unique_match_at_text_start(self):
        plain_text = "hello world rest of text"
        result = compute_match(
            exact="hello world",
            page_number=1,
            plain_text=plain_text,
            page_span_start=0,
            page_span_end=11,
        )
        assert result.status == MatchStatus.unique
        assert result.prefix == ""
        assert result.suffix != ""


class TestAmbiguousOrNoMatch:
    """test_pr04_pdf_quote_match_v1_ambiguous_or_no_match_returns_empty_prefix_suffix"""

    def test_ambiguous_match(self):
        plain_text = "the the the"
        result = compute_match(
            exact="the",
            page_number=1,
            plain_text=plain_text,
            page_span_start=0,
            page_span_end=11,
        )
        assert result.status == MatchStatus.ambiguous
        assert result.start_offset is None
        assert result.end_offset is None
        assert result.prefix == ""
        assert result.suffix == ""

    def test_no_match(self):
        plain_text = "hello world"
        result = compute_match(
            exact="foobar",
            page_number=1,
            plain_text=plain_text,
            page_span_start=0,
            page_span_end=11,
        )
        assert result.status == MatchStatus.no_match
        assert result.prefix == ""
        assert result.suffix == ""


class TestEmptyExact:
    def test_empty_exact(self):
        result = compute_match(
            exact="",
            page_number=1,
            plain_text="some text",
            page_span_start=0,
            page_span_end=9,
        )
        assert result.status == MatchStatus.empty_exact
        assert result.match_version == 1
        assert result.start_offset is None


class TestFallbackBehavior:
    """test_pr04_pdf_quote_match_v1_fallbacks_only_when_page_span_unavailable"""

    def test_no_fallback_when_page_span_present_and_no_match(self):
        plain_text = "page1text target page2text"
        result = compute_match(
            exact="target",
            page_number=1,
            plain_text=plain_text,
            page_span_start=0,
            page_span_end=9,  # only "page1text"
        )
        assert result.status == MatchStatus.no_match

    def test_global_fallback_when_page_span_unavailable(self):
        plain_text = "some target text"
        result = compute_match(
            exact="target",
            page_number=1,
            plain_text=plain_text,
            page_span_start=None,
            page_span_end=None,
        )
        assert result.status == MatchStatus.unique
        assert result.start_offset == 5
        assert result.end_offset == 11


class TestMatcherAnomaly:
    """test_pr04_pdf_quote_match_exposes_typed_recoverable_anomaly_classification_without_logging"""

    def test_negative_offsets_raise_anomaly(self):
        with pytest.raises(MatcherAnomaly) as exc_info:
            compute_match(
                exact="hello",
                page_number=1,
                plain_text="hello world",
                page_span_start=-1,
                page_span_end=5,
            )
        assert exc_info.value.kind == MatcherAnomalyKind.page_span_offset_out_of_range

    def test_offsets_exceed_text_length(self):
        with pytest.raises(MatcherAnomaly) as exc_info:
            compute_match(
                exact="hello",
                page_number=1,
                plain_text="hello world",
                page_span_start=0,
                page_span_end=999,
            )
        assert exc_info.value.kind == MatcherAnomalyKind.page_span_offset_out_of_range

    def test_start_greater_than_end(self):
        with pytest.raises(MatcherAnomaly) as exc_info:
            compute_match(
                exact="hello",
                page_number=1,
                plain_text="hello world",
                page_span_start=5,
                page_span_end=2,
            )
        assert exc_info.value.kind == MatcherAnomalyKind.page_span_inconsistent
