"""The one validated ``message_retrievals`` writer.

Turns a ``SearchResultOut`` into a ``RetrievalCitation`` whose
``result_ref``/``locator`` pass the strict retrieval validators, and inserts it
as a retrieval row. ``app_search``, ``web_search``, attached ``<resources>`` and
``read_resource`` evidence all go through it, so the validator-sensitive shape
lives in exactly one place. Candidate numbering and citation publication are
Chat's, not this module's.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.schemas.search import SearchResultOut

STRICT_LOCATOR_RESULT_TYPES = frozenset(
    {
        "content_chunk",
        "fragment",
        "note_block",
        "highlight",
        "message",
        "evidence_span",
        "reader_apparatus_item",
    }
)


@dataclass(slots=True)
class RetrievalCitation:
    """Compact model/frontend citation for a retrieved or attached result."""

    result_type: str
    source_id: str
    title: str
    source_label: str | None
    snippet: str
    deep_link: str
    citation_target: str | None
    citation_label: str | None
    locator: dict[str, Any] | None
    context_ref: dict[str, Any]
    evidence_span_id: str | None
    media_id: str | None
    media_kind: str | None
    score: float | None
    contributors: list[dict[str, Any]] = field(default_factory=list)
    filters: dict[str, Any] = field(default_factory=dict)
    result_ref: dict[str, Any] = field(default_factory=dict)
    selected: bool = False

    def result_ref_json(self) -> dict[str, Any]:
        if self.result_type == "web_result":
            # Web rows carry the provider payload verbatim (url/source/rank/…);
            # web_search builds it already validator-shaped.
            return self.result_ref
        common: dict[str, Any] = {
            "type": self.result_type,
            "id": self.source_id,
            "result_type": self.result_type,
            "source_id": self.source_id,
            "title": self.title,
            "source_label": self.source_label,
            "snippet": self.snippet,
            "deep_link": self.deep_link,
            "citation_target": self.citation_target,
            "context_ref": self.context_ref,
            "locator": self.locator,
            "media_id": self.media_id,
            "media_kind": self.media_kind,
            "score": self.score,
            "selected": self.selected,
        }
        match self.result_type:
            case "media" | "episode" | "video" | "page":
                return common
            case "podcast":
                return {**common, "contributors": self.contributors}
            case "content_chunk":
                return {
                    **common,
                    "source_kind": self.result_ref["source_kind"],
                    "citation_label": self.citation_label,
                    "evidence_span_id": self.evidence_span_id,
                    "evidence_span_ids": self.result_ref.get("evidence_span_ids", []),
                }
            case "fragment":
                return {**common, "citation_label": self.citation_label}
            case "contributor":
                return {**common, "contributor_handle": self.result_ref["contributor_handle"]}
            case "note_block":
                return {
                    **common,
                    "body_text": self.result_ref["body_text"],
                    "highlight_excerpt": self.result_ref.get("highlight_excerpt"),
                }
            case "highlight":
                return {
                    **common,
                    "color": self.result_ref["color"],
                    "exact": self.result_ref["exact"],
                    "citation_label": self.citation_label,
                }
            case "message":
                return {
                    **common,
                    "conversation_id": self.result_ref["conversation_id"],
                    "seq": self.result_ref["seq"],
                }
            case "evidence_span":
                return {
                    **common,
                    "citation_label": self.citation_label or "",
                    "evidence_span_id": self.evidence_span_id or self.source_id,
                    "media_id": self.media_id or self.result_ref.get("media_id"),
                }
            case "reader_apparatus_item":
                return {**common, "apparatus_kind": self.result_ref["apparatus_kind"]}
            case "conversation":
                return {**common, "locator": None, "media_id": None, "media_kind": None}
            case "artifact":
                return {
                    **common,
                    "revision_id": self.result_ref["revision_id"],
                    "subject_ref": self.result_ref["subject_ref"],
                }
            case _:
                raise ValueError(f"Unsupported result type: {self.result_type}")


def citation_from_search_result(
    result: SearchResultOut,
    *,
    filters: dict[str, Any],
) -> RetrievalCitation:
    payload = result.model_dump(mode="json")
    result_type = str(payload["type"])
    if result_type == "web_result":
        source_id = str(payload["source_id"])
        payload = {
            **payload,
            "id": source_id,
            "source_id": source_id,
            "context_ref": {"type": "web_result", "id": source_id},
        }
    activation = payload["activation"]
    deep_link = activation["href"] if isinstance(activation, dict) else None
    if not isinstance(deep_link, str):
        raise AssertionError(f"{result_type} search result is not activatable")
    context_ref = payload["context_ref"]
    evidence_span_ids = (
        context_ref.get("evidence_span_ids") if isinstance(context_ref, dict) else []
    )
    evidence_span_id = payload.get("evidence_span_id")
    if not isinstance(evidence_span_id, str):
        evidence_span_id = (
            str(evidence_span_ids[0])
            if isinstance(evidence_span_ids, list) and evidence_span_ids
            else None
        )
    return RetrievalCitation(
        result_type=result_type,
        source_id=str(payload["source_id"] if result_type == "web_result" else payload["id"]),
        title=str(payload["title"]),
        source_label=payload.get("source_label"),
        snippet=str(payload["snippet"]),
        deep_link=deep_link,
        citation_target=payload.get("citation_target"),
        citation_label=payload.get("citation_label"),
        locator=_locator_from_search_payload(payload),
        context_ref=context_ref,
        evidence_span_id=evidence_span_id,
        media_id=payload.get("media_id"),
        media_kind=payload.get("media_kind"),
        score=float(payload["score"]) if payload.get("score") is not None else None,
        contributors=_contributors_from_search_payload(payload),
        filters=filters,
        result_ref=dict(payload),
    )


def _contributors_from_search_payload(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    source = payload.get("source")
    contributors = source.get("contributors") if isinstance(source, Mapping) else None
    if not isinstance(contributors, list):
        contributors = payload.get("contributors")
    if isinstance(contributors, list):
        return [dict(item) for item in contributors if isinstance(item, Mapping)]
    return []


def _locator_from_search_payload(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    locator = payload.get("locator")
    if isinstance(locator, dict):
        validated = retrieval_locator_json(locator)
        if validated is not None:
            return validated
    if str(payload.get("type") or "") in STRICT_LOCATOR_RESULT_TYPES:
        raise ValueError(f"{payload.get('type')} search result is missing locator")
    return None


def strict_citation_locator(citation: RetrievalCitation) -> dict[str, Any] | None:
    locator = retrieval_locator_json(citation.locator)
    if locator is None and citation.result_type in STRICT_LOCATOR_RESULT_TYPES:
        raise ValueError(f"{citation.result_type} citation is missing locator")
    return locator


_SELECT_RETRIEVAL = text(
    "SELECT id FROM message_retrievals WHERE tool_call_id = :tool_call_id AND ordinal = :ordinal"
)
_INSERT_RETRIEVAL = text(
    """
    INSERT INTO message_retrievals (
        tool_call_id, ordinal, result_type, source_id, media_id, evidence_span_id,
        scope, context_ref, result_ref, deep_link, score, selected, source_title,
        section_label, exact_snippet, locator, retrieval_status, included_in_prompt
    )
    VALUES (
        :tool_call_id, :ordinal, :result_type, :source_id, :media_id, :evidence_span_id,
        :scope, :context_ref, :result_ref, :deep_link, :score, :selected, :source_title,
        :section_label, :exact_snippet, :locator, :retrieval_status, :included_in_prompt
    )
    RETURNING id
    """
).bindparams(
    bindparam("context_ref", type_=JSONB),
    bindparam("result_ref", type_=JSONB),
    bindparam("locator", type_=JSONB),
)
_UPDATE_RETRIEVAL = text(
    """
    UPDATE message_retrievals
    SET result_type = :result_type, source_id = :source_id, media_id = :media_id,
        evidence_span_id = :evidence_span_id, scope = :scope, context_ref = :context_ref,
        result_ref = :result_ref, deep_link = :deep_link, score = :score, selected = :selected,
        source_title = :source_title, section_label = :section_label, exact_snippet = :exact_snippet,
        snippet_prefix = NULL, snippet_suffix = NULL, locator = :locator,
        retrieval_status = :retrieval_status, included_in_prompt = :included_in_prompt
    WHERE id = :retrieval_id
    """
).bindparams(
    bindparam("context_ref", type_=JSONB),
    bindparam("result_ref", type_=JSONB),
    bindparam("locator", type_=JSONB),
)


def insert_retrieval_row(
    db: Session,
    *,
    tool_call_id: UUID,
    ordinal: int,
    citation: RetrievalCitation,
    selected: bool,
    scope: str,
    retrieval_status: str,
    included_in_prompt: bool = False,
) -> UUID:
    """Upsert one ``message_retrievals`` row from a citation; return its id.

    ``result_ref``/``context_ref``/``locator`` are validated by the retrieval
    schema before the row is written. ``citation_candidate_ordinal`` and
    ``cited_edge_id`` belong to Chat's numbering and publication phases and are
    never written here.
    """

    payload = {
        "tool_call_id": tool_call_id,
        "ordinal": ordinal,
        "result_type": citation.result_type,
        "source_id": citation.source_id,
        "media_id": citation.media_id,
        "evidence_span_id": UUID(citation.evidence_span_id) if citation.evidence_span_id else None,
        "scope": scope,
        "context_ref": retrieval_context_ref_json(citation.context_ref),
        "result_ref": retrieval_result_ref_json(citation.result_ref_json()),
        "deep_link": citation.deep_link,
        "score": citation.score,
        "selected": selected,
        "source_title": citation.title,
        "section_label": citation.source_label,
        "exact_snippet": citation.snippet,
        "locator": strict_citation_locator(citation),
        "retrieval_status": retrieval_status,
        "included_in_prompt": included_in_prompt,
    }
    existing = db.execute(
        _SELECT_RETRIEVAL, {"tool_call_id": tool_call_id, "ordinal": ordinal}
    ).scalar_one_or_none()
    if existing is None:
        return db.execute(_INSERT_RETRIEVAL, payload).scalar_one()
    db.execute(_UPDATE_RETRIEVAL, {**payload, "retrieval_id": existing})
    return existing
