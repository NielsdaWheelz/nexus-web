"""The one ``message_retrievals`` writer: a search result as the row and the model see it.

App search, web search, attached ``<resources>`` and ``read_resource`` evidence all
enter through ``citation_from_search_result`` (provider web hits through ``web_citation``), so
the stored ``result_ref`` shape lives here once. It is also the model-visible
``tool_citation`` payload and search's web-snapshot source, so its keys are a contract:
every built key, minus the ones whose value is null, an empty list or ``selected`` false
(byte for byte what the retired validators stored).
Numbering and publication belong to ``citations``. The caller starts its serializable
attempt before source reads and fences, and refreshes retained-X viewer
contributor text once after its complete insertion batch. This helper never commits.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import XPostSource
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.resource_evidence import (
    CapturedEvidence,
    CapturedPassageTarget,
    CapturedQuote,
    CapturedSource,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.library_entries import lock_media_for_reference
from nexus.services.search.candidates import SearchResultMediaOut, SearchResultOut
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
    "content_chunk": ("source_kind", "evidence_span_ids"),
    "contributor": ("contributor_handle",),
    "note_block": ("body_text", "highlight_excerpt"),
    "highlight": ("color", "exact"),
    "message": ("conversation_id", "seq"),
    "reader_apparatus_item": ("apparatus_kind",),
    "artifact": ("revision_id", "subject_ref"),
}
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
    """The stored form: absent, empty and unselected facts are omitted (as ever)."""

    return {
        key: compact(item) if key == "context_ref" else item
        for key, item in value.items()
        if item is not None and item != [] and not (key == "selected" and item is False)
    }


@dataclass(slots=True)
class RetrievalCitation:
    """A retrieved or attached result as the model, the browser and the row see it."""

    captured_evidence: CapturedEvidence
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

    def result_ref_json(self) -> dict[str, Any]:
        """The built ref. Search's selection budget measures it as is (web refs were always
        stored-form); ``insert_retrieval`` stores ``compact`` of it."""

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
    if kind == "web_result":
        source_id = str(payload["source_id"])
        payload |= {"id": source_id, "context_ref": {"type": "web_result", "id": source_id}}
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
        payload=payload,
        selected=bool(payload.get("selected")) if kind == "web_result" else False,
    )


def web_citation(hit: Mapping[str, Any], *, snapshot_id: UUID, selected: bool) -> RetrievalCitation:
    """One provider web hit whose snapshot the caller just stored."""

    ref = f"external_snapshot:{snapshot_id}"
    locator = retrieval_locator_json(
        {
            "type": "external_url",
            "url": hit["url"],
            "title": hit["title"],
            "display_url": hit["display_url"],
        }
    )
    return RetrievalCitation(
        captured_evidence=CapturedEvidence(
            quote=CapturedQuote(exact=hit["snippet"], prefix=None, suffix=None, color=None),
            source=CapturedSource(
                ref=ref, title=hit["title"], media_kind=None, contributors=None, location_label=None
            ),
            target=CapturedPassageTarget.model_validate(
                {
                    "owner_ref": ref,
                    "locator": locator,
                    "precision": "exact",
                    "source_identity": None,
                }
            ),
        ),
        result_type="web_result",
        source_id=str(snapshot_id),
        title=hit["title"],
        source_label=None,
        snippet=hit["snippet"],
        deep_link=hit["url"],
        citation_target=ref,
        citation_label=None,
        locator=locator,
        context_ref={"type": "web_result", "id": str(snapshot_id)},
        evidence_span_id=None,
        media_id=None,
        media_kind=None,
        score=1.0 / max(hit["rank"], 1),
        payload=dict(hit),
        selected=selected,
    )


_INSERT = text(
    """
    INSERT INTO message_retrievals (
        assistant_message_id, tool_call_id, ordinal, result_type, source_id, media_id,
        evidence_span_id, context_ref, result_ref, selected, locator, captured_evidence
    ) VALUES (
        :assistant_message_id, :tool_call_id, :ordinal, :result_type, :source_id, :media_id,
        :evidence_span_id, :context_ref, :result_ref, :selected, :locator, :captured_evidence
    )
    RETURNING id
    """
).bindparams(
    *(
        bindparam(name, type_=JSONB(none_as_null=True))
        for name in ("context_ref", "result_ref", "locator", "captured_evidence")
    )
)


def lock_retrieval_media(db: Session, citations: Sequence[RetrievalCitation]) -> None:
    """Batch admission takes canonical post reference locks in media-id order."""
    ids = sorted({UUID(citation.media_id) for citation in citations if citation.media_id})
    for media_id in db.scalars(
        select(XPostSource.media_id)
        .where(XPostSource.media_id.in_(ids))
        .order_by(XPostSource.media_id)
    ):
        lock_media_for_reference(db, media_id)


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

    Candidate ordinals and cited edges belong to ``citations`` and are never written here.
    """

    if (
        citation.media_id is not None
        and db.scalar(select(XPostSource.id).where(XPostSource.media_id == UUID(citation.media_id)))
        is not None
    ):
        media_id = UUID(citation.media_id)
        lock_media_for_reference(db, media_id)
        viewer_id = db.scalar(
            text("""
            SELECT c.owner_user_id FROM messages msg
            JOIN conversations c ON c.id = msg.conversation_id WHERE msg.id = :id
        """),
            {"id": assistant_message_id},
        )
        if viewer_id is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    return db.execute(
        _INSERT,
        {
            "assistant_message_id": assistant_message_id,
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "result_type": citation.result_type,
            "source_id": citation.source_id,
            "media_id": citation.media_id,
            "evidence_span_id": citation.evidence_span_id,
            "context_ref": compact(citation.context_ref),
            "result_ref": compact(citation.result_ref_json()),
            "selected": selected,
            "locator": citation.locator,
            "captured_evidence": citation.captured_evidence.model_dump(mode="json"),
        },
    ).scalar_one()
