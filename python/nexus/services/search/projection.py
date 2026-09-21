"""Internal ranked result → the strict ``SearchResultOut`` wire union."""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy.orm import Session

from nexus.schemas.presence import Present
from nexus.schemas.retrieval import RetrievalLocator
from nexus.schemas.search import (
    ConversationArtifactSearchOut,
    SearchResultContentChunkOut,
    SearchResultContextRefOut,
    SearchResultContributorIdentityOut,
    SearchResultContributorOut,
    SearchResultConversationOut,
    SearchResultEvidenceSpanOut,
    SearchResultFragmentOut,
    SearchResultHighlightOut,
    SearchResultMediaOut,
    SearchResultMessageOut,
    SearchResultNoteBlockOut,
    SearchResultOut,
    SearchResultPageOut,
    SearchResultPodcastOut,
    SearchResultReaderApparatusItemOut,
    SearchResultSourceOut,
    SearchResultWebOut,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items.capabilities import resource_citation_result_type
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.search.results import (
    InternalSearchResult,
    _credited_names,
    _RankedArtifactResult,
    _RankedContentChunkResult,
    _RankedContributorResult,
    _RankedConversationResult,
    _RankedEvidenceSpanResult,
    _RankedFragmentResult,
    _RankedHighlightResult,
    _RankedMediaResult,
    _RankedMessageResult,
    _RankedNoteBlockResult,
    _RankedPageResult,
    _RankedPodcastResult,
    _RankedReaderApparatusItemResult,
    _RankedWebResult,
)

MAX_SNIPPET_LENGTH = 300
_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)

# The result type IS the ResourceRef scheme for every variant except
# web_result (external_snapshot) and artifact (its exact revision).
_RESULT_SCHEME: dict[str, ResourceScheme] = {
    "media": "media",
    "episode": "media",
    "video": "media",
    "podcast": "podcast",
    "content_chunk": "content_chunk",
    "fragment": "fragment",
    "contributor": "contributor",
    "page": "page",
    "note_block": "note_block",
    "highlight": "highlight",
    "message": "message",
    "evidence_span": "evidence_span",
    "conversation": "conversation",
    "reader_apparatus_item": "reader_apparatus_item",
}

# Passage-like rows activate their precise match but act on the readable owner.
_PASSAGE_TYPES = frozenset({"content_chunk", "fragment", "evidence_span", "reader_apparatus_item"})


def _truncate_snippet(snippet: str) -> str:
    """Truncate to the snippet budget, preserving the highlighted match."""
    if len(snippet) <= MAX_SNIPPET_LENGTH:
        return snippet

    match_start = snippet.lower().find("<b>")
    if match_start > MAX_SNIPPET_LENGTH:
        start = max(0, match_start - MAX_SNIPPET_LENGTH // 3)
        first_space = snippet.find(" ", start, match_start)
        if first_space != -1:
            start = first_space + 1

        end = min(len(snippet), start + MAX_SNIPPET_LENGTH)
        last_space = snippet.rfind(" ", match_start, end)
        if last_space > match_start:
            end = last_space

        return f"...{snippet[start:end]}{'...' if end < len(snippet) else ''}"

    truncated = snippet[:MAX_SNIPPET_LENGTH]
    last_space = truncated.rfind(" ")
    if last_space > MAX_SNIPPET_LENGTH // 2:
        truncated = truncated[:last_space]

    return truncated + "..."


def _snippet_around_query(text: str, query: str) -> str | None:
    """A window of ``text`` around the query, with the match wrapped in <b>."""
    query = " ".join(query.split())
    if not text or not query:
        return None

    text_lower = text.lower()
    query_lower = query.lower()
    match_start = text_lower.find(query_lower)
    match_len = len(query)

    if match_start == -1:
        terms = [term for term in re.findall(r"[a-z0-9]+", query_lower) if len(term) >= 2]
        positions = [(text_lower.find(term), len(term)) for term in terms]
        positions = [position for position in positions if position[0] != -1]
        if not positions:
            return None
        match_start, match_len = min(positions, key=lambda position: position[0])

    prefix = "..." if match_start > MAX_SNIPPET_LENGTH // 3 else ""
    body_limit = MAX_SNIPPET_LENGTH - len(prefix) - len("...") - len("<b></b>")
    start = max(0, match_start - MAX_SNIPPET_LENGTH // 3)
    first_space = text.find(" ", start, match_start)
    if first_space != -1:
        start = first_space + 1

    end = min(len(text), start + body_limit)
    if end < match_start + match_len:
        end = min(len(text), match_start + match_len)
    last_space = text.rfind(" ", match_start + match_len, end)
    if last_space > match_start + match_len:
        end = last_space

    suffix = "..." if end < len(text) else ""
    local_match_start = match_start - start
    body = text[start : local_match_start + start]
    body += f"<b>{text[match_start : match_start + match_len]}</b>"
    body += text[match_start + match_len : end]
    return f"{prefix}{body}{suffix}"


def _build_source_label(source: SearchResultSourceOut) -> str:
    parts = [source.title]
    credited_names = _credited_names(source.contributors)
    if credited_names:
        parts.append(", ".join(credited_names))
    if isinstance(source.original_published_date, Present):
        parts.append(source.original_published_date.value)
    if source.media_kind:
        parts.append(source.media_kind.replace("_", " "))
    return " - ".join(part for part in parts if part)


def _result_resource_ref(result: InternalSearchResult) -> ResourceRef:
    """The durable resource this occurrence names."""
    if isinstance(result, _RankedWebResult):
        try:
            return ResourceRef(scheme="external_snapshot", id=UUID(result.source_id))
        except ValueError as exc:
            raise AssertionError("web_result search row has no external_snapshot source") from exc
    if isinstance(result, _RankedArtifactResult):
        # The exact revision ref lets workspace-local activation select history.
        return ResourceRef(scheme="artifact_revision", id=result.revision_id)
    return ResourceRef(scheme=_RESULT_SCHEME[result.result_type], id=result.id)


def _owner_ref(result: InternalSearchResult) -> ResourceRef:
    """The primary resource that receives this occurrence."""
    if isinstance(result, _RankedEvidenceSpanResult):
        return result.owner_ref
    if isinstance(
        result,
        _RankedContentChunkResult
        | _RankedFragmentResult
        | _RankedHighlightResult
        | _RankedReaderApparatusItemResult,
    ):
        return ResourceRef(scheme="media", id=result.source.media_id)
    if isinstance(result, _RankedMessageResult):
        return ResourceRef(scheme="conversation", id=result.conversation_id)
    if isinstance(result, _RankedArtifactResult):
        return ResourceRef(scheme="conversation", id=result.id)
    return _result_resource_ref(result)


def _context_ref(result: InternalSearchResult) -> SearchResultContextRefOut:
    if isinstance(result, _RankedWebResult):
        return SearchResultContextRefOut(type="web_result", id=result.source_id)
    if isinstance(result, _RankedMediaResult):
        # An episode or video row names the media it is: the decoder requires it.
        return SearchResultContextRefOut(type="media", id=result.id)
    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContextRefOut(
            type="content_chunk", id=result.id, evidence_span_ids=result.evidence_span_ids
        )
    if isinstance(result, _RankedContributorResult):
        return SearchResultContextRefOut(type="contributor", id=result.handle)
    return SearchResultContextRefOut(type=result.result_type, id=result.id)


def _required_locator(result_type: str, locator: RetrievalLocator | dict[str, Any] | None) -> Any:
    if isinstance(locator, BaseModel):
        return locator
    if isinstance(locator, dict) and locator:
        try:
            _LOCATOR_ADAPTER.validate_python(locator)
        except ValidationError as exc:
            raise AssertionError(f"{result_type} search result locator is invalid") from exc
        return locator
    raise AssertionError(f"{result_type} search result is missing locator")


def _envelope(
    db: Session, viewer_id: UUID, result: InternalSearchResult, snippet: str
) -> dict[str, Any]:
    """The base fields every variant carries, including its titles and refs."""
    ref = _result_resource_ref(result)
    owner = _owner_ref(result)
    activation = resource_activation_for_ref(db, viewer_id=viewer_id, ref=ref, missing=False)
    if activation.href is None:
        raise AssertionError(f"{result.result_type} search result is not activatable")

    if isinstance(result, _RankedPodcastResult):
        title, label = (
            result.title,
            " - ".join([result.title, *_credited_names(result.contributors)]),
        )
        media_id, media_kind = None, None
    elif isinstance(result, _RankedContributorResult):
        title, label, media_id, media_kind = result.display_name, "contributor", None, None
    elif isinstance(result, _RankedMessageResult):
        title = f"Conversation message #{result.seq}"
        label, media_id, media_kind = f"message #{result.seq}", None, None
    elif isinstance(result, _RankedNoteBlockResult):
        title, label, media_id, media_kind = "Note", "note", None, None
    elif isinstance(result, _RankedPageResult):
        title, label, media_id, media_kind = result.title, "page", None, None
    elif isinstance(result, _RankedConversationResult):
        title, label, media_id, media_kind = result.title, "conversation", None, None
    elif isinstance(result, _RankedArtifactResult):
        title, label, media_id, media_kind = "Dossier", "dossier", None, None
    elif isinstance(result, _RankedWebResult):
        title = result.title
        label = result.source_name or result.display_url or "web"
        media_id, media_kind = None, None
    else:
        title, label = result.source.title, _build_source_label(result.source)
        media_id, media_kind = result.source.media_id, result.source.media_kind

    return {
        "id": result.handle if isinstance(result, _RankedContributorResult) else result.id,
        "score": round(result.score.normalized, 4),
        "snippet": snippet,
        "title": title,
        "source_label": label,
        "media_id": media_id,
        "media_kind": media_kind,
        "resource_ref": ref.uri,
        "owner_resource_ref": owner.uri,
        "action_subject_ref": (owner if result.result_type in _PASSAGE_TYPES else ref).uri,
        "activation": activation.model_dump(mode="python", by_alias=False),
        "citation_target": ref.uri if resource_citation_result_type(ref) is not None else None,
        "context_ref": _context_ref(result),
    }


def _result_to_out(db: Session, viewer_id: UUID, result: InternalSearchResult) -> SearchResultOut:
    """Convert one internal ranked result into the strict response union."""
    if isinstance(result, _RankedFragmentResult):
        from nexus.services.search.retrievers import read_fragment_search_content

        snippet, locator = read_fragment_search_content(db, viewer_id=viewer_id, result=result)
        return SearchResultFragmentOut(
            type="fragment",
            source=result.source,
            citation_label=f"fragment {result.idx + 1}",
            locator=_required_locator("fragment", locator),
            **_envelope(db, viewer_id, result, snippet),
        )

    base = _envelope(db, viewer_id, result, result.snippet)
    if isinstance(result, _RankedPodcastResult):
        return SearchResultPodcastOut(type="podcast", contributors=result.contributors, **base)
    if isinstance(result, _RankedContributorResult):
        return SearchResultContributorOut(
            type="contributor",
            contributor_handle=result.handle,
            contributor=SearchResultContributorIdentityOut(
                handle=result.handle, display_name=result.display_name
            ),
            **base,
        )
    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContentChunkOut(
            type="content_chunk",
            source_kind=result.source_kind,
            evidence_span_ids=result.evidence_span_ids,
            citation_label=result.citation_label,
            locator=_required_locator("content_chunk", result.locator),
            source=result.source,
            **base,
        )
    if isinstance(result, _RankedEvidenceSpanResult):
        return SearchResultEvidenceSpanOut(
            type="evidence_span",
            evidence_span_id=result.id,
            citation_label=result.citation_label,
            locator=_required_locator("evidence_span", result.locator),
            source=result.source,
            **base,
        )
    if isinstance(result, _RankedReaderApparatusItemResult):
        return SearchResultReaderApparatusItemOut(
            type="reader_apparatus_item",
            source=result.source,
            apparatus_kind=result.apparatus_kind,
            locator=_required_locator("reader_apparatus_item", result.locator),
            **base,
        )
    if isinstance(result, _RankedPageResult):
        return SearchResultPageOut(type="page", **base)
    if isinstance(result, _RankedNoteBlockResult):
        return SearchResultNoteBlockOut(
            type="note_block",
            body_text=result.body_text,
            highlight_excerpt=result.highlight_excerpt,
            note_origin=result.note_origin,
            locator=_required_locator("note_block", result.locator),
            **base,
        )
    if isinstance(result, _RankedHighlightResult):
        return SearchResultHighlightOut(
            type="highlight",
            color=result.color,
            exact=result.exact,
            source=result.source,
            citation_label=result.citation_label,
            locator=_required_locator("highlight", result.locator),
            **base,
        )
    if isinstance(result, _RankedMessageResult):
        return SearchResultMessageOut(
            type="message",
            conversation_id=result.conversation_id,
            seq=result.seq,
            locator=_required_locator("message", result.locator),
            **base,
        )
    if isinstance(result, _RankedConversationResult):
        return SearchResultConversationOut(type="conversation", **base)
    if isinstance(result, _RankedArtifactResult):
        return ConversationArtifactSearchOut(
            type="artifact",
            revision_id=result.revision_id,
            subject_ref=f"conversation:{result.id}",
            **base,
        )
    if isinstance(result, _RankedWebResult):
        return SearchResultWebOut(
            type="web_result",
            result_type="web_result",
            source_id=result.source_id,
            result_ref=result.result_ref,
            url=result.url,
            display_url=result.display_url,
            extra_snippets=result.extra_snippets,
            published_at=result.published_at,
            source_name=result.source_name,
            rank=result.rank,
            provider=result.provider,
            provider_request_id=result.provider_request_id,
            locator=_required_locator("web_result", result.locator),
            selected=result.selected,
            **base,
        )
    return SearchResultMediaOut(type=result.result_type, source=result.source, **base)
