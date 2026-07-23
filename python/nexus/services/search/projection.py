"""InternalSearchResult -> SearchResultOut projection, snippets, locators."""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import RetrievalLocator, retrieval_locator_json
from nexus.schemas.search import (
    ConversationArtifactSearchOut,
    SearchResultContentChunkOut,
    SearchResultContextRefOut,
    SearchResultContributorIdentityOut,
    SearchResultContributorOut,
    SearchResultConversationOut,
    SearchResultEpisodeOut,
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
    SearchResultVideoOut,
    SearchResultWebOut,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.capabilities import resource_citation_result_type
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.search.constants import MAX_SNIPPET_LENGTH, RETRIEVAL_LOCATOR_ADAPTER
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


def _truncate_snippet(snippet: str) -> str:
    """Truncate snippet to max length, preserving highlighted matches."""
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
    if source.published_date:
        parts.append(source.published_date)
    if source.media_kind:
        parts.append(source.media_kind.replace("_", " "))
    return " - ".join(part for part in parts if part)


def _result_context_ref(result: InternalSearchResult) -> SearchResultContextRefOut:
    if isinstance(result, _RankedWebResult):
        return SearchResultContextRefOut(type="web_result", id=result.source_id)
    if isinstance(result, _RankedMediaResult):
        return SearchResultContextRefOut(type="media", id=result.id)
    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContextRefOut(
            type=result.result_type,
            id=result.id,
            evidence_span_ids=result.evidence_span_ids,
        )
    if isinstance(result, _RankedContributorResult):
        return SearchResultContextRefOut(type=result.result_type, id=result.handle)
    return SearchResultContextRefOut(type=result.result_type, id=result.id)


def _direct_fragment_locator(
    *,
    media_id: UUID,
    media_kind: str,
    fragment_id: UUID,
    text_value: str,
    start_offset: int,
    end_offset: int,
    exact: str,
    prefix: str = "",
    suffix: str = "",
    t_start_ms: int | None = None,
    t_end_ms: int | None = None,
    section_id: str | None = None,
) -> dict[str, Any] | None:
    if t_start_ms is not None and t_end_ms is not None:
        if t_end_ms <= t_start_ms or not exact:
            return None
        locator = {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": t_start_ms,
            "t_end_ms": t_end_ms,
            "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
        }
    else:
        if end_offset <= start_offset or len(text_value) < end_offset:
            return None
        if media_kind == "epub":
            locator = {
                "type": "epub_fragment_offsets",
                "media_id": str(media_id),
                "section_id": section_id,
                "fragment_id": str(fragment_id),
                "start_offset": start_offset,
                "end_offset": end_offset,
                "media_kind": media_kind,
                "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }
        elif media_kind != "pdf":
            locator = {
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": start_offset,
                "end_offset": end_offset,
                "media_kind": media_kind,
                "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }
        else:
            return None
    try:
        return retrieval_locator_json(locator)
    except ValueError:
        return None


def _require_resolved_evidence(resolution: dict[str, Any]) -> None:
    resolver = resolution.get("resolver")
    if not isinstance(resolver, dict) or resolver.get("status") != "resolved":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result is stale")


def _result_resource_ref(result: InternalSearchResult) -> ResourceRef:
    if isinstance(result, _RankedWebResult):
        try:
            return ResourceRef(scheme="external_snapshot", id=UUID(result.source_id))
        except ValueError as exc:
            raise AssertionError("web_result search row has no external_snapshot source") from exc
    if isinstance(result, _RankedMediaResult):
        return ResourceRef(scheme="media", id=result.id)
    if isinstance(result, _RankedPodcastResult):
        return ResourceRef(scheme="podcast", id=result.id)
    if isinstance(result, _RankedContributorResult):
        return ResourceRef(scheme="contributor", id=result.id)
    if isinstance(result, _RankedPageResult):
        return ResourceRef(scheme="page", id=result.id)
    if isinstance(result, _RankedContentChunkResult):
        return ResourceRef(scheme="content_chunk", id=result.id)
    if isinstance(result, _RankedFragmentResult):
        return ResourceRef(scheme="fragment", id=result.id)
    if isinstance(result, _RankedNoteBlockResult):
        return ResourceRef(scheme="note_block", id=result.id)
    if isinstance(result, _RankedHighlightResult):
        return ResourceRef(scheme="highlight", id=result.id)
    if isinstance(result, _RankedMessageResult):
        return ResourceRef(scheme="message", id=result.id)
    if isinstance(result, _RankedConversationResult):
        return ResourceRef(scheme="conversation", id=result.id)
    if isinstance(result, _RankedArtifactResult):
        # The exact revision ref lets workspace-local activation select history.
        return ResourceRef(scheme="artifact_revision", id=result.revision_id)
    if isinstance(result, _RankedEvidenceSpanResult):
        return ResourceRef(scheme="evidence_span", id=result.id)
    if isinstance(result, _RankedReaderApparatusItemResult):
        return ResourceRef(scheme="reader_apparatus_item", id=result.id)
    raise AssertionError(f"Unknown search result type: {type(result).__name__}")


def _required_locator(
    result_type: str,
    locator: RetrievalLocator | dict[str, Any] | None,
) -> Any:
    if isinstance(locator, BaseModel):
        return locator
    if isinstance(locator, dict) and locator:
        try:
            RETRIEVAL_LOCATOR_ADAPTER.validate_python(locator)
        except ValidationError as exc:
            raise AssertionError(f"{result_type} search result locator is invalid") from exc
        return locator
    raise AssertionError(f"{result_type} search result is missing locator")


def _result_model_fields(
    db: Session, viewer_id: UUID, result: InternalSearchResult
) -> dict[str, Any]:
    context_ref = _result_context_ref(result)
    ref = _result_resource_ref(result)
    activation = resource_activation_for_ref(db, viewer_id=viewer_id, ref=ref)
    if activation.href is None:
        raise AssertionError(f"{result.result_type} search result is not activatable")
    fields = {
        "resource_ref": ref.uri,
        "activation": activation,
        "citation_target": ref.uri if resource_citation_result_type(ref) is not None else None,
        "context_ref": context_ref,
    }

    if isinstance(result, _RankedPodcastResult):
        source_parts = [result.title]
        source_parts.extend(_credited_names(result.contributors))
        return {
            "title": result.title,
            "source_label": " - ".join(source_parts),
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedContributorResult):
        return {
            "title": result.display_name,
            "source_label": "contributor",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedMessageResult):
        return {
            "title": f"Conversation message #{result.seq}",
            "source_label": f"message #{result.seq}",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedNoteBlockResult):
        return {
            "title": "Note",
            "source_label": "note",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedPageResult):
        return {
            "title": result.title,
            "source_label": "page",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedConversationResult):
        return {
            "title": result.title,
            "source_label": "conversation",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedArtifactResult):
        return {
            "title": "Dossier",
            "source_label": "dossier",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedHighlightResult):
        return {
            "title": result.source.title,
            "source_label": _build_source_label(result.source),
            "media_id": result.source.media_id,
            "media_kind": result.source.media_kind,
            **fields,
        }

    if isinstance(result, _RankedEvidenceSpanResult):
        return {
            "title": result.source.title,
            "source_label": _build_source_label(result.source),
            "media_id": result.source.media_id,
            "media_kind": result.source.media_kind,
            **fields,
        }

    if isinstance(result, _RankedWebResult):
        return {
            "title": result.title,
            "source_label": result.source_name or result.display_url or "web",
            "media_id": None,
            "media_kind": None,
            **fields,
        }

    if isinstance(result, _RankedReaderApparatusItemResult):
        return {
            "title": result.source.title,
            "source_label": _build_source_label(result.source),
            "media_id": result.source.media_id,
            "media_kind": result.source.media_kind,
            **fields,
        }

    source = result.source
    return {
        "title": source.title,
        "source_label": _build_source_label(source),
        "media_id": source.media_id,
        "media_kind": source.media_kind,
        **fields,
    }


def _result_to_out(db: Session, viewer_id: UUID, result: InternalSearchResult) -> SearchResultOut:
    """Convert an internal ranked result into the strict response union."""
    result_id = result.handle if isinstance(result, _RankedContributorResult) else result.id
    base_payload = {
        "id": result_id,
        "score": round(result.score.normalized, 4),
        "snippet": result.snippet,
        **_result_model_fields(db, viewer_id, result),
    }

    if isinstance(result, _RankedMediaResult) and result.result_type == "media":
        return SearchResultMediaOut(
            type="media",
            source=result.source,
            **base_payload,
        )
    if isinstance(result, _RankedMediaResult) and result.result_type == "episode":
        return SearchResultEpisodeOut(
            type="episode",
            source=result.source,
            **base_payload,
        )
    if isinstance(result, _RankedMediaResult) and result.result_type == "video":
        return SearchResultVideoOut(
            type="video",
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedPodcastResult):
        return SearchResultPodcastOut(
            type="podcast",
            contributors=result.contributors,
            **base_payload,
        )

    if isinstance(result, _RankedContributorResult):
        return SearchResultContributorOut(
            type="contributor",
            contributor_handle=result.handle,
            contributor=SearchResultContributorIdentityOut(
                handle=result.handle,
                display_name=result.display_name,
            ),
            **base_payload,
        )

    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContentChunkOut(
            type="content_chunk",
            source_kind=result.source_kind,
            evidence_span_ids=result.evidence_span_ids,
            citation_label=result.citation_label,
            locator=_required_locator("content_chunk", result.locator),
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedEvidenceSpanResult):
        return SearchResultEvidenceSpanOut(
            type="evidence_span",
            evidence_span_id=result.id,
            citation_label=result.citation_label,
            locator=_required_locator("evidence_span", result.locator),
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedReaderApparatusItemResult):
        return SearchResultReaderApparatusItemOut(
            type="reader_apparatus_item",
            source=result.source,
            apparatus_kind=result.apparatus_kind,
            locator=_required_locator("reader_apparatus_item", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedFragmentResult):
        return SearchResultFragmentOut(
            type="fragment",
            source=result.source,
            citation_label=result.citation_label,
            locator=_required_locator("fragment", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedPageResult):
        return SearchResultPageOut(
            type="page",
            **base_payload,
        )

    if isinstance(result, _RankedNoteBlockResult):
        return SearchResultNoteBlockOut(
            type="note_block",
            body_text=result.body_text,
            highlight_excerpt=result.highlight_excerpt,
            locator=_required_locator("note_block", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedHighlightResult):
        return SearchResultHighlightOut(
            type="highlight",
            color=result.color,
            exact=result.exact,
            source=result.source,
            citation_label=result.citation_label,
            locator=_required_locator("highlight", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedMessageResult):
        return SearchResultMessageOut(
            type="message",
            conversation_id=result.conversation_id,
            seq=result.seq,
            locator=_required_locator("message", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedConversationResult):
        return SearchResultConversationOut(
            type="conversation",
            **base_payload,
        )

    if isinstance(result, _RankedArtifactResult):
        return ConversationArtifactSearchOut(
            type="artifact",
            revision_id=result.revision_id,
            subject_ref=f"conversation:{result.id}",
            **base_payload,
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
            **base_payload,
        )

    raise AssertionError(f"Unknown search result type: {type(result).__name__}")
