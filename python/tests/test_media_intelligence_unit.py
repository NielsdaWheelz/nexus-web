"""Pure unit tests for per-media intelligence helpers and contracts."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.services.media_intelligence import (
    MediaUnitClaimOut,
    MediaUnitSynthesis,
    _Candidate,
    _map_claims_to_spans,
)

pytestmark = pytest.mark.unit


class TestMapClaimsToSpans:
    def _candidates(self, n: int) -> list[_Candidate]:
        return [_Candidate(evidence_span_id=uuid4(), text=f"chunk {i}") for i in range(n)]

    def test_valid_index_kept_with_right_span(self) -> None:
        candidates = self._candidates(3)
        synthesis = MediaUnitSynthesis(
            summary_md="s",
            claims=[
                MediaUnitClaimOut(claim_text="a", candidate_index=0),
                MediaUnitClaimOut(claim_text="b", candidate_index=2),
            ],
        )
        grounded = _map_claims_to_spans(synthesis, candidates)
        assert grounded == [
            ("a", candidates[0].evidence_span_id, 0),
            ("b", candidates[2].evidence_span_id, 1),
        ]

    def test_out_of_range_index_dropped(self) -> None:
        candidates = self._candidates(2)
        synthesis = MediaUnitSynthesis(
            summary_md="s",
            claims=[
                MediaUnitClaimOut(claim_text="keep", candidate_index=1),
                MediaUnitClaimOut(claim_text="drop_high", candidate_index=5),
                MediaUnitClaimOut(claim_text="drop_neg", candidate_index=-1),
            ],
        )
        grounded = _map_claims_to_spans(synthesis, candidates)
        assert grounded == [("keep", candidates[1].evidence_span_id, 0)]

    def test_ordinals_reassigned_over_survivors(self) -> None:
        candidates = self._candidates(2)
        synthesis = MediaUnitSynthesis(
            summary_md="s",
            claims=[
                MediaUnitClaimOut(claim_text="x", candidate_index=9),
                MediaUnitClaimOut(claim_text="y", candidate_index=0),
                MediaUnitClaimOut(claim_text="z", candidate_index=1),
            ],
        )
        grounded = _map_claims_to_spans(synthesis, candidates)
        assert [(text, ordinal) for text, _span, ordinal in grounded] == [
            ("y", 0),
            ("z", 1),
        ]


class TestMediaUnitSynthesisSchema:
    def test_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            MediaUnitSynthesis.model_validate({"summary_md": "s", "claims": [], "unexpected": True})

    def test_rejects_missing_summary(self) -> None:
        with pytest.raises(ValidationError):
            MediaUnitSynthesis.model_validate({"claims": []})

    def test_claim_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            MediaUnitClaimOut.model_validate({"claim_text": "a", "candidate_index": 0, "junk": 1})
