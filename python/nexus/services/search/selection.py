"""Deterministic app-search candidate selection."""

from __future__ import annotations

import re
from typing import Any

from nexus.services.retrieval_citation import RetrievalCitation

APP_SEARCH_SELECTION_STRATEGY = "app_search_deterministic_selection"
APP_SEARCH_SELECTION_VERSION = "v1"

_PASSAGE_TYPES = {
    "content_chunk",
    "evidence_span",
    "fragment",
    "highlight",
    "note_block",
    "reader_apparatus_item",
    "message",
}
_CONTAINER_TYPES = {
    "media",
    "episode",
    "video",
    "podcast",
    "page",
    "conversation",
    "contributor",
}


def rerank_app_search_candidates(
    query: str,
    citations: list[RetrievalCitation],
) -> tuple[list[RetrievalCitation], list[dict[str, Any]]]:
    """Return citations ordered for prompt evidence selection."""
    phrase = " ".join(query.lower().split())
    query_terms = set(re.findall(r"[a-z0-9]+", phrase))
    query_terms = {term for term in query_terms if len(term) >= 2}

    remaining = []
    for index, citation in enumerate(citations):
        text = _searchable_text(citation)
        lexical = _lexical_score(text, query_terms)
        phrase_match = bool(phrase and phrase in text)
        type_bonus = _type_bonus(citation.result_type)
        citation_quality = _citation_quality(citation)
        remaining.append(
            {
                "citation": citation,
                "from": index,
                "source": _source_key(citation),
                "section": _section_key(citation),
                "base": (
                    float(citation.score or 0.0)
                    + lexical * 0.45
                    + (0.35 if phrase_match else 0.0)
                    + type_bonus
                    + citation_quality
                ),
                "lexical": lexical,
                "phrase": phrase_match,
                "type_bonus": type_bonus,
                "citation_quality": citation_quality,
            }
        )
    selected: list[dict[str, Any]] = []
    selected_by_source: dict[str, int] = {}
    selected_by_section: dict[str, int] = {}

    while remaining:
        best_index = 0
        best_score = float("-inf")
        best_source_penalty = 0.0
        best_section_penalty = 0.0
        for index, item in enumerate(remaining):
            source_penalty = 0.22 * selected_by_source.get(str(item["source"]), 0)
            section_penalty = 0.12 * selected_by_section.get(str(item["section"]), 0)
            score = float(item["base"]) - (
                0.0 if item["phrase"] else source_penalty + section_penalty
            )
            if (score, -int(item["from"])) > (best_score, -int(remaining[best_index]["from"])):
                best_index = index
                best_score = score
                best_source_penalty = source_penalty
                best_section_penalty = section_penalty
        item = remaining.pop(best_index)
        item["final"] = best_score
        item["source_penalty"] = best_source_penalty
        item["section_penalty"] = best_section_penalty
        selected.append(item)
        selected_by_source[str(item["source"])] = selected_by_source.get(str(item["source"]), 0) + 1
        selected_by_section[str(item["section"])] = (
            selected_by_section.get(str(item["section"]), 0) + 1
        )

    trace: list[dict[str, Any]] = []
    for to_index, item in enumerate(selected):
        citation = item["citation"]
        moved_by = int(item["from"]) - to_index
        reason = "kept_order"
        if moved_by > 0:
            reason = (
                "moved_up_exact_passage"
                if item["phrase"] and citation.result_type in _PASSAGE_TYPES
                else "moved_up_exact_match"
                if item["phrase"]
                else "moved_up_diverse_source"
            )
        elif moved_by < 0:
            reason = "moved_down_source_or_section_diversity"
        trace.append(
            {
                "from": item["from"],
                "to": to_index,
                "result_type": citation.result_type,
                "source_id": citation.source_id,
                "source": item["source"],
                "section": item["section"],
                "score": citation.score,
                "selection_score": round(float(item["final"]), 4),
                "lexical": round(float(item["lexical"]), 4),
                "phrase": item["phrase"],
                "type_bonus": item["type_bonus"],
                "citation_quality": item["citation_quality"],
                "source_penalty": round(float(item["source_penalty"]), 4),
                "section_penalty": round(float(item["section_penalty"]), 4),
                "reason": reason,
            }
        )
    return [item["citation"] for item in selected], trace


def _lexical_score(text: str, query_terms: set[str]) -> float:
    if not query_terms:
        return 0.0
    text_terms = set(re.findall(r"[a-z0-9]+", text))
    return len(query_terms & text_terms) / len(query_terms)


def _searchable_text(citation: RetrievalCitation) -> str:
    return "\n".join(
        value.lower()
        for value in (
            citation.title,
            citation.source_label,
            citation.snippet,
            citation.citation_label,
        )
        if value
    )


def _type_bonus(result_type: str) -> float:
    if result_type in _PASSAGE_TYPES:
        return 0.3
    if result_type in _CONTAINER_TYPES:
        return -0.05
    return 0.0


def _citation_quality(citation: RetrievalCitation) -> float:
    quality = 0.0
    if citation.citation_target:
        quality += 0.1
    if citation.locator:
        quality += 0.1
    if citation.evidence_span_id:
        quality += 0.05
    return quality


def _source_key(citation: RetrievalCitation) -> str:
    if citation.media_id:
        return f"media:{citation.media_id}"
    if citation.result_type == "message":
        conversation_id = citation.result_ref.get("conversation_id")
        if conversation_id:
            return f"conversation:{conversation_id}"
        if isinstance(citation.locator, dict) and citation.locator.get("conversation_id"):
            return f"conversation:{citation.locator['conversation_id']}"
    return f"{citation.result_type}:{citation.source_id}"


def _section_key(citation: RetrievalCitation) -> str:
    if isinstance(citation.locator, dict):
        locator = citation.locator
        locator_type = locator.get("type")
        if locator_type in {"web_text_offsets", "epub_fragment_offsets"}:
            section_id = locator.get("section_id") or locator.get("fragment_id")
            if section_id:
                return f"{_source_key(citation)}:{section_id}"
        if locator_type == "pdf_page_geometry":
            return f"pdf_page:{locator.get('media_id')}:{locator.get('page_number')}"
        if locator_type == "note_block_offsets":
            return f"note_block:{locator.get('block_id')}"
        if locator_type == "message_offsets":
            return f"message:{locator.get('message_id')}"
        if locator_type in {"transcript_time_range", "audio_time_range", "video_time_range"}:
            return f"{locator_type}:{locator.get('media_id')}:{int(locator.get('t_start_ms') or 0) // 60000}"
        if locator_type == "external_url":
            return str(locator.get("url") or locator)
    return str(citation.source_label or citation.evidence_span_id or _source_key(citation))
