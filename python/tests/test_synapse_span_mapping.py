"""Unit tests for the span-grain synapse candidate mapping (spec §4.2, AC-4).

``_map_candidates`` is a pure function over search results; these tests drive it
directly with synthesized ``content_chunk`` results (no DB, no LLM), covering the
span-preferred / media-fallback mapping, two-span diversity, the per-work cap
(D9), and cross-grain exclusion (F-04).
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from nexus.schemas.search import (
    SearchResultContentChunkOut,
    SearchResultContextRefOut,
    SearchResultSourceOut,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.synapse import (
    SYNAPSE_MAX_CONNECTIONS_PER_WORK,
    _map_candidates,
)

pytestmark = pytest.mark.unit


def _chunk_result(
    *, media_id: UUID, chunk_id: UUID, span_id: UUID | None, title: str = "A Work"
) -> SearchResultContentChunkOut:
    resource_ref = f"content_chunk:{chunk_id}"
    fragment_id = uuid4()
    return SearchResultContentChunkOut(
        type="content_chunk",
        id=chunk_id,
        score=0.9,
        snippet="a <b>resonant</b> passage",
        title=title,
        resource_ref=resource_ref,
        activation={"resourceRef": resource_ref, "kind": "none", "href": None},
        citation_target=f"evidence_span:{span_id}" if span_id is not None else None,
        context_ref=SearchResultContextRefOut(
            type="content_chunk",
            id=chunk_id,
            evidence_span_ids=[span_id] if span_id is not None else [],
        ),
        source_kind="web_article",
        evidence_span_ids=[span_id] if span_id is not None else [],
        source=SearchResultSourceOut(media_id=media_id, media_kind="web_article", title=title),
        citation_label="Section",
        locator={
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": 0,
            "end_offset": 10,
        },
    )


def test_chunk_with_span_maps_to_evidence_span_target() -> None:
    media_id, chunk_id, span_id = uuid4(), uuid4(), uuid4()
    [candidate] = _map_candidates(
        [_chunk_result(media_id=media_id, chunk_id=chunk_id, span_id=span_id)],
        excluded=set(),
    )
    assert candidate.target == ResourceRef(scheme="evidence_span", id=span_id)
    assert candidate.owner_media_id == media_id


def test_chunk_without_span_falls_back_to_media_target() -> None:
    media_id, chunk_id = uuid4(), uuid4()
    [candidate] = _map_candidates(
        [_chunk_result(media_id=media_id, chunk_id=chunk_id, span_id=None)],
        excluded=set(),
    )
    assert candidate.target == ResourceRef(scheme="media", id=media_id)
    assert candidate.owner_media_id == media_id


def test_two_chunks_of_one_work_yield_two_distinct_spans() -> None:
    media_id = uuid4()
    span_a, span_b = uuid4(), uuid4()
    candidates = _map_candidates(
        [
            _chunk_result(media_id=media_id, chunk_id=uuid4(), span_id=span_a),
            _chunk_result(media_id=media_id, chunk_id=uuid4(), span_id=span_b),
        ],
        excluded=set(),
    )
    assert {c.target for c in candidates} == {
        ResourceRef(scheme="evidence_span", id=span_a),
        ResourceRef(scheme="evidence_span", id=span_b),
    }


def test_per_work_cap_limits_spans_of_one_work() -> None:
    media_id = uuid4()
    results = [
        _chunk_result(media_id=media_id, chunk_id=uuid4(), span_id=uuid4()) for _ in range(5)
    ]
    candidates = _map_candidates(results, excluded=set())
    assert len(candidates) == SYNAPSE_MAX_CONNECTIONS_PER_WORK == 2


def test_cross_grain_exclusion_blocks_span_of_excluded_media() -> None:
    # The media is excluded (self/kin/connected/suppressed at media grain); its
    # evidence-span children must not survive (F-04).
    media_id, span_id = uuid4(), uuid4()
    candidates = _map_candidates(
        [_chunk_result(media_id=media_id, chunk_id=uuid4(), span_id=span_id)],
        excluded={ResourceRef(scheme="media", id=media_id)},
    )
    assert candidates == []


def test_span_of_unexcluded_work_survives_when_a_sibling_work_is_excluded() -> None:
    excluded_media, live_media = uuid4(), uuid4()
    live_span = uuid4()
    candidates = _map_candidates(
        [
            _chunk_result(media_id=excluded_media, chunk_id=uuid4(), span_id=uuid4()),
            _chunk_result(media_id=live_media, chunk_id=uuid4(), span_id=live_span),
        ],
        excluded={ResourceRef(scheme="media", id=excluded_media)},
    )
    assert [c.target for c in candidates] == [ResourceRef(scheme="evidence_span", id=live_span)]
