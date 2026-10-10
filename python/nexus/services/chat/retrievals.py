"""The one ``message_retrievals`` writer: a search result as a validator-shaped row.

App search, web search, attached ``<resources>`` and ``read_resource`` evidence all
enter through ``citation_from_search_result``, so the validator-sensitive shape lives
here once. Numbering and publication belong to ``citations``.
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
    ExternalSnapshotId,
    ProviderResultRef,
    RetrievalContextRef,
    WebRetrievalResultRef,
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.schemas.search import SearchResultMediaOut, SearchResultOut, SearchResultWebOut
from nexus.services.search.project import build_source_label

STRICT_LOCATOR = frozenset(
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
# The result_ref keys a type carries beyond the common ones, copied from its search payload.
_EXTRA_KEYS: dict[str, tuple[str, ...]] = {
    "content_chunk": ("source_kind",),
    "contributor": ("contributor_handle",),
    "note_block": ("body_text", "highlight_excerpt"),
    "highlight": ("color", "exact"),
    "message": ("conversation_id", "seq"),
    "reader_apparatus_item": ("apparatus_kind",),
    "artifact": ("revision_id", "subject_ref"),
}


@dataclass(slots=True)
class RetrievalCitation:
    """A retrieved or attached result as the model, the browser and the row see it."""

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
        kind = self.result_type
        if kind == "web_result":
            return self.result_ref  # its builder made it validator-shaped already
        ref: dict[str, Any] = {
            "type": kind,
            "id": self.source_id,
            "result_type": kind,
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
        ref |= {key: self.result_ref.get(key) for key in _EXTRA_KEYS.get(kind, ())}
        if kind in ("content_chunk", "fragment", "highlight"):
            ref["citation_label"] = self.citation_label
        if kind == "content_chunk":
            ref["evidence_span_id"] = self.evidence_span_id
            ref["evidence_span_ids"] = self.result_ref.get("evidence_span_ids", [])
        elif kind == "podcast":
            ref["contributors"] = self.contributors
        elif kind == "evidence_span":
            ref["citation_label"] = self.citation_label or ""
            ref["evidence_span_id"] = self.evidence_span_id or self.source_id
            ref["media_id"] = self.media_id or self.result_ref.get("media_id")
        elif kind == "conversation":
            ref |= {"locator": None, "media_id": None, "media_kind": None}
        return ref


def citation_from_search_result(
    result: SearchResultOut, *, filters: dict[str, Any]
) -> RetrievalCitation:
    payload = result.model_dump(mode="json")
    kind = str(payload["type"])
    if kind == "web_result":
        source_id = str(payload["source_id"])
        payload |= {"id": source_id, "context_ref": {"type": "web_result", "id": source_id}}
    activation = payload["activation"]
    deep_link = activation.get("href") if isinstance(activation, dict) else None
    if not isinstance(deep_link, str):
        raise AssertionError(f"{kind} search result is not activatable")
    context_ref = payload["context_ref"]
    span_ids = context_ref.get("evidence_span_ids") or []
    span_id = payload.get("evidence_span_id")
    if not isinstance(span_id, str):
        span_id = str(span_ids[0]) if span_ids else None
    if isinstance(result, SearchResultMediaOut):
        summary = result.media_summary
        title, source_label = summary.title, build_source_label(summary)
        media_id, media_kind = str(summary.media_id), summary.media_kind.value
        contributors = [credit.model_dump(mode="json") for credit in summary.contributors]
    else:
        title, source_label = result.title, result.source_label
        media_id, media_kind = payload.get("media_id"), payload.get("media_kind")
        source = payload.get("source")
        listed = source.get("contributors") if isinstance(source, Mapping) else None
        if not isinstance(listed, list):
            listed = payload.get("contributors")
        listed = listed if isinstance(listed, list) else []
        contributors = [dict(item) for item in listed if isinstance(item, Mapping)]
    result_ref = dict(payload)
    if isinstance(result, SearchResultWebOut):
        snapshot_id = ExternalSnapshotId(UUID(result.source_id))
        result_ref = WebRetrievalResultRef(
            type="web_result",
            id=snapshot_id,
            result_type="web_result",
            source_id=snapshot_id,
            result_ref=ProviderResultRef(result.result_ref),
            title=result.title,
            source_label=result.source_label,
            snippet=result.snippet,
            deep_link=deep_link,
            citation_target=result.citation_target,
            context_ref=RetrievalContextRef(type="web_result", id=snapshot_id),
            locator=result.locator,
            score=result.score,
            selected=result.selected,
            url=result.url,
            display_url=result.display_url,
            extra_snippets=result.extra_snippets,
            published_at=result.published_at,
            source_name=result.source_name,
            rank=result.rank,
            provider=result.provider,
            provider_request_id=result.provider_request_id,
        ).model_dump(mode="json", exclude_none=True, exclude_defaults=True)
    raw_locator = payload.get("locator")
    locator = retrieval_locator_json(raw_locator) if isinstance(raw_locator, dict) else None
    if locator is None and kind in STRICT_LOCATOR:
        raise ValueError(f"{kind} search result is missing locator")
    return RetrievalCitation(
        result_type=kind,
        source_id=str(payload["source_id"] if kind == "web_result" else payload["id"]),
        title=title,
        source_label=source_label,
        snippet=str(payload["snippet"]),
        deep_link=deep_link,
        citation_target=payload.get("citation_target"),
        citation_label=payload.get("citation_label"),
        locator=locator,
        context_ref=context_ref,
        evidence_span_id=span_id,
        media_id=media_id,
        media_kind=media_kind,
        score=float(payload["score"]) if payload.get("score") is not None else None,
        contributors=contributors,
        filters=filters,
        result_ref=result_ref,
    )


_INSERT = text(
    """
    INSERT INTO message_retrievals (
        tool_call_id, ordinal, result_type, source_id, media_id, evidence_span_id,
        scope, context_ref, result_ref, deep_link, score, selected, source_title,
        section_label, exact_snippet, locator, retrieval_status, included_in_prompt
    ) VALUES (
        :tool_call_id, :ordinal, :result_type, :source_id, :media_id, :evidence_span_id,
        :scope, :context_ref, :result_ref, :deep_link, :score, :selected, :source_title,
        :section_label, :exact_snippet, :locator, :retrieval_status, :included_in_prompt
    )
    RETURNING id
    """
).bindparams(*(bindparam(name, type_=JSONB) for name in ("context_ref", "result_ref", "locator")))


def insert_retrieval(
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
    """One row per (tool call, ordinal); its refs and locator pass the retrieval validators.

    Candidate ordinals and cited edges belong to ``citations`` and are never written here.
    """

    locator = retrieval_locator_json(citation.locator)
    if locator is None and citation.result_type in STRICT_LOCATOR:
        raise ValueError(f"{citation.result_type} citation is missing locator")
    return db.execute(
        _INSERT,
        {
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "result_type": citation.result_type,
            "source_id": citation.source_id,
            "media_id": citation.media_id,
            "evidence_span_id": citation.evidence_span_id,
            "scope": scope,
            "context_ref": retrieval_context_ref_json(citation.context_ref),
            "result_ref": retrieval_result_ref_json(citation.result_ref_json()),
            "deep_link": citation.deep_link,
            "score": citation.score,
            "selected": selected,
            "source_title": citation.title,
            "section_label": citation.source_label,
            "exact_snippet": citation.snippet,
            "locator": locator,
            "retrieval_status": retrieval_status,
            "included_in_prompt": included_in_prompt,
        },
    ).scalar_one()
