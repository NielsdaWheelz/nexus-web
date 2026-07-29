"""Unit contract for mixed-type Search score ordering."""

from dataclasses import dataclass
from uuid import UUID

import pytest

from nexus.services.search.candidates import rank_candidates
from nexus.services.search.results import _SearchScore

pytestmark = pytest.mark.unit


@dataclass
class _Candidate:
    name: str
    result_type: str
    id: UUID
    score: _SearchScore


def _candidate(name: str, result_type: str, ordinal: int, raw: float = 1.0) -> _Candidate:
    return _Candidate(
        name=name,
        result_type=result_type,
        id=UUID(int=ordinal),
        score=_SearchScore(raw=raw),
    )


def test_mixed_public_types_normalize_before_weighting_and_project_to_unit_range() -> None:
    fixture = [
        _candidate("media-low", "media", 11, raw=1),
        _candidate("conversation", "conversation", 10),
        _candidate("reader-apparatus", "reader_apparatus_item", 9),
        _candidate("fragment", "fragment", 8),
        _candidate("content-chunk", "content_chunk", 7),
        _candidate("evidence-span", "evidence_span", 6),
        _candidate("note", "note_block", 5),
        _candidate("document", "page", 4),
        _candidate("highlight", "highlight", 3),
        _candidate("contributor", "contributor", 2),
        _candidate("media-high", "media", 1, raw=2),
    ]

    ranked = rank_candidates(fixture)

    assert [candidate.name for candidate in ranked] == [
        "media-high",
        "contributor",
        "highlight",
        "document",
        "note",
        "evidence-span",
        "content-chunk",
        "fragment",
        "reader-apparatus",
        "conversation",
        "media-low",
    ]
    assert [candidate.score.normalized for candidate in ranked] == pytest.approx(
        [
            1,
            1.25 / 1.3,
            1.25 / 1.3,
            1.2 / 1.3,
            1.2 / 1.3,
            1.15 / 1.3,
            1.1 / 1.3,
            1.1 / 1.3,
            1.1 / 1.3,
            0.95 / 1.3,
            0,
        ]
    )
    assert all(0 <= candidate.score.normalized <= 1 for candidate in ranked)
