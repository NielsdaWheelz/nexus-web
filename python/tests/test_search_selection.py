"""Search-owned app-search candidate selection tests."""

from uuid import uuid4

import pytest

from nexus.services.retrieval_citation import RetrievalCitation
from nexus.services.search.selection import rerank_app_search_candidates

pytestmark = pytest.mark.unit


def _citation(
    result_type: str,
    *,
    score: float,
    text: str,
    media_id: str | None = None,
    locator: dict | None = None,
    source_id: str | None = None,
) -> RetrievalCitation:
    source_id = source_id or str(uuid4())
    evidence_span_id = str(uuid4()) if result_type == "content_chunk" else None
    return RetrievalCitation(
        result_type=result_type,
        source_id=source_id,
        title=text,
        source_label=None,
        snippet=text,
        deep_link=f"/reader/{source_id}",
        citation_target=f"{result_type}:{source_id}",
        citation_label=None,
        locator=locator
        if locator is not None
        else {"type": "web_text_offsets"}
        if result_type == "content_chunk"
        else None,
        context_ref={"type": result_type, "id": source_id},
        evidence_span_id=evidence_span_id,
        media_id=media_id,
        media_kind="web_article" if media_id else None,
        score=score,
    )


def test_app_search_selection_prefers_passage_over_matching_container() -> None:
    media_id = str(uuid4())
    container = _citation("media", score=0.99, text="exact passage needle", media_id=media_id)
    passage = _citation(
        "content_chunk",
        score=0.6,
        text="exact passage needle",
        media_id=media_id,
    )

    selected, trace = rerank_app_search_candidates("exact passage needle", [container, passage])

    assert selected == [passage, container]
    assert trace[0]["reason"] == "moved_up_exact_passage"


def test_app_search_selection_diversifies_broad_candidates() -> None:
    first_source = str(uuid4())
    second_source = str(uuid4())
    first = _citation("content_chunk", score=1.0, text="attention", media_id=first_source)
    crowded = _citation("content_chunk", score=0.99, text="attention", media_id=first_source)
    other = _citation("content_chunk", score=0.97, text="patterns", media_id=second_source)

    selected, trace = rerank_app_search_candidates("attention patterns", [first, crowded, other])

    assert selected == [first, other, crowded]
    assert trace[1]["reason"] == "moved_up_diverse_source"
    assert trace[2]["source_penalty"] > 0


def test_app_search_selection_diversifies_non_phrase_full_lexical_matches() -> None:
    first_source = str(uuid4())
    second_source = str(uuid4())
    first = _citation(
        "content_chunk",
        score=1.0,
        text="attention and patterns",
        media_id=first_source,
    )
    crowded = _citation(
        "content_chunk",
        score=0.99,
        text="patterns plus attention",
        media_id=first_source,
    )
    other = _citation(
        "content_chunk",
        score=0.97,
        text="attention through patterns",
        media_id=second_source,
    )

    selected, trace = rerank_app_search_candidates("attention patterns", [first, crowded, other])

    assert selected == [first, other, crowded]
    assert trace[1]["reason"] == "moved_up_diverse_source"
    assert trace[2]["source_penalty"] > 0


def test_app_search_selection_penalizes_duplicate_sections() -> None:
    crowded_source = str(uuid4())
    first = _citation(
        "content_chunk",
        score=1.0,
        text="attention and patterns",
        media_id=crowded_source,
        locator={"type": "web_text_offsets", "fragment_id": "section-1"},
    )
    crowded = _citation(
        "content_chunk",
        score=0.99,
        text="patterns plus attention",
        media_id=crowded_source,
        locator={"type": "web_text_offsets", "fragment_id": "section-1"},
    )
    other = _citation(
        "content_chunk",
        score=0.92,
        text="attention through patterns",
        media_id=str(uuid4()),
        locator={"type": "web_text_offsets", "fragment_id": "section-2"},
    )

    selected, trace = rerank_app_search_candidates("attention patterns", [first, crowded, other])

    assert selected == [first, other, crowded]
    assert trace[2]["section_penalty"] > 0


def test_app_search_selection_keeps_exact_lookup_concentrated() -> None:
    first_source = str(uuid4())
    second_source = str(uuid4())
    first = _citation("content_chunk", score=1.0, text="very exact phrase", media_id=first_source)
    second = _citation("content_chunk", score=0.99, text="very exact phrase", media_id=first_source)
    other = _citation("content_chunk", score=0.98, text="very phrase", media_id=second_source)

    selected, trace = rerank_app_search_candidates("very exact phrase", [first, second, other])

    assert selected == [first, second, other]
    assert [item["reason"] for item in trace] == ["kept_order", "kept_order", "kept_order"]


def test_app_search_selection_trace_has_no_generated_guidance_placeholders() -> None:
    first = _citation("content_chunk", score=1.0, text="attention")
    selected, trace = rerank_app_search_candidates("attention", [first])

    assert selected == [first]
    assert "guidance_bonus" not in trace[0]
    assert "guidance_revision_ids" not in trace[0]
