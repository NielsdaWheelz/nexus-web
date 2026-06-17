"""Unit tests for generated citation marker parity."""

from uuid import uuid4

import pytest

from nexus.errors import InvalidRequestError
from nexus.services.resource_graph.citations import validate_generated_markdown_citations
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationInput, CitationSnapshot

pytestmark = pytest.mark.unit

_SNAPSHOT = CitationSnapshot(title="Source", excerpt="Evidence")


def _citation(ordinal: int) -> CitationInput:
    return CitationInput(
        target=ResourceRef(scheme="evidence_span", id=uuid4()),
        ordinal=ordinal,
        kind="supports",
        snapshot=_SNAPSHOT,
    )


def test_generated_markdown_citations_accept_exact_dense_markers() -> None:
    validate_generated_markdown_citations(
        "Overview [1] and another mention [1]. More detail [2].",
        [_citation(1), _citation(2)],
    )


def test_generated_markdown_citations_reject_extra_visible_marker() -> None:
    with pytest.raises(InvalidRequestError, match="markers=\\[1, 2\\], citations=\\[1\\]"):
        validate_generated_markdown_citations(
            "Grounded [1], orphaned [2].",
            [_citation(1)],
        )


def test_generated_markdown_citations_reject_missing_visible_marker() -> None:
    with pytest.raises(InvalidRequestError, match="markers=\\[1\\], citations=\\[1, 2\\]"):
        validate_generated_markdown_citations(
            "Only one marker [1].",
            [_citation(1), _citation(2)],
        )


def test_generated_markdown_citations_reject_linked_marker_text() -> None:
    with pytest.raises(InvalidRequestError, match="linked_markers=\\[1\\]"):
        validate_generated_markdown_citations(
            "Linked marker [1](https://example.com).",
            [_citation(1)],
        )


def test_generated_markdown_citations_reject_non_dense_citation_inputs() -> None:
    with pytest.raises(InvalidRequestError, match="dense 1..2"):
        validate_generated_markdown_citations(
            "Markers [1] and [3].",
            [_citation(1), _citation(3)],
        )
