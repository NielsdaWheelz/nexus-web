"""Pure unit tests for library-intelligence helpers and contracts."""

from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.services import run_kit
from nexus.services.artifacts.reducers.library_dossier import (
    LI_REDUCE_INPUT_CHAR_BUDGET,
    _Candidate,
    _GroundedCitation,
    _LiCitationOut,
    _LiSynthesis,
    _map_li_citations,
)

pytestmark = pytest.mark.unit


class TestMapLiCitations:
    def _candidates(self, n: int) -> list[_Candidate]:
        return [
            _Candidate(
                global_index=i,
                media_id=uuid4(),
                evidence_span_id=uuid4(),
                claim_text=f"claim {i}",
                summary_md="s",
            )
            for i in range(n)
        ]

    def test_valid_claim_index_mapped_to_span(self) -> None:
        candidates = self._candidates(3)
        synthesis = _LiSynthesis(
            content_md="Prose [1] and [2].",
            citations=[
                _LiCitationOut(ordinal=1, claim_index=0, role="supports"),
                _LiCitationOut(ordinal=2, claim_index=2, role="context"),
            ],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert grounded == [
            _GroundedCitation(
                ordinal=1,
                role="supports",
                media_id=candidates[0].media_id,
                evidence_span_id=candidates[0].evidence_span_id,
            ),
            _GroundedCitation(
                ordinal=2,
                role="context",
                media_id=candidates[2].media_id,
                evidence_span_id=candidates[2].evidence_span_id,
            ),
        ]

    def test_out_of_range_claim_index_dropped(self) -> None:
        candidates = self._candidates(2)
        synthesis = _LiSynthesis(
            content_md="x",
            citations=[
                _LiCitationOut(ordinal=1, claim_index=0, role="supports"),
                _LiCitationOut(ordinal=2, claim_index=99, role="supports"),
                _LiCitationOut(ordinal=3, claim_index=-1, role="supports"),
            ],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert [citation.ordinal for citation in grounded] == [1]
        assert grounded[0].evidence_span_id == candidates[0].evidence_span_id

    def test_duplicate_ordinal_keeps_first(self) -> None:
        candidates = self._candidates(2)
        synthesis = _LiSynthesis(
            content_md="x",
            citations=[
                _LiCitationOut(ordinal=1, claim_index=0, role="supports"),
                _LiCitationOut(ordinal=1, claim_index=1, role="supports"),
            ],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert len(grounded) == 1
        assert grounded[0].evidence_span_id == candidates[0].evidence_span_id

    def test_unknown_role_falls_back_to_context(self) -> None:
        candidates = self._candidates(1)
        synthesis = _LiSynthesis(
            content_md="x",
            citations=[_LiCitationOut(ordinal=1, claim_index=0, role="nonsense")],
        )
        grounded = _map_li_citations(synthesis, candidates)
        assert grounded[0].role == "context"


class TestRunKitExhaustiveness:
    def test_all_run_kinds_have_channel_and_terminal_set(self) -> None:
        for kind in run_kit.RunStreamKind:
            assert run_kit.notify_channel(kind)
            assert run_kit.terminal_statuses(kind)

    def test_library_intelligence_terminal_set(self) -> None:
        assert run_kit.terminal_statuses(run_kit.RunStreamKind.ArtifactRevision) == frozenset(
            {"ready", "failed"}
        )

    def test_li_channel(self) -> None:
        assert (
            run_kit.notify_channel(run_kit.RunStreamKind.ArtifactRevision)
            == "artifact_revision_events"
        )


class TestSchemaStrictness:
    def test_synthesis_rejects_extra_keys(self) -> None:
        with pytest.raises(ValidationError):
            _LiSynthesis.model_validate({"content_md": "x", "citations": [], "junk": 1})

    def test_reduce_budget_constant(self) -> None:
        assert LI_REDUCE_INPUT_CHAR_BUDGET > 0
