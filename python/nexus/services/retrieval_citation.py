"""Citation materialization + the one validated `message_retrievals` writer.

Turns a ``SearchResultOut`` (from ``search.get_search_result``) into a
``RetrievalCitation`` whose ``result_ref``/``locator`` pass the strict retrieval
validators, and inserts it as a ``message_retrievals`` row.

This is the single owner of "make a citable retrieval row": ``app_search``,
attached ``<resources>``, and ``read_resource`` evidence all go through it, so
the validator-sensitive shape lives in exactly one place.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, cast
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.schemas.citation import (
    CitationOut,
    CitationRole,
    CitationSnapshot,
    CitationTargetRef,
    CitationTargetType,
)
from nexus.schemas.retrieval import (
    RetrievalLocator,
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.schemas.search import SearchResultOut
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span

_LOCATOR_ADAPTER: TypeAdapter[RetrievalLocator] = TypeAdapter(RetrievalLocator)

STRICT_LOCATOR_RESULT_TYPES = frozenset(
    {
        "content_chunk",
        "fragment",
        "note_block",
        "highlight",
        "message",
        "evidence_span",
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
        common = {
            "type": self.result_type,
            "id": self.source_id,
            "result_type": self.result_type,
            "source_id": self.source_id,
            "title": self.title,
            "source_label": self.source_label,
            "snippet": self.snippet,
            "deep_link": self.deep_link,
            "context_ref": self.context_ref,
            "locator": self.locator,
            "media_id": self.media_id,
            "media_kind": self.media_kind,
            "score": self.score,
            "selected": self.selected,
        }
        if self.result_type == "media":
            return common
        if self.result_type == "podcast":
            return {
                **common,
                "contributors": self.contributors,
            }
        if self.result_type in {"episode", "video"}:
            return common
        if self.result_type == "content_chunk":
            return {
                **common,
                "source_kind": self.result_ref["source_kind"],
                "citation_label": self.citation_label,
                "evidence_span_id": self.evidence_span_id,
                "evidence_span_ids": self.result_ref.get("evidence_span_ids", []),
                "locator": self.locator,
                "media_id": self.media_id,
                "media_kind": self.media_kind,
            }
        if self.result_type == "fragment":
            return {
                **common,
                "citation_label": self.citation_label,
                "locator": self.locator,
                "media_id": self.media_id,
                "media_kind": self.media_kind,
            }
        if self.result_type == "contributor":
            return {
                **common,
                "contributor_handle": self.result_ref["contributor_handle"],
            }
        if self.result_type == "page":
            return {
                **common,
                "description": self.result_ref.get("description"),
            }
        if self.result_type == "note_block":
            return {
                **common,
                "page_id": self.result_ref["page_id"],
                "page_title": self.result_ref["page_title"],
                "body_text": self.result_ref["body_text"],
                "highlight_excerpt": self.result_ref.get("highlight_excerpt"),
                "locator": self.locator,
            }
        if self.result_type == "highlight":
            return {
                **common,
                "color": self.result_ref["color"],
                "exact": self.result_ref["exact"],
                "citation_label": self.citation_label,
                "locator": self.locator,
                "media_id": self.media_id,
                "media_kind": self.media_kind,
            }
        if self.result_type == "message":
            return {
                **common,
                "conversation_id": self.result_ref["conversation_id"],
                "seq": self.result_ref["seq"],
                "locator": self.locator,
            }
        if self.result_type == "evidence_span":
            return {
                "type": "evidence_span",
                "id": self.source_id,
                "result_type": "evidence_span",
                "source_id": self.source_id,
                "title": self.title,
                "source_label": self.source_label,
                "snippet": self.snippet,
                "deep_link": self.deep_link,
                "citation_label": self.citation_label or "",
                "context_ref": self.context_ref,
                "evidence_span_id": self.evidence_span_id or self.source_id,
                "locator": self.locator,
                "media_id": self.media_id or self.result_ref.get("media_id"),
                "media_kind": self.media_kind,
                "score": self.score,
                "selected": self.selected,
            }
        if self.result_type == "conversation":
            return {
                "type": "conversation",
                "id": self.source_id,
                "result_type": "conversation",
                "source_id": self.source_id,
                "title": self.title,
                "source_label": self.source_label,
                "snippet": self.snippet,
                "deep_link": self.deep_link,
                "context_ref": self.context_ref,
                "locator": None,
                "media_id": None,
                "media_kind": None,
                "score": self.score,
                "selected": self.selected,
            }
        raise ValueError(f"Unsupported result type: {self.result_type}")


def citation_from_search_result(
    result: SearchResultOut,
    *,
    filters: dict[str, Any],
) -> RetrievalCitation:
    payload = result.model_dump(mode="json")
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
    result_ref = dict(payload)
    result_type = str(payload["type"])
    return RetrievalCitation(
        result_type=result_type,
        source_id=str(payload["id"]),
        title=str(payload["title"]),
        source_label=payload.get("source_label"),
        snippet=str(payload["snippet"]),
        deep_link=str(payload["deep_link"]),
        citation_label=payload.get("citation_label"),
        locator=_locator_from_search_payload(payload),
        context_ref=context_ref,
        evidence_span_id=evidence_span_id,
        media_id=payload.get("media_id"),
        media_kind=payload.get("media_kind"),
        score=float(payload["score"]) if payload.get("score") is not None else None,
        contributors=_contributors_from_search_payload(payload),
        filters=filters,
        result_ref=result_ref,
    )


def _contributors_from_search_payload(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    source = payload.get("source")
    if isinstance(source, Mapping):
        contributors = source.get("contributors")
        if isinstance(contributors, list):
            return [dict(item) for item in contributors if isinstance(item, Mapping)]
    contributors = payload.get("contributors")
    if isinstance(contributors, list):
        return [dict(item) for item in contributors if isinstance(item, Mapping)]
    return []


def _locator_from_search_payload(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    result_type = str(payload.get("type") or "")
    locator = payload.get("locator")
    if isinstance(locator, dict):
        validated = retrieval_locator_json(locator)
        if validated is not None:
            return validated
    if result_type in STRICT_LOCATOR_RESULT_TYPES:
        raise ValueError(f"{result_type} search result is missing locator")
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
        section_label, exact_snippet, locator, retrieval_status, included_in_prompt,
        citation_ordinal
    )
    VALUES (
        :tool_call_id, :ordinal, :result_type, :source_id, :media_id, :evidence_span_id,
        :scope, :context_ref, :result_ref, :deep_link, :score, :selected, :source_title,
        :section_label, :exact_snippet, :locator, :retrieval_status, :included_in_prompt,
        :citation_ordinal
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
        retrieval_status = :retrieval_status, included_in_prompt = :included_in_prompt,
        citation_ordinal = COALESCE(:citation_ordinal, citation_ordinal)
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
    citation_ordinal: int | None = None,
) -> UUID:
    """Upsert one ``message_retrievals`` row from a citation; return its id.

    The single validated insert path. ``result_ref``/``context_ref``/``locator``
    are validated by the retrieval schema before the row is written.
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
        "citation_ordinal": citation_ordinal,
    }
    existing = db.execute(
        _SELECT_RETRIEVAL, {"tool_call_id": tool_call_id, "ordinal": ordinal}
    ).first()
    if existing is None:
        return db.execute(_INSERT_RETRIEVAL, payload).scalar_one()
    db.execute(_UPDATE_RETRIEVAL, {**payload, "retrieval_id": existing[0]})
    return existing[0]


# ---------- evidence-span citation target (write-time) ----------------------


def build_evidence_span_citation_target(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    evidence_span_id: UUID,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve one evidence span to a stored (locator, snapshot) pair.

    Used by the library-intelligence reduce at citation-write time. The locator is
    the normalized ``RetrievalLocator`` shape (via the shared
    ``locator_from_resolution`` mapping); the snapshot carries display fields plus
    the canonical ``#evidence-`` deep_link (the read producer lifts it into
    ``CitationOut.deep_link``).
    """
    resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=evidence_span_id)
    media = (
        db.execute(
            text("SELECT title, kind FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .one()
    )
    locator = locator_from_resolution(
        resolution, media_id=media_id, media_kind=str(media["kind"] or "")
    )
    snapshot = {
        "title": str(media["title"]) if media["title"] is not None else None,
        "excerpt": str(resolution.get("span_text") or "")[:600],
        "section_label": str(resolution.get("citation_label") or "") or None,
        "result_type": "evidence_span",
        "deep_link": f"/media/{media_id}#evidence-{evidence_span_id}",
    }
    return locator, snapshot


# ---------- citation read-model producer ------------------------------------


def build_citation_outs_for_revision(db: Session, *, revision_id: UUID) -> list[CitationOut]:
    """Build the shared ``CitationOut`` read-model for one LI revision's citations.

    Reads the immutable ``library_intelligence_citations`` rows (locator + snapshot
    persisted at generation), lifting ``snapshot.deep_link`` into
    ``CitationOut.deep_link``. The render contract (`[N]` jump) is identical to
    chat/oracle citations.
    """
    rows = (
        db.execute(
            text(
                """
                SELECT ordinal, role, target_type, target_id, locator, snapshot
                FROM library_intelligence_citations
                WHERE revision_id = :revision_id
                ORDER BY ordinal
                """
            ),
            {"revision_id": revision_id},
        )
        .mappings()
        .all()
    )
    return [_citation_out_from_row(row) for row in rows]


def _citation_out_from_row(row: Mapping[Any, Any]) -> CitationOut:
    raw_locator = row["locator"] if isinstance(row["locator"], dict) else None
    locator: RetrievalLocator | None = (
        _LOCATOR_ADAPTER.validate_python(raw_locator) if raw_locator else None
    )
    snapshot_raw = row["snapshot"] if isinstance(row["snapshot"], dict) else {}
    deep_link = snapshot_raw.get("deep_link")
    # Not every locator variant carries a media_id (e.g. note_block/message/url),
    # but evidence-span citations always do.
    media_id = getattr(locator, "media_id", None) if locator is not None else None
    return CitationOut(
        ordinal=int(row["ordinal"]),
        role=cast("CitationRole", str(row["role"])),
        target_ref=CitationTargetRef(
            type=cast("CitationTargetType", str(row["target_type"])),
            id=UUID(str(row["target_id"])),
        ),
        media_id=UUID(str(media_id)) if media_id is not None else None,
        locator=locator,
        deep_link=str(deep_link) if isinstance(deep_link, str) else None,
        snapshot=CitationSnapshot(
            title=_opt_str(snapshot_raw.get("title")),
            excerpt=_opt_str(snapshot_raw.get("excerpt")),
            section_label=_opt_str(snapshot_raw.get("section_label")),
            result_type=_opt_str(snapshot_raw.get("result_type")),
        ),
    )


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None
