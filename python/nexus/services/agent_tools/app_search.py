"""Provider-neutral app-search tool execution for chat.

The chat pipeline uses this module as the canonical read-only tool for finding
relevant app content before the final model call. It deliberately persists only
privacy-safe query metadata: raw user queries are never stored in tool tables.
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_highlight,
    can_read_media,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.coerce import parse_uuid
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_result_ref_json,
)
from nexus.services import media_intelligence
from nexus.services.contributor_taxonomy import CONTRIBUTOR_ROLES
from nexus.services.contributors import get_contributor_by_handle
from nexus.services.media_intelligence import MediaUnit
from nexus.services.resource_graph.context import (
    conversation_has_note_search_scope_refs,
    search_scope_refs_for_conversation,
)
from nexus.services.resource_graph.refs import (
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items.capabilities import (
    app_search_scope_hint,
    resource_can_be_app_search_scope,
)
from nexus.services.retrieval_citation import (
    RetrievalCitation,
    citation_from_search_result,
    insert_retrieval_row,
    strict_citation_locator,
)
from nexus.services.search import search
from nexus.services.search.batch import search_scopes
from nexus.services.search.kinds import SEARCH_FORMATS, SEARCH_KINDS
from nexus.services.search.query import build_search_query
from nexus.services.search.scope import (
    ScopeUnsupported,
    parse_scope,
    scope_filter_sql,
    scope_from_uri,
)
from nexus.services.search.telemetry import hash_query
from nexus.timestamps import format_timestamp_ms

logger = get_logger(__name__)


def _xml_attr(value: object) -> str:
    return xml_escape(str(value), {'"': "&quot;"})


APP_SEARCH_TOOL_NAME = "app_search"
APP_SEARCH_LIMIT = 8
APP_SEARCH_SELECTED_LIMIT = 6
APP_SEARCH_CONTEXT_CHARS = 16000
APP_SEARCH_SCOPE_HINT = app_search_scope_hint()

APP_SEARCH_TOOL_DEFINITION: dict[str, Any] = {
    "name": APP_SEARCH_TOOL_NAME,
    "description": (
        "Search across your saved articles, books, podcasts, PDFs, highlights, "
        "and notes. By default, searches within the conversation's referenced "
        f"search scopes. Pass scopes using {APP_SEARCH_SCOPE_HINT} to "
        "narrow further."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "kinds": {
                "type": "array",
                "items": {"type": "string", "enum": list(SEARCH_KINDS)},
                "description": (
                    "Optional user-facing kinds to search: documents, notes, "
                    "highlights, conversations, people, web."
                ),
            },
            "formats": {
                "type": "array",
                "items": {"type": "string", "enum": list(SEARCH_FORMATS)},
                "description": (
                    "Optional document formats: article, pdf, epub, video, episode, podcast."
                ),
            },
            "authors": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional contributor handles to filter credited content.",
            },
            "roles": {
                "type": "array",
                "items": {"type": "string", "enum": sorted(CONTRIBUTOR_ROLES)},
                "description": "Optional contributor roles to filter credited content.",
            },
            "scopes": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    f"Optional URI scopes ({APP_SEARCH_SCOPE_HINT}) "
                    "from this conversation's context refs. Defaults to all "
                    "search-scope context refs."
                ),
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
}


@dataclass(slots=True)
class AppSearchRun:
    """Executed app-search tool call."""

    conversation_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    query_hash: str
    scope: str
    requested_types: list[str]
    citations: list[RetrievalCitation]
    selected_citations: list[RetrievalCitation]
    context_text: str
    context_chars: int
    latency_ms: int
    status: str
    error_code: str | None = None
    filters: dict[str, Any] = field(default_factory=dict)
    empty_status: str | None = None
    tool_call_id: UUID | None = None
    tool_call_index: int = 0

    def tool_call_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": APP_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": "running",
            "scope": self.scope,
            "types": self.requested_types,
            "filters": self.filters,
        }

    def retrieval_result_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": APP_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": self.status,
            "error_code": self.error_code,
            "result_count": len(self.citations),
            "selected_count": len(self.selected_citations),
            "latency_ms": self.latency_ms,
            "filters": self.filters,
            "results": [citation.result_ref_json() for citation in self.citations],
        }


class InvalidScopeError(Exception):
    """Raised when a caller-supplied scope URI is not a valid conversation context ref."""


def execute_app_search(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    scopes: Sequence[str],
    query: str,
    kinds: Sequence[str] | None = None,
    formats: Sequence[str] | None = None,
    authors: Sequence[str] | None = None,
    roles: Sequence[str] | None = None,
    tool_call_index: int = 0,
    forced_error: str | None = None,
) -> AppSearchRun:
    """Run app search for a chat turn and persist tool/retrieval metadata."""
    filters: dict[str, Any] = {
        key: list(values)
        for key, values in (
            ("kinds", kinds),
            ("formats", formats),
            ("authors", authors),
            ("roles", roles),
        )
        if values is not None
    }
    requested_types: list[str] = []
    start = time.monotonic()
    status = "complete"
    error_code = None
    empty_status: str | None = None

    # Empty input → use conversation's media/library context refs; explicit
    # input → validate each URI is a media/library reference of this
    # conversation.
    try:
        if forced_error is not None:
            raise InvalidScopeError(forced_error)
        base_query = build_search_query(
            text=query,
            raw_kinds=None if kinds is None else list(kinds),
            raw_formats=None if formats is None else list(formats),
            raw_authors=None if authors is None else list(authors),
            raw_roles=None if roles is None else list(roles),
            scope=scope_from_uri("all"),
            cursor=None,
            limit=APP_SEARCH_LIMIT,
        )
        requested_types = list(base_query.effective_result_types)
        resolved_scopes = _resolve_scope_uris(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
            scopes=scopes,
        )
    except (ApiError, InvalidScopeError) as exc:
        error_code = (
            exc.code.value if isinstance(exc, ApiError) else ApiErrorCode.E_INVALID_REQUEST.value
        )
        context_text = (
            '<app_search_results status="error" '
            f'code="{_xml_attr(error_code)}" '
            f'message="{_xml_attr(str(exc))}" />'
        )
        latency_ms = int((time.monotonic() - start) * 1000)
        run = AppSearchRun(
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            query_hash=hash_query(query),
            scope="all",
            requested_types=requested_types,
            citations=[],
            selected_citations=[],
            context_text=context_text,
            context_chars=len(context_text),
            latency_ms=latency_ms,
            status="error",
            error_code=error_code,
            filters=filters,
            empty_status=None,
            tool_call_index=tool_call_index,
        )
        persist_app_search_run(db, run)
        return run

    # Persisted on MessageRetrieval rows as a comma-joined URI list for
    # multiple scopes (e.g. "media:UUID-1,media:UUID-2"), the lone URI for
    # one scope, or "all" when no scopes apply.
    scope = ",".join(resolved_scopes) if resolved_scopes else "all"

    try:
        if resolved_scopes:
            response = search_scopes(
                db,
                viewer_id,
                base_query,
                [scope_from_uri(scope_uri) for scope_uri in resolved_scopes],
            )
        else:
            response = search(db, viewer_id, base_query)
        citations = [
            citation_from_search_result(result, filters=filters) for result in response.results
        ]
        context_text, context_chars, selected = render_retrieved_context_blocks(
            db,
            viewer_id=viewer_id,
            citations=citations,
        )
        if not context_text and not citations:
            result_status = _empty_status_for_scopes(
                db,
                viewer_id=viewer_id,
                scopes=resolved_scopes,
            )
            empty_status = result_status
            context_text = (
                f'<app_search_results status="{_xml_attr(result_status)}" '
                f'scope="{_xml_attr(scope)}" '
                f'filters="{_xml_attr(json.dumps(filters, sort_keys=True))}" />'
            )
            context_chars = len(context_text)
    except ApiError as exc:
        db.rollback()
        logger.warning(
            "agent_app_search_api_error",
            query_hash=hash_query(query),
            scope=scope,
            filters=filters,
            error_code=exc.code.value,
            error=str(exc),
        )
        status = "error"
        error_code = exc.code.value
        empty_status = None
        citations = []
        selected = []
        context_text = ""
        context_chars = 0

    latency_ms = int((time.monotonic() - start) * 1000)
    run = AppSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash=hash_query(query),
        scope=scope,
        requested_types=requested_types,
        citations=citations,
        selected_citations=selected,
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        filters=filters,
        empty_status=empty_status,
        tool_call_index=tool_call_index,
    )
    persist_app_search_run(db, run)
    return run


def _resolve_scope_uris(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    scopes: Sequence[str],
) -> list[str]:
    """Validate and return scope URIs for the search.

    Empty input: returns the conversation's media/library context URIs.
    Non-empty input: validates each URI is a media:/library: context ref of the
    conversation; raises InvalidScopeError otherwise.
    """
    scope_uris = [
        ref.uri
        for ref in search_scope_refs_for_conversation(
            db, viewer_id=viewer_id, conversation_id=conversation_id
        )
    ]

    if not scopes:
        if conversation_has_note_search_scope_refs(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
        ):
            scope_uris.append(f"conversation:{conversation_id}")
        return scope_uris

    allowed = set(scope_uris)
    resolved: list[str] = []
    seen: set[str] = set()
    for raw in scopes:
        uri = str(raw).strip()
        if not uri:
            raise InvalidScopeError("app_search scopes must be non-empty URI strings")
        if uri in seen:
            continue
        parsed = parse_resource_ref(uri)
        if isinstance(parsed, ResourceRefParseFailure) or not resource_can_be_app_search_scope(
            parsed
        ):
            raise InvalidScopeError(f"scope must be one of {APP_SEARCH_SCOPE_HINT}: {uri}")
        if uri not in allowed:
            raise InvalidScopeError(f"scope must be in conversation context: {uri}")
        seen.add(uri)
        resolved.append(uri)
    return resolved


def _empty_status_for_scopes(
    db: Session,
    *,
    viewer_id: UUID,
    scopes: Sequence[str],
) -> str:
    """Distinguish 'no_results' from 'no_indexed_evidence' across scopes."""
    if not scopes:
        return "no_results"
    for scope_uri in scopes:
        status = _scoped_content_chunk_empty_status(
            db,
            viewer_id=viewer_id,
            scope=scope_uri,
        )
        if status == "no_results":
            return "no_results"
    return "no_indexed_evidence"


def _scoped_content_chunk_empty_status(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
) -> str:
    scope_type, scope_id = parse_scope(scope)
    # Reuse the §4.6 scope owner so this probe filters identically to the content_chunk
    # retriever.
    scope_clause = scope_filter_sql(scope_type, scope_id, "content_chunk")
    if isinstance(scope_clause, ScopeUnsupported):
        return "no_indexed_evidence"
    scope_filter, scope_params = scope_clause
    params: dict[str, Any] = {"viewer_id": viewer_id, **scope_params}

    note_exists = ""
    note_clause = scope_filter_sql(scope_type, scope_id, "note_block")
    if not isinstance(note_clause, ScopeUnsupported):
        note_scope_filter, _ = note_clause  # same :scope_id bind, already in params
        note_exists = f"""
            OR EXISTS (
                SELECT 1
                FROM content_chunks cc
                JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
                    AND nb.user_id = :viewer_id
                JOIN content_index_states ncis ON ncis.owner_kind = cc.owner_kind
                    AND ncis.owner_id = cc.owner_id AND ncis.status = 'ready'
                WHERE TRUE
                {note_scope_filter}
            )
        """

    row = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT 1 WHERE
            EXISTS (
                SELECT 1
                FROM content_chunks cc
                JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                JOIN visible_media vm ON vm.media_id = cc.owner_id AND cc.owner_kind = 'media'
                JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                    AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                    AND es.owner_kind = cc.owner_kind AND es.owner_id = cc.owner_id
                WHERE TRUE
                {scope_filter}
            )
            {note_exists}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return "no_results" if row is not None else "no_indexed_evidence"


def persist_app_search_run(db: Session, run: AppSearchRun) -> None:
    """Persist the app-search tool call and retrieval rows."""
    result_refs = [
        retrieval_result_ref_json(citation.result_ref_json()) for citation in run.citations
    ]
    selected_context_refs = [
        retrieval_context_ref_json(citation.context_ref) for citation in run.selected_citations
    ]
    existing = db.execute(
        text(
            """
            SELECT id
            FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
              AND tool_call_index = :tool_call_index
            FOR UPDATE
            """
        ),
        {
            "assistant_message_id": run.assistant_message_id,
            "tool_call_index": run.tool_call_index,
        },
    ).first()

    if existing is None:
        insert_tool = text(
            """
            INSERT INTO message_tool_calls (
                conversation_id,
                user_message_id,
                assistant_message_id,
                tool_name,
                tool_call_index,
                query_hash,
                scope,
                requested_types,
                result_refs,
                selected_context_refs,
                provider_request_ids,
                latency_ms,
                status,
                error_code
            )
            VALUES (
                :conversation_id,
                :user_message_id,
                :assistant_message_id,
                :tool_name,
                :tool_call_index,
                :query_hash,
                :scope,
                :requested_types,
                :result_refs,
                :selected_context_refs,
                '[]'::jsonb,
                :latency_ms,
                :status,
                :error_code
            )
            RETURNING id
            """
        ).bindparams(
            bindparam("requested_types", type_=JSONB),
            bindparam("result_refs", type_=JSONB),
            bindparam("selected_context_refs", type_=JSONB),
        )
        tool_call_id = db.execute(
            insert_tool,
            {
                "conversation_id": run.conversation_id,
                "user_message_id": run.user_message_id,
                "assistant_message_id": run.assistant_message_id,
                "tool_name": APP_SEARCH_TOOL_NAME,
                "tool_call_index": run.tool_call_index,
                "query_hash": run.query_hash,
                "scope": run.scope,
                "requested_types": run.requested_types,
                "result_refs": result_refs,
                "selected_context_refs": selected_context_refs,
                "latency_ms": run.latency_ms,
                "status": run.status,
                "error_code": run.error_code,
            },
        ).scalar_one()
    else:
        tool_call_id = existing[0]
        update_tool = text(
            """
            UPDATE message_tool_calls
            SET query_hash = :query_hash,
                scope = :scope,
                requested_types = :requested_types,
                result_refs = :result_refs,
                selected_context_refs = :selected_context_refs,
                latency_ms = :latency_ms,
                status = :status,
                error_code = :error_code,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ).bindparams(
            bindparam("requested_types", type_=JSONB),
            bindparam("result_refs", type_=JSONB),
            bindparam("selected_context_refs", type_=JSONB),
        )
        db.execute(
            update_tool,
            {
                "tool_call_id": tool_call_id,
                "query_hash": run.query_hash,
                "scope": run.scope,
                "requested_types": run.requested_types,
                "result_refs": result_refs,
                "selected_context_refs": selected_context_refs,
                "latency_ms": run.latency_ms,
                "status": run.status,
                "error_code": run.error_code,
            },
        )
    run.tool_call_id = tool_call_id

    insert_candidate_ledger = text(
        """
        INSERT INTO message_retrieval_candidate_ledgers (
            tool_call_id,
            retrieval_id,
            ordinal,
            result_type,
            source_id,
            score,
            selected,
            included_in_prompt,
            selection_status,
            selection_reason,
            result_ref,
            locator
        )
        VALUES (
            :tool_call_id,
            :retrieval_id,
            :ordinal,
            :result_type,
            :source_id,
            :score,
            :selected,
            false,
            :selection_status,
            :selection_reason,
            :result_ref,
            :locator
        )
        """
    ).bindparams(
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    selected_ids = {citation.source_id for citation in run.selected_citations}
    persisted_count = 0
    for ordinal, citation in enumerate(run.citations):
        selected = citation.source_id in selected_ids
        locator = strict_citation_locator(citation)
        result_ref = retrieval_result_ref_json(citation.result_ref_json())
        retrieval_id = insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=ordinal,
            citation=citation,
            selected=selected,
            scope=run.scope,
            retrieval_status="selected" if selected else "retrieved",
        )
        db.execute(
            insert_candidate_ledger,
            {
                "tool_call_id": tool_call_id,
                "retrieval_id": retrieval_id,
                "ordinal": ordinal,
                "result_type": citation.result_type,
                "source_id": citation.source_id,
                "score": citation.score,
                "selected": selected,
                "selection_status": "selected" if selected else "retrieved",
                "selection_reason": "within_context_budget" if selected else "below_selected_limit",
                "result_ref": result_ref,
                "locator": locator,
            },
        )
        persisted_count = ordinal + 1
    # Trim over-count rows from a previous attempt, cleaning their citation edges
    # too. Deferred import: chat_runs imports this module, so the chat-run-owned
    # prune owner is reached lazily to break the cycle.
    from nexus.services.chat_runs import prune_tool_call_retrievals

    prune_tool_call_retrievals(db, tool_call_id=tool_call_id, min_ordinal=persisted_count)
    db.execute(
        text(
            """
            INSERT INTO message_rerank_ledgers (
                tool_call_id,
                strategy,
                input_count,
                selected_count,
                budget_chars,
                selected_chars,
                status,
                metadata
            )
            VALUES (
                :tool_call_id,
                'search_score_then_context_budget',
                :input_count,
                :selected_count,
                :budget_chars,
                :selected_chars,
                :status,
                :metadata
            )
            """
        ).bindparams(bindparam("metadata", type_=JSONB)),
        {
            "tool_call_id": tool_call_id,
            "input_count": len(run.citations),
            "selected_count": len(run.selected_citations),
            "budget_chars": APP_SEARCH_CONTEXT_CHARS,
            "selected_chars": run.context_chars,
            "status": run.status,
            "metadata": {
                "selected_limit": APP_SEARCH_SELECTED_LIMIT,
                "scope": run.scope,
            },
        },
    )
    db.commit()


def render_retrieved_context_blocks(
    db: Session,
    *,
    viewer_id: UUID,
    citations: list[RetrievalCitation],
) -> tuple[str, int, list[RetrievalCitation]]:
    """Render selected search citations into bounded prompt context blocks."""
    rendered_blocks: list[str] = []
    selected: list[RetrievalCitation] = []
    total_chars = 0

    for citation in citations:
        block = _render_single_retrieved_context(db, viewer_id, citation)
        if not block:
            continue
        block_chars = len(block)
        if total_chars + block_chars > APP_SEARCH_CONTEXT_CHARS:
            break
        citation.selected = True
        selected.append(citation)
        rendered_blocks.append(block)
        total_chars += block_chars
        if len(selected) >= APP_SEARCH_SELECTED_LIMIT:
            break

    if not rendered_blocks:
        return "", 0, selected
    return "\n\n".join(rendered_blocks), total_chars, selected


def _render_single_retrieved_context(
    db: Session,
    viewer_id: UUID,
    citation: RetrievalCitation,
) -> str | None:
    context_type = citation.context_ref.get("type")
    if context_type == "contributor":
        return _render_contributor_context(
            db,
            viewer_id,
            citation.result_ref.get("contributor_handle") or citation.context_ref.get("id"),
        )

    context_id = parse_uuid(citation.context_ref.get("id"))
    if context_id is None:
        return None

    if context_type in {"media", "episode", "video"}:
        if not can_read_media(db, viewer_id, context_id):
            return None
        return _render_media_block(db, context_id)

    if context_type == "page":
        return _render_page_block(db, viewer_id, context_id)

    if context_type == "note_block":
        return _render_note_block_block(db, viewer_id, context_id)

    if context_type == "highlight":
        if not can_read_highlight(db, viewer_id, context_id):
            return None
        return _render_highlight_block(db, context_id)

    if context_type == "fragment":
        return _render_fragment_context(db, viewer_id, context_id, citation)

    if context_type == "content_chunk":
        evidence_span_id = parse_uuid(citation.evidence_span_id)
        if evidence_span_id is None:
            return None
        return _render_content_chunk_context(db, viewer_id, context_id, evidence_span_id, citation)

    if context_type == "message":
        return _render_message_context(db, viewer_id, context_id, citation)

    if context_type == "conversation":
        if not can_read_conversation(db, viewer_id, context_id):
            return None
        return _render_conversation_block(db, context_id)

    if context_type == "evidence_span":
        return _render_evidence_span_block(db, viewer_id, context_id)

    if context_type == "reader_apparatus_item":
        return _render_reader_apparatus_item_block(db, viewer_id, context_id, citation)

    if context_type == "podcast":
        return _render_podcast_context(db, viewer_id, context_id, citation)

    return None


def _render_media_block(db: Session, media_id: UUID) -> str | None:
    row = db.execute(
        text("SELECT title, canonical_source_url FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).fetchone()
    if row is None:
        return None
    lines = ['<app_search_result type="media">', f"<source>{xml_escape(row[0] or '')}</source>"]
    if row[1]:
        lines.append(f"<url>{xml_escape(row[1])}</url>")
    unit = media_intelligence.get_media_unit(db, media_id=media_id)
    if isinstance(unit, MediaUnit) and unit.summary_md:
        lines.append(f"<summary>{xml_escape(unit.summary_md)}</summary>")
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_page_block(db: Session, viewer_id: UUID, page_id: UUID) -> str | None:
    row = db.execute(
        text("SELECT user_id, title FROM pages WHERE id = :page_id"),
        {"page_id": page_id},
    ).fetchone()
    if row is None or row[0] != viewer_id:
        return None
    lines = [
        '<app_search_result type="page">',
        f"<title>{xml_escape(row[1] or '')}</title>",
    ]
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_note_block_block(db: Session, viewer_id: UUID, block_id: UUID) -> str | None:
    row = db.execute(
        text("SELECT user_id, body_text FROM note_blocks WHERE id = :block_id"),
        {"block_id": block_id},
    ).fetchone()
    if row is None or row[0] != viewer_id:
        return None
    lines = [
        '<app_search_result type="note_block">',
        f"<content>{xml_escape(row[1] or '')}</content>",
        "</app_search_result>",
    ]
    return "\n".join(lines)


def _render_highlight_block(db: Session, highlight_id: UUID) -> str | None:
    row = db.execute(
        text("SELECT exact, color FROM highlights WHERE id = :highlight_id"),
        {"highlight_id": highlight_id},
    ).fetchone()
    if row is None:
        return None
    lines = [
        '<app_search_result type="highlight">',
        f"<exact>{xml_escape(row[0] or '')}</exact>",
        f"<color>{xml_escape(row[1] or '')}</color>",
        "</app_search_result>",
    ]
    return "\n".join(lines)


def _render_conversation_block(db: Session, conversation_id: UUID) -> str | None:
    row = db.execute(
        text("SELECT title FROM conversations WHERE id = :conversation_id"),
        {"conversation_id": conversation_id},
    ).fetchone()
    if row is None:
        return None
    lines = [
        '<app_search_result type="conversation">',
        f"<title>{xml_escape(row[0] or '')}</title>",
        "</app_search_result>",
    ]
    return "\n".join(lines)


def _render_evidence_span_block(db: Session, viewer_id: UUID, evidence_span_id: UUID) -> str | None:
    row = db.execute(
        text(
            """
            SELECT
                es.owner_kind,
                es.owner_id,
                es.span_text,
                es.citation_label,
                m.title,
                nb.user_id
            FROM evidence_spans es
            LEFT JOIN media m ON m.id = es.owner_id AND es.owner_kind = 'media'
            LEFT JOIN note_blocks nb ON nb.id = es.owner_id AND es.owner_kind = 'note_block'
            WHERE es.id = :evidence_span_id
            """
        ),
        {"evidence_span_id": evidence_span_id},
    ).fetchone()
    if row is None:
        return None
    if row[0] == "media":
        if not can_read_media(db, viewer_id, row[1]):
            return None
        source = row[4] or ""
    elif row[0] == "note_block":
        if row[5] != viewer_id:
            return None
        source = "Note"
    else:
        return None
    lines = [
        '<app_search_result type="evidence_span">',
        f"<source>{xml_escape(source)}</source>",
        f"<citation_label>{xml_escape(row[3] or '')}</citation_label>",
        f"<evidence_span>{xml_escape(row[2] or '')}</evidence_span>",
        "</app_search_result>",
    ]
    return "\n".join(lines)


def _render_reader_apparatus_item_block(
    db: Session, viewer_id: UUID, item_id: UUID, citation: RetrievalCitation
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT rai.kind, rai.label, rai.body_text, rai.media_id, m.title
            FROM reader_apparatus_items rai
            JOIN media m ON m.id = rai.media_id
            WHERE rai.id = :item_id
            """
        ),
        {"item_id": item_id},
    ).fetchone()
    if row is None or not can_read_media(db, viewer_id, row[3]):
        return None
    lines = [
        '<app_search_result type="reader_apparatus_item">',
        f"<source>{xml_escape(row[4] or '')}</source>",
        f"<apparatus_kind>{xml_escape(row[0] or '')}</apparatus_kind>",
    ]
    if row[1]:
        lines.append(f"<label>{xml_escape(row[1])}</label>")
    lines.append(f"<content>{xml_escape(row[2] or '')}</content>")
    _append_citation_source_xml(lines, citation)
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _append_citation_source_xml(lines: list[str], citation: RetrievalCitation) -> None:
    if citation.locator:
        lines.append(
            "<source_locator>"
            f"{xml_escape(json.dumps(citation.locator, sort_keys=True, separators=(',', ':'), default=str))}"
            "</source_locator>"
        )


def _render_content_chunk_context(
    db: Session,
    viewer_id: UUID,
    chunk_id: UUID,
    evidence_span_id: UUID,
    citation: RetrievalCitation,
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT
                cc.owner_kind,
                cc.owner_id,
                cc.chunk_text,
                cc.summary_locator,
                cc.source_kind,
                m.title,
                m.canonical_source_url,
                es.id,
                es.citation_label,
                es.span_text,
                nb.user_id
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = :evidence_span_id
                AND es.owner_kind = cc.owner_kind AND es.owner_id = cc.owner_id
                AND es.id = cc.primary_evidence_span_id
            JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind AND mcis.owner_id = cc.owner_id
                AND mcis.status = 'ready'
            LEFT JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
            LEFT JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
            WHERE cc.id = :chunk_id
            """
        ),
        {"chunk_id": chunk_id, "evidence_span_id": evidence_span_id},
    ).fetchone()
    if row is None:
        return None
    if row[0] == "media":
        if not can_read_media(db, viewer_id, row[1]):
            return None
        source = row[5] or ""
        url = row[6]
    elif row[0] == "note_block":
        if row[10] != viewer_id:
            return None
        source = "Note"
        url = None
    else:
        return None

    lines = [
        '<app_search_result type="content_chunk">',
        f"<source>{xml_escape(source)}</source>",
        f"<evidence_span_id>{row[7]}</evidence_span_id>",
        f"<citation_label>{xml_escape(row[8])}</citation_label>",
    ]
    if url:
        lines.append(f"<url>{xml_escape(url)}</url>")
    locator = dict(row[3] or {})
    timestamp = format_timestamp_ms(locator.get("t_start_ms"))
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    if row[4]:
        lines.append(f"<source_kind>{xml_escape(str(row[4]))}</source_kind>")
    _append_contributors_xml(lines, citation.contributors)
    lines.append(f"<evidence_span>{xml_escape(row[9] or '')}</evidence_span>")
    _append_citation_source_xml(lines, citation)
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_fragment_context(
    db: Session,
    viewer_id: UUID,
    fragment_id: UUID,
    citation: RetrievalCitation,
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT f.media_id, f.idx, f.canonical_text, f.t_start_ms, f.t_end_ms, m.title
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            WHERE f.id = :fragment_id
            """
        ),
        {"fragment_id": fragment_id},
    ).fetchone()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None
    lines = [
        '<app_search_result type="fragment">',
        f"<source>{xml_escape(row[5])}</source>",
        f"<fragment_id>{fragment_id}</fragment_id>",
        f"<fragment_index>{row[1]}</fragment_index>",
    ]
    timestamp = format_timestamp_ms(row[3])
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    _append_contributors_xml(lines, citation.contributors)
    lines.append(f"<text>{xml_escape(row[2] or '')}</text>")
    _append_citation_source_xml(lines, citation)
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_message_context(
    db: Session,
    viewer_id: UUID,
    message_id: UUID,
    citation: RetrievalCitation,
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT conversation_id, seq, role, content
            FROM messages
            WHERE id = :message_id
              AND status != 'pending'
            """
        ),
        {"message_id": message_id},
    ).fetchone()
    if row is None or not can_read_conversation(db, viewer_id, row[0]):
        return None

    lines = [
        '<app_search_result type="message">',
        f"<conversation_id>{row[0]}</conversation_id>",
        f"<message_seq>{row[1]}</message_seq>",
        f"<message_role>{xml_escape(row[2])}</message_role>",
        f"<excerpt>{xml_escape(row[3] or '')}</excerpt>",
    ]
    _append_citation_source_xml(lines, citation)
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_podcast_context(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    citation: RetrievalCitation,
) -> str | None:
    row = db.execute(
        text(
            f"""
            SELECT p.title, p.description, p.website_url
            FROM podcasts p
            WHERE p.id = :podcast_id
              AND p.id IN ({visible_podcast_ids_cte_sql()})
            """
        ),
        {"viewer_id": viewer_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None

    lines = ['<app_search_result type="podcast">', f"<source>{xml_escape(row[0])}</source>"]
    _append_contributors_xml(lines, citation.contributors)
    if row[2]:
        lines.append(f"<url>{xml_escape(row[2])}</url>")
    if row[1]:
        lines.append(f"<description>{xml_escape(row[1])}</description>")
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_contributor_context(
    db: Session, viewer_id: UUID, contributor_handle: object
) -> str | None:
    handle = str(contributor_handle or "").strip()
    if not handle:
        return None
    try:
        contributor = get_contributor_by_handle(db, handle, viewer_id=viewer_id)
    except NotFoundError:
        return None

    lines = [
        '<app_search_result type="contributor">',
        f"<contributor_handle>{xml_escape(handle)}</contributor_handle>",
        f"<display_name>{xml_escape(contributor.display_name)}</display_name>",
    ]
    if contributor.sort_name:
        lines.append(f"<sort_name>{xml_escape(contributor.sort_name)}</sort_name>")
    if contributor.kind:
        lines.append(f"<kind>{xml_escape(contributor.kind)}</kind>")
    if contributor.disambiguation:
        lines.append(f"<disambiguation>{xml_escape(contributor.disambiguation)}</disambiguation>")
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _append_contributors_xml(lines: list[str], contributors: list[dict[str, Any]]) -> None:
    labels = _contributor_credit_labels(contributors)
    if not labels:
        return
    lines.append("<contributors>")
    for label in labels:
        lines.append(f"<contributor>{xml_escape(label)}</contributor>")
    lines.append("</contributors>")


def _contributor_credit_labels(contributors: list[dict[str, Any]]) -> list[str]:
    labels: list[str] = []
    for credit in contributors:
        credited_name = str(credit.get("credited_name") or "").strip()
        role = str(credit.get("role") or "").strip()
        contributor = credit.get("contributor")
        display_name = ""
        if isinstance(contributor, Mapping):
            display_name = str(contributor.get("display_name") or "").strip()
        label = credited_name or display_name
        if not label:
            continue
        labels.append(f"{label} ({role})" if role else label)
    return labels
