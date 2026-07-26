"""Pure contracts for chat citation canonicalization and publication inputs."""

from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.services import chat_run_citations
from nexus.services.chat_run_citations import (
    CitationCandidate,
    _citation_target_ref,
    canonicalize_chat_citations,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot

pytestmark = pytest.mark.unit


def _candidates(count: int) -> tuple[CitationCandidate, ...]:
    return tuple(
        CitationCandidate(
            candidate_ordinal=ordinal,
            retrieval_id=uuid4(),
            target=ResourceRef(scheme="evidence_span", id=uuid4()),
            snapshot=CitationSnapshot(title=f"Source {ordinal}"),
        )
        for ordinal in range(1, count + 1)
    )


def test_public_api_surface() -> None:
    for name in (
        "number_tool_citation_candidates",
        "canonicalize_chat_citations",
        "persist_attached_citations",
        "persist_read_evidence_candidate",
        "publish_chat_citations",
        "prune_tool_call_retrievals",
    ):
        assert callable(getattr(chat_run_citations, name)), name


def test_sparse_candidate_marker_is_canonicalized_to_first_final_ordinal() -> None:
    result = canonicalize_chat_citations("Answer [3].", _candidates(3))

    assert result.kind == "Published"
    assert result.content_md == "Answer [1]."
    assert result.citation_count == 1
    assert [
        (citation.candidate_ordinal, citation.final_ordinal)
        for citation in result.citations
    ] == [(3, 1)]


def test_first_use_order_and_repeated_markers_are_stable() -> None:
    result = canonicalize_chat_citations(
        "Fourth [4], second [2], fourth again [4].",
        _candidates(4),
    )

    assert result.kind == "Published"
    assert result.content_md == "Fourth [1], second [2], fourth again [1]."
    assert [
        (citation.candidate_ordinal, citation.final_ordinal)
        for citation in result.citations
    ] == [(4, 1), (2, 2)]


def test_no_markers_is_a_valid_publication_with_no_citations() -> None:
    result = canonicalize_chat_citations("Answer without references.", _candidates(3))

    assert result.kind == "Published"
    assert result.content_md == "Answer without references."
    assert result.citation_count == 0
    assert result.citations == ()


@pytest.mark.parametrize(
    ("content_md", "detail", "expected"),
    [
        (
            "Known [1], unknown [4].",
            "unknown_markers=[4]",
            "Known , unknown .",
        ),
        (
            "Linked [2](https://example.com) and plain [1].",
            "linked_markers=[2]",
            "Linked  and plain .",
        ),
    ],
)
def test_rejected_generated_markers_degrade_to_marker_free_prose(
    content_md: str,
    detail: str,
    expected: str,
) -> None:
    result = canonicalize_chat_citations(content_md, _candidates(3))

    assert result.kind == "Degraded"
    assert result.content_md == expected
    assert result.warning_code == "CitationsUnavailable"
    assert result.detail == detail
    assert result.citation_count == 0


def test_candidate_ordinals_must_be_dense_and_unique() -> None:
    candidates = (
        CitationCandidate(
            candidate_ordinal=2,
            retrieval_id=uuid4(),
            target=ResourceRef(scheme="evidence_span", id=uuid4()),
            snapshot=CitationSnapshot(),
        ),
    )

    with pytest.raises(AssertionError, match="dense and unique"):
        canonicalize_chat_citations("Answer [2].", candidates)


def test_citation_target_ref_resolves_citable_schemes() -> None:
    for scheme in (
        "evidence_span",
        "content_chunk",
        "media",
        "highlight",
        "fragment",
        "note_block",
        "message",
        "reader_apparatus_item",
    ):
        uri = f"{scheme}:{uuid4()}"
        resolved = _citation_target_ref(
            {"result_ref": {"citation_target": uri}}
        )
        assert resolved is not None
        assert resolved.uri == uri

    assert _citation_target_ref({"result_ref": {"citation_target": None}}) is None
    assert _citation_target_ref({"result_ref": {}}) is None


def test_citation_target_ref_rejects_malformed_or_uncitable_targets() -> None:
    for raw_target in ("not-a-ref", "library:not-a-uuid", f"library:{uuid4()}"):
        with pytest.raises(AssertionError):
            _citation_target_ref(
                {"result_ref": {"citation_target": raw_target}}
            )
