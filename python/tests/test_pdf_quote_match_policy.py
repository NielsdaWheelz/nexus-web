"""Unit tests for PDF quote-match anomaly policy helpers."""

from unittest.mock import patch
from uuid import uuid4

import pytest

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
    PendingWriteOutcome,
    handle_coherence_unclassified_exception,
    handle_recoverable_anomaly,
    handle_recoverable_coherence_anomaly,
    handle_unclassified_exception,
    match_result_to_persistence_fields,
)

pytestmark = pytest.mark.unit


class TestRecoverableAnomaly:
    """test_pr04_pdf_quote_match_policy_maps_recoverable_anomaly_to_pending_write_outcome"""

    def test_returns_pending_outcome(self):
        anomaly = MatcherAnomaly(
            MatcherAnomalyKind.page_span_inconsistent,
            "test detail",
        )
        outcome = handle_recoverable_anomaly(
            anomaly,
            highlight_id=uuid4(),
            media_id=uuid4(),
            page_number=1,
            path="test_write",
        )

        assert isinstance(outcome, PendingWriteOutcome)
        assert outcome.match_status == "pending"
        assert outcome.match_version is None
        assert outcome.start_offset is None
        assert outcome.end_offset is None
        assert outcome.prefix == ""
        assert outcome.suffix == ""


class TestUnclassifiedException:
    """test_pr04_pdf_quote_match_policy_raises_internal_for_unclassified_matcher_exception"""

    def test_raises_internal_error(self):
        exc = RuntimeError("unexpected bug")

        with pytest.raises(PdfQuoteMatchInternalError) as exc_info:
            handle_unclassified_exception(
                exc,
                highlight_id=uuid4(),
                media_id=uuid4(),
                page_number=1,
                path="test_write",
            )

        assert "unclassified" in str(exc_info.value).lower()


class TestCanonicalEventSchema:
    """test_pr04_pdf_quote_match_policy_emits_canonical_pdf_quote_match_anomaly_event_with_required_fields"""

    def test_recoverable_event_fields(self):
        anomaly = MatcherAnomaly(
            MatcherAnomalyKind.page_span_offset_out_of_range,
            "offsets too large",
        )

        with patch("nexus.services.pdf_quote_match_policy.logger") as mock_logger:
            handle_recoverable_anomaly(
                anomaly,
                highlight_id=uuid4(),
                media_id=uuid4(),
                page_number=5,
                path="test_path",
            )

            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert call_args[0][0] == "pdf_quote_match_anomaly"
            kwargs = call_args[1]
            assert kwargs["anomaly_kind"] == "page_span_offset_out_of_range"
            assert kwargs["classification"] == "recoverable"
            assert kwargs["page_number"] == 5


class TestNoContentLogging:
    """test_pr04_pdf_quote_match_policy_omits_raw_document_text_and_unsalted_text_hashes_from_anomaly_event"""

    def test_no_raw_text_in_recoverable_event(self):
        anomaly = MatcherAnomaly(
            MatcherAnomalyKind.page_span_inconsistent,
            "detail with secret text content",
        )

        with patch("nexus.services.pdf_quote_match_policy.logger") as mock_logger:
            handle_recoverable_anomaly(
                anomaly,
                highlight_id=uuid4(),
                media_id=uuid4(),
                page_number=1,
                path="test",
            )

            call_kwargs = mock_logger.warning.call_args[1]
            all_values = str(call_kwargs)
            assert "secret text content" not in all_values
            assert "detail_length" in call_kwargs


class TestExceptionSanitization:
    """test_pr04_pdf_quote_match_policy_sanitizes_exception_message_to_avoid_document_text_leakage"""

    def test_exception_message_not_in_event(self):
        exc = RuntimeError("this contains user document text that should not leak")

        with patch("nexus.services.pdf_quote_match_policy.logger") as mock_logger:
            with pytest.raises(PdfQuoteMatchInternalError):
                handle_unclassified_exception(
                    exc,
                    highlight_id=uuid4(),
                    media_id=uuid4(),
                    page_number=1,
                    path="test",
                )

            call_kwargs = mock_logger.error.call_args[1]
            all_values = str(call_kwargs)
            assert "user document text" not in all_values
            assert call_kwargs["exception_type"] == "RuntimeError"


class TestRecoverableCoherenceAnomaly:
    def test_retry_as_pending_action_for_offset_anomaly(self):
        action = handle_recoverable_coherence_anomaly(
            CoherenceAnomalyKind.offsets_out_of_range,
            highlight_id=uuid4(),
            media_id=uuid4(),
            page_number=2,
            match_status="unique",
            match_version=1,
            path="test_context_render",
        )
        assert action == CoherenceFallbackAction.retry_as_pending

    def test_unknown_match_status_maps_to_omit_action(self):
        action = handle_recoverable_coherence_anomaly(
            CoherenceAnomalyKind.unknown_match_status,
            highlight_id=uuid4(),
            media_id=uuid4(),
            page_number=2,
            match_status="legacy_status",
            match_version=1,
            path="test_context_render",
        )
        assert action == CoherenceFallbackAction.omit_nearby_context


class TestCoherenceCanonicalEventSchema:
    def test_recoverable_event_fields(self):
        with patch("nexus.services.pdf_quote_match_policy.logger") as mock_logger:
            handle_recoverable_coherence_anomaly(
                CoherenceAnomalyKind.status_offsets_inconsistent,
                highlight_id=uuid4(),
                media_id=uuid4(),
                page_number=3,
                match_status="unique",
                match_version=1,
                path="test_context_render",
            )

            mock_logger.warning.assert_called_once()
            call_args = mock_logger.warning.call_args
            assert call_args[0][0] == "pdf_quote_context_coherence_anomaly"
            kwargs = call_args[1]
            assert kwargs["anomaly_kind"] == "status_offsets_inconsistent"
            assert kwargs["classification"] == "recoverable"
            assert kwargs["fallback_action"] == "retry_as_pending"
            assert kwargs["page_number"] == 3


class TestCoherenceExceptionSanitization:
    def test_exception_message_not_in_event(self):
        exc = RuntimeError("this contains user document text that should not leak")

        with patch("nexus.services.pdf_quote_match_policy.logger") as mock_logger:
            with pytest.raises(PdfQuoteMatchInternalError):
                handle_coherence_unclassified_exception(
                    exc,
                    highlight_id=uuid4(),
                    media_id=uuid4(),
                    page_number=4,
                    match_status="unique",
                    match_version=1,
                    path="test_context_render",
                )

            call_kwargs = mock_logger.error.call_args[1]
            all_values = str(call_kwargs)
            assert "user document text" not in all_values
            assert call_kwargs["exception_type"] == "RuntimeError"


class TestMatchResultPersistence:
    def test_unique_match_fields(self):
        result = MatchResult(
            status=MatchStatus.unique,
            match_version=1,
            start_offset=10,
            end_offset=20,
            prefix="pre",
            suffix="suf",
        )
        fields = match_result_to_persistence_fields(result)
        assert fields["plain_text_match_status"] == "unique"
        assert fields["plain_text_match_version"] == 1
        assert fields["plain_text_start_offset"] == 10
        assert fields["plain_text_end_offset"] == 20
