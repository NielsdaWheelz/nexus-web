"""Transient retrieval evidence and bounded saved references.

Selected spans carry their evidence until settlement keeps only cited quotes.
Citation numbering and publication belong to ``citations``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, cast
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.schemas.live_reference import (
    SavedReference,
    SavedResourceTarget,
    SavedRetrievalTarget,
    UrlRetrievalTarget,
)
from nexus.schemas.reader import (
    EpubTextOffsetsTargetOut,
    TranscriptTextOffsetsTargetOut,
    WebTextOffsetsTargetOut,
)
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedUnavailableTarget,
    ResourceField,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.reader_excerpts import plain_excerpt, quote_parts
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.evidence import admit_evidence, capture_evidence
from nexus.services.search.candidates import SearchResultMediaOut, SearchResultOut
from nexus.services.search.project import build_source_label
from nexus.services.search.service import get_search_result
from nexus.services.text_quote import normalize_for_match

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
    "content_chunk": ("source_kind", "evidence_span_ids"),
    "contributor": ("contributor_handle",),
    "note_block": ("body_text",),
    "highlight": ("color", "exact", "matched_field"),
    "message": ("seq",),
    "reader_apparatus_item": ("apparatus_kind",),
}
# Media passages whose reopen goes through a reading owner.
_READING_OWNED = frozenset(
    {"content_chunk", "fragment", "highlight", "evidence_span", "reader_apparatus_item"}
)
_WEB_KEYS = (
    "result_ref",
    "url",
    "display_url",
    "extra_snippets",
    "published_at",
    "source_name",
    "rank",
    "provider",
    "provider_request_id",
)


def compact(value: Mapping[str, Any]) -> dict[str, Any]:
    """The transient model form omits absent, empty and unselected facts, except a context
    ref's always-present ``passage_target``."""

    return {
        key: compact(item) if key == "context_ref" else item
        for key, item in value.items()
        if key in ("passage_target", "field")
        or (item is not None and item != [] and not (key == "selected" and item is False))
    }


@dataclass(slots=True)
class RetrievalCitation:
    """Transient model evidence; persistence bounds the selected target quote."""

    captured_evidence: CapturedEvidence | None
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
    payload: dict[str, Any] = field(default_factory=dict)
    selected: bool = False
    reference: SavedReference | None = None

    @property
    def target(self) -> SavedRetrievalTarget:
        from nexus.services.live_references import from_evidence

        if self.reference is not None:
            return SavedResourceTarget(reference=self.reference)
        if self.result_type == "web_result":
            return UrlRetrievalTarget(url=self.deep_link)
        if (
            self.captured_evidence is not None
            and self.captured_evidence.target.owner_ref is not None
        ):
            return SavedResourceTarget(reference=from_evidence(self.captured_evidence))
        uri = self.citation_target or f"{self.context_ref['type']}:{self.context_ref['id']}"
        return SavedResourceTarget(
            reference=SavedReference(resource_ref=uri, field=None, locator=None, quote=None)
        )

    def result_ref_json(self) -> dict[str, Any]:
        """Transient model evidence, also measured by search's selection budget."""

        kind = self.result_type
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
        ref |= {key: self.payload.get(key) for key in _EXTRA_KEYS.get(kind, ())}
        if kind in ("content_chunk", "fragment", "highlight", "evidence_span"):
            ref["citation_label"] = self.citation_label
        if kind == "content_chunk":
            ref["evidence_span_id"] = self.evidence_span_id
        elif kind == "podcast":
            ref["contributors"] = self.contributors
        elif kind == "evidence_span":
            ref["citation_label"] = self.citation_label or ""
            ref["evidence_span_id"] = self.evidence_span_id or self.source_id
            ref["media_id"] = self.media_id or self.payload.get("media_id")
        elif kind == "web_result":
            return compact(ref | {key: self.payload.get(key) for key in _WEB_KEYS})
        return ref


def citation_from_search_result(result: SearchResultOut) -> RetrievalCitation:
    payload = result.model_dump(mode="json")
    kind = str(payload["type"])
    deep_link = (payload["activation"] or {}).get("href")
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
        listed = listed if isinstance(listed, list) else payload.get("contributors")
        contributors = [dict(item) for item in listed or [] if isinstance(item, Mapping)]
    raw_locator = payload.get("locator")
    locator = retrieval_locator_json(raw_locator) if isinstance(raw_locator, dict) else None
    if locator is None and kind in STRICT_LOCATOR:
        raise ValueError(f"{kind} search result is missing locator")
    return RetrievalCitation(
        captured_evidence=result.captured_evidence,
        result_type=kind,
        source_id=str(payload["id"]),
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
        payload=payload,
        selected=False,
    )


def reopen_search_result(
    db: Session,
    *,
    viewer_id: UUID,
    result_type: str,
    source_id: str,
    passage_target: CapturedPassageTarget | None = None,
    field: ResourceField = None,
    captured_evidence: CapturedEvidence | None = None,
) -> SearchResultOut:
    """One search result reopened by identity for a single read or an attached resource.

    A media passage reopens through the reading owner captured for it now: the ref alone
    names no reading context, so that is the viewer-wide owner (a piece when its source
    is unreadable). A supplied target instead requires its exact reading owner and
    publication; failure never falls back. 404 when the viewer cannot capture it.
    """
    target = passage_target
    if target is None and result_type in _READING_OWNED:
        ref = ResourceRef(cast(ResourceScheme, result_type), UUID(source_id))
        captured_evidence = capture_evidence(db, viewer_id=viewer_id, ref=ref, field=field)
        captured = captured_evidence.target
        target = captured if isinstance(captured, CapturedPassageTarget) else None
    return get_search_result(
        db,
        viewer_id,
        result_type,
        source_id,
        passage_target=target,
        field=field,
        captured_evidence=captured_evidence,
    )


def citation_from_evidence(
    db: Session, *, viewer_id: UUID, evidence: CapturedEvidence
) -> RetrievalCitation | None:
    """Already-selected evidence needs current disclosure proof, never discovery search."""
    from nexus.services.resource_items.routing import (
        captured_passage_activation,
        resource_activation_for_ref,
    )

    admitted = admit_evidence(db, viewer_id=viewer_id, evidence=evidence)
    if admitted is None or admitted.target.owner_ref is None:
        return None
    ref = assert_resource_ref(admitted.target.owner_ref)
    kind = capability(ref.scheme).citable_result_type
    if (
        kind is None
        or admitted.quote is None
        or isinstance(admitted.target, CapturedUnavailableTarget)
    ):
        return None
    target = admitted.target
    if isinstance(target, CapturedPassageTarget):
        activation = captured_passage_activation(target)
    else:
        activation = resource_activation_for_ref(db, viewer_id=viewer_id, ref=ref, missing=False)
    if activation.href is None:
        return None
    parts = quote_parts(admitted.quote)
    locator = (
        target.locator.model_dump(mode="json")
        if isinstance(target, CapturedPassageTarget)
        else None
    )
    media_id = (
        target.owner_ref.removeprefix("media:")
        if target.owner_ref and target.owner_ref.startswith("media:")
        else None
    )
    return RetrievalCitation(
        captured_evidence=admitted,
        result_type=kind,
        source_id=str(ref.id),
        title=admitted.source.title or "selected passage",
        source_label=None,
        snippet=parts.exact,
        deep_link=activation.href,
        citation_target=ref.uri,
        citation_label=admitted.source.location_label,
        locator=locator,
        context_ref={
            "type": kind,
            "id": str(ref.id),
            "field": target.field,
            "passage_target": target.model_dump(mode="json")
            if isinstance(target, CapturedPassageTarget)
            else None,
        },
        evidence_span_id=str(ref.id) if ref.scheme == "evidence_span" else None,
        media_id=media_id,
        media_kind=admitted.source.media_kind.value if admitted.source.media_kind else None,
        score=None,
        selected=True,
    )


def web_citation(hit: Mapping[str, Any], *, selected: bool) -> RetrievalCitation:
    """Provider words remain transient; the durable citation remembers only the URL."""
    return RetrievalCitation(
        captured_evidence=None,
        result_type="web_result",
        source_id=str(hit["url"]),
        title=str(hit["title"]),
        source_label=None,
        snippet=str(hit["snippet"]),
        deep_link=str(hit["url"]),
        citation_target=None,
        citation_label=None,
        locator=None,
        context_ref={},
        evidence_span_id=None,
        media_id=None,
        media_kind=None,
        score=1.0 / max(hit["rank"], 1),
        payload=dict(hit),
        selected=selected,
    )


_INSERT = text("""INSERT INTO message_retrievals
    (assistant_message_id,tool_call_id,ordinal,target,selected)
    VALUES (:assistant_message_id,:tool_call_id,:ordinal,:target,:selected) RETURNING id""").bindparams(
    bindparam("target", type_=JSONB)
)


def insert_retrieval(
    db: Session,
    *,
    assistant_message_id: UUID,
    tool_call_id: UUID | None,
    ordinal: int,
    citation: RetrievalCitation,
    selected: bool,
) -> UUID:
    """One row per (call, ordinal) of an answer (no call: attached context).

    Selected spans retain bounded evidence, never later source derivation.
    Candidate ordinals and cited edges belong to ``citations``.
    """

    target = citation.target
    if isinstance(target, SavedResourceTarget):
        reference = target.reference
        quote = reference.quote if selected else None
        if quote is not None and citation.reference is None and reference.locator is not None:
            locator = reference.locator
            parameters: dict[str, object] = {}
            if isinstance(
                locator,
                (WebTextOffsetsTargetOut, EpubTextOffsetsTargetOut, TranscriptTextOffsetsTargetOut),
            ):
                parameters = {
                    "id": locator.fragment_id,
                    "start": locator.start_offset,
                    "size": locator.end_offset - locator.start_offset,
                }
                body_sql = "SELECT substring(canonical_text FROM :start+1 FOR :size) FROM fragments WHERE id=:id AND :start+:size<=char_length(canonical_text)"
            elif locator.kind == "TextOffsets":
                ref = assert_resource_ref(reference.resource_ref)
                table, column = (
                    ("highlights", "annotation_body_text")
                    if reference.field == "annotation"
                    else ("note_blocks", "body_text")
                )
                parameters = {
                    "id": ref.id,
                    "start": locator.start_offset,
                    "size": locator.end_offset - locator.start_offset,
                }
                body_sql = f"SELECT substring({column} FROM :start+1 FOR :size) FROM {table} WHERE id=:id AND :start+:size<=char_length({column})"
            else:
                body_sql = ""
            if body_sql:
                literal = db.scalar(text(body_sql), parameters)
                if (
                    literal is None
                    or normalize_for_match(literal).text != normalize_for_match(quote.exact).text
                ):
                    reference = reference.model_copy(update={"locator": None})
                    quote = None
                elif literal != quote.exact:
                    quote = quote.model_copy(
                        update={
                            "exact": literal,
                            "excerpt": plain_excerpt(literal, quote.prefix, quote.suffix),
                        }
                    )
        if quote is not None and (
            len(quote.exact) > 2000 or len(quote.excerpt.model_dump_json().encode()) > 64 * 1024
        ):
            exact = quote.exact[:2000]
            quote = quote.model_copy(
                update={
                    "exact": exact,
                    "suffix": None if len(quote.exact) > 2000 else quote.suffix,
                    "excerpt": plain_excerpt(exact).model_copy(update={"truncated_after": True}),
                }
            )
        target = SavedResourceTarget(reference=reference.model_copy(update={"quote": quote}))
    return db.execute(
        _INSERT,
        {
            "assistant_message_id": assistant_message_id,
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "target": target.model_dump(mode="json"),
            "selected": selected,
        },
    ).scalar_one()
