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

from llm_calling.types import Turn
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_media, visible_media_ids_cte_sql
from nexus.errors import NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.search import SearchResultOut
from nexus.services.context_rendering import render_context_blocks
from nexus.services.contributor_credits import normalize_contributor_role
from nexus.services.contributors import get_contributor_by_handle
from nexus.services.search import ALL_RESULT_TYPES, hash_query, parse_scope, search

logger = get_logger(__name__)

APP_SEARCH_TOOL_NAME = "app_search"
APP_SEARCH_LIMIT = 8
APP_SEARCH_SELECTED_LIMIT = 6
APP_SEARCH_CONTEXT_CHARS = 16000
APP_SEARCH_QUERY_MAX_CHARS = 512

_SHORT_NON_SEARCH_MESSAGES = {
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "ok",
    "okay",
}

_SEARCH_CUE_TERMS = (
    "find",
    "search",
    "look up",
    "lookup",
    "show me",
    "source",
    "sources",
    "cite",
    "citation",
    "saved",
    "library",
    "highlight",
    "note",
    "notes",
    "fragment",
    "episode",
    "podcast",
    "video",
    "article",
    "book",
    "pdf",
    "document",
    "transcript",
    "where did",
    "what did",
    "when did",
    "summarize",
    "compare",
)


@dataclass(slots=True)
class AppSearchCitation:
    """Compact model/frontend citation for a retrieved search result."""

    result_type: str
    source_id: str
    title: str
    source_label: str | None
    snippet: str
    deep_link: str
    citation_label: str | None
    resolver: dict[str, Any] | None
    context_ref: dict[str, Any]
    evidence_span_id: str | None
    media_id: str | None
    media_kind: str | None
    score: float | None
    contributors: list[dict[str, Any]] = field(default_factory=list)
    filters: dict[str, Any] = field(default_factory=dict)
    selected: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "result_type": self.result_type,
            "source_id": self.source_id,
            "title": self.title,
            "source_label": self.source_label,
            "snippet": self.snippet,
            "deep_link": self.deep_link,
            "citation_label": self.citation_label,
            "resolver": self.resolver,
            "context_ref": self.context_ref,
            "evidence_span_id": self.evidence_span_id,
            "media_id": self.media_id,
            "media_kind": self.media_kind,
            "score": self.score,
            "contributors": self.contributors,
            "filters": self.filters,
            "selected": self.selected,
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
    semantic: bool
    citations: list[AppSearchCitation]
    selected_citations: list[AppSearchCitation]
    context_text: str
    context_chars: int
    latency_ms: int
    status: str
    error_code: str | None = None
    filters: dict[str, Any] = field(default_factory=dict)
    tool_call_id: UUID | None = None
    tool_call_index: int = 0
    result_refs: list[dict[str, Any]] = field(default_factory=list)

    def tool_call_event(self) -> dict[str, Any]:
        return {
            "tool_call_id": str(self.tool_call_id) if self.tool_call_id else None,
            "assistant_message_id": str(self.assistant_message_id),
            "tool_name": APP_SEARCH_TOOL_NAME,
            "tool_call_index": self.tool_call_index,
            "status": "started",
            "scope": self.scope,
            "types": self.requested_types,
            "semantic": self.semantic,
            "filters": self.filters,
        }

    def tool_result_event(self) -> dict[str, Any]:
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
            "citations": [citation.to_json() for citation in self.selected_citations],
        }


def should_run_app_search(content: str, *, has_user_context: bool) -> bool:
    """Return whether chat should execute app search for this user turn."""
    normalized = " ".join(content.lower().split())
    if len(normalized) < 2 or normalized in _SHORT_NON_SEARCH_MESSAGES:
        return False
    if any(term in normalized for term in _SEARCH_CUE_TERMS):
        return True
    return not has_user_context and len(normalized) >= 12


def build_app_search_query(
    content: str,
    *,
    history: list[Turn],
    scope_metadata: dict[str, Any],
) -> str:
    """Build the search query from a user message without storing raw text."""
    query = " ".join(content.split()).strip()
    lowered = query.lower()
    for prefix in (
        "find me ",
        "find ",
        "search for ",
        "search ",
        "look up ",
        "lookup ",
        "show me ",
        "show ",
        "sources for ",
        "cite ",
        "what did ",
        "where did ",
        "when did ",
    ):
        if lowered.startswith(prefix):
            query = query[len(prefix) :].strip()
            lowered = query.lower()
            break

    for phrase in (
        " in my library",
        " from my library",
        " in my saved items",
        " from my saved items",
        " in saved content",
        " from saved content",
    ):
        query = query.replace(phrase, "").replace(phrase.title(), "")

    query = query.strip(" \t\r\n?.!,;:")
    normalized = " ".join(query.lower().split())
    if normalized in {"what about that", "what about it", "tell me more", "why"}:
        for turn in reversed(history):
            if turn.role == "user" and turn.content.strip():
                query = f"{turn.content.strip()} {query}"
                break

    scope_title = scope_metadata.get("title")
    if scope_metadata.get("type") in {"media", "library"} and isinstance(scope_title, str):
        if scope_title.lower() not in query.lower():
            query = f"{scope_title} {query}"

    return (query or content).strip()[:APP_SEARCH_QUERY_MAX_CHARS]


def execute_app_search(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    content: str,
    has_user_context: bool,
    scope: str,
    history: list[Turn],
    scope_metadata: dict[str, Any],
    planned_query: str | None = None,
    planned_types: Sequence[str] | None = None,
    planned_filters: Mapping[str, object] | None = None,
    force: bool = False,
) -> AppSearchRun | None:
    """Run app search for a chat turn and persist tool/retrieval metadata."""
    if (
        scope == "all"
        and not force
        and not should_run_app_search(content, has_user_context=has_user_context)
    ):
        return None

    query = planned_query or build_app_search_query(
        content,
        history=history,
        scope_metadata=scope_metadata,
    )
    if planned_types is not None:
        requested_types = list(planned_types)
    else:
        requested_types = list(ALL_RESULT_TYPES)
    filters = _normalize_app_search_filters(planned_filters)
    semantic = True
    start = time.monotonic()
    status = "complete"
    error_code = None

    try:
        response = search(
            db=db,
            viewer_id=viewer_id,
            q=query,
            scope=scope,
            types=requested_types,
            contributor_handles=filters["contributor_handles"],
            roles=filters["roles"],
            content_kinds=filters["content_kinds"],
            semantic=semantic,
            limit=APP_SEARCH_LIMIT,
        )
        result_rows = list(response.results)
        citations = [
            _citation_from_search_result(result, filters=filters) for result in result_rows
        ]
        result_refs = []
        for result in result_rows:
            result_ref = result.model_dump(mode="json")
            result_ref["filters"] = filters
            result_refs.append(result_ref)
        context_text, context_chars, selected = render_retrieved_context_blocks(
            db,
            viewer_id=viewer_id,
            citations=citations,
        )
        if not context_text and not citations:
            result_status = (
                _scoped_content_chunk_empty_status(
                    db,
                    viewer_id=viewer_id,
                    scope=scope,
                    filters=filters,
                )
                if scope != "all" and requested_types == ["content_chunk"]
                else "no_results"
            )
            result_refs = [{"status": result_status, "scope": scope, "filters": filters}]
            context_text = (
                f'<app_search_results status="{result_status}" scope="{xml_escape(scope)}" '
                f'filters="{xml_escape(json.dumps(filters, sort_keys=True))}" />'
            )
            context_chars = len(context_text)
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        logger.warning(
            "agent_app_search_failed",
            query_hash=hash_query(query),
            scope=scope,
            filters=filters,
            error=str(exc),
        )
        status = "error"
        error_code = "E_APP_SEARCH_FAILED"
        citations = []
        selected = []
        result_refs = []
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
        semantic=semantic,
        citations=citations,
        selected_citations=selected,
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        filters=filters,
        result_refs=result_refs,
    )
    persist_app_search_run(db, run)
    return run


def _scoped_content_chunk_empty_status(
    db: Session,
    *,
    viewer_id: UUID,
    scope: str,
    filters: dict[str, Any],
) -> str:
    scope_type, scope_id = parse_scope(scope)
    params: dict[str, Any] = {"viewer_id": viewer_id}
    scope_filter = ""
    if scope_type == "media":
        scope_filter = "AND cc.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND cc.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND cc.media_id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    elif scope_type != "all":
        return "no_indexed_evidence"

    content_kind_filter = ""
    if filters["content_kinds"]:
        content_kind_filter = "AND m.kind = ANY(:content_kinds)"
        params["content_kinds"] = filters["content_kinds"]

    contributor_credit_filter = ""
    if filters["contributor_handles"] or filters["roles"]:
        credit_clauses = ["cc_filter.media_id = m.id"]
        if filters["contributor_handles"]:
            credit_clauses.append("c_filter.handle = ANY(:contributor_handles)")
            params["contributor_handles"] = filters["contributor_handles"]
        if filters["roles"]:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = filters["roles"]
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                JOIN contributors c_filter ON c_filter.id = cc_filter.contributor_id
                WHERE {" AND ".join(credit_clauses)}
                  AND c_filter.status NOT IN ('merged', 'tombstoned')
            )
        """

    row = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT 1
            FROM content_chunks cc
            JOIN media m ON m.id = cc.media_id
            JOIN visible_media vm ON vm.media_id = cc.media_id
            JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                AND mcis.active_run_id = cc.index_run_id
            JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                AND active_run.state = 'ready'
                AND active_run.deactivated_at IS NULL
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                AND es.media_id = cc.media_id
                AND es.index_run_id = cc.index_run_id
            WHERE TRUE
            {scope_filter}
            {content_kind_filter}
            {contributor_credit_filter}
            LIMIT 1
            """
        ),
        params,
    ).first()
    return "no_results" if row is not None else "no_indexed_evidence"


def _normalize_app_search_filters(filters: Mapping[str, object] | None) -> dict[str, Any]:
    normalized = {
        "contributor_handles": [],
        "roles": [],
        "content_kinds": [],
    }
    if not filters:
        return normalized
    for key in ("contributor_handles", "roles", "content_kinds"):
        raw_values = filters.get(key)
        if isinstance(raw_values, str):
            values = [raw_values]
        elif isinstance(raw_values, Sequence):
            values = list(raw_values)
        else:
            values = []
        seen: set[str] = set()
        for raw_value in values:
            raw_text = str(raw_value or "")
            if key == "roles":
                value = normalize_contributor_role(raw_text)
            else:
                value = raw_text.strip().lower()
            if not value or value in seen:
                continue
            normalized[key].append(value)
            seen.add(value)
    return normalized


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


def _citation_from_search_result(
    result: SearchResultOut,
    *,
    filters: dict[str, Any],
) -> AppSearchCitation:
    payload = result.model_dump(mode="json")
    context_ref = payload["context_ref"]
    evidence_span_ids = (
        context_ref.get("evidence_span_ids") if isinstance(context_ref, dict) else []
    )
    evidence_span_id = (
        str(evidence_span_ids[0])
        if isinstance(evidence_span_ids, list) and evidence_span_ids
        else None
    )
    return AppSearchCitation(
        result_type=str(payload["type"]),
        source_id=str(payload["id"]),
        title=str(payload["title"]),
        source_label=payload.get("source_label"),
        snippet=str(payload["snippet"]),
        deep_link=str(payload["deep_link"]),
        citation_label=payload.get("citation_label"),
        resolver=payload.get("resolver") if isinstance(payload.get("resolver"), dict) else None,
        context_ref=context_ref,
        evidence_span_id=evidence_span_id,
        media_id=payload.get("media_id"),
        media_kind=payload.get("media_kind"),
        score=float(payload["score"]) if payload.get("score") is not None else None,
        contributors=_contributors_from_search_payload(payload),
        filters=filters,
    )


def persist_app_search_run(db: Session, run: AppSearchRun) -> None:
    """Persist the app-search tool call and retrieval rows."""
    selected_context_refs = [citation.context_ref for citation in run.selected_citations]
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
                semantic,
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
                :semantic,
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
                "semantic": run.semantic,
                "result_refs": run.result_refs,
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
                semantic = :semantic,
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
                "semantic": run.semantic,
                "result_refs": run.result_refs,
                "selected_context_refs": selected_context_refs,
                "latency_ms": run.latency_ms,
                "status": run.status,
                "error_code": run.error_code,
            },
        )
    run.tool_call_id = tool_call_id

    db.execute(
        text("DELETE FROM message_retrievals WHERE tool_call_id = :tool_call_id"),
        {"tool_call_id": tool_call_id},
    )

    insert_retrieval = text(
        """
        INSERT INTO message_retrievals (
            tool_call_id,
            ordinal,
            result_type,
            source_id,
            media_id,
            evidence_span_id,
            scope,
            context_ref,
            result_ref,
            deep_link,
            score,
            selected,
            source_title,
            section_label,
            exact_snippet,
            locator,
            retrieval_status
        )
        VALUES (
            :tool_call_id,
            :ordinal,
            :result_type,
            :source_id,
            :media_id,
            :evidence_span_id,
            :scope,
            :context_ref,
            :result_ref,
            :deep_link,
            :score,
            :selected,
            :source_title,
            :section_label,
            :exact_snippet,
            :locator,
            :retrieval_status
        )
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    selected_ids = {citation.source_id for citation in run.selected_citations}
    if not run.citations and run.result_refs:
        result_status = run.result_refs[0].get("status")
        if result_status in {"no_indexed_evidence", "no_results"}:
            db.execute(
                insert_retrieval,
                {
                    "tool_call_id": tool_call_id,
                    "ordinal": 0,
                    "result_type": "content_chunk",
                    "source_id": str(result_status),
                    "media_id": None,
                    "evidence_span_id": None,
                    "scope": run.scope,
                    "context_ref": {
                        "type": "content_chunk",
                        "id": "00000000-0000-0000-0000-000000000000",
                    },
                    "result_ref": run.result_refs[0],
                    "deep_link": None,
                    "score": None,
                    "selected": True,
                    "source_title": "App search status",
                    "section_label": None,
                    "exact_snippet": run.context_text,
                    "locator": None,
                    "retrieval_status": "selected",
                },
            )
    for ordinal, citation in enumerate(run.citations):
        db.execute(
            insert_retrieval,
            {
                "tool_call_id": tool_call_id,
                "ordinal": ordinal,
                "result_type": citation.result_type,
                "source_id": citation.source_id,
                "media_id": citation.media_id,
                "evidence_span_id": (
                    UUID(citation.evidence_span_id) if citation.evidence_span_id else None
                ),
                "scope": run.scope,
                "context_ref": citation.context_ref,
                "result_ref": citation.to_json(),
                "deep_link": citation.deep_link,
                "score": citation.score,
                "selected": citation.source_id in selected_ids,
                "source_title": citation.title,
                "section_label": citation.source_label,
                "exact_snippet": citation.snippet,
                "locator": citation.resolver,
                "retrieval_status": (
                    "selected" if citation.source_id in selected_ids else "retrieved"
                ),
            },
        )
    db.commit()


def render_retrieved_context_blocks(
    db: Session,
    *,
    viewer_id: UUID,
    citations: list[AppSearchCitation],
) -> tuple[str, int, list[AppSearchCitation]]:
    """Render selected search citations into bounded prompt context blocks."""
    rendered_blocks: list[str] = []
    selected: list[AppSearchCitation] = []
    total_chars = 0

    for citation in citations[:APP_SEARCH_SELECTED_LIMIT]:
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

    if not rendered_blocks:
        return "", 0, selected
    return "\n\n".join(rendered_blocks), total_chars, selected


def _render_single_retrieved_context(
    db: Session,
    viewer_id: UUID,
    citation: AppSearchCitation,
) -> str | None:
    context_type = citation.context_ref.get("type")
    if context_type == "contributor":
        return _render_contributor_context(db, viewer_id, citation.context_ref.get("id"))

    context_id = _parse_uuid(citation.context_ref.get("id"))
    if context_id is None:
        return None

    if context_type == "media":
        if not can_read_media(db, viewer_id, context_id):
            return None
        return render_context_blocks(db, [MessageContextRef(type="media", id=context_id)])[0]

    if context_type in {"page", "note_block"}:
        return render_context_blocks(db, [MessageContextRef(type=context_type, id=context_id)])[0]

    if context_type == "content_chunk":
        evidence_span_id = _parse_uuid(citation.evidence_span_id)
        if evidence_span_id is None:
            return None
        return _render_content_chunk_context(db, viewer_id, context_id, evidence_span_id, citation)

    if context_type == "message":
        return _render_message_context(db, viewer_id, context_id)

    if context_type == "podcast":
        return _render_podcast_context(db, viewer_id, context_id, citation)

    return None


def _parse_uuid(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _format_timestamp_ms(timestamp_ms: int | None) -> str | None:
    if timestamp_ms is None:
        return None
    total_seconds = max(0, int(timestamp_ms) // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _render_content_chunk_context(
    db: Session,
    viewer_id: UUID,
    chunk_id: UUID,
    evidence_span_id: UUID,
    citation: AppSearchCitation,
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT
                cc.media_id,
                cc.chunk_text,
                cc.summary_locator,
                cc.source_kind,
                m.title,
                m.canonical_source_url,
                es.id,
                es.citation_label,
                es.span_text
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = :evidence_span_id
                AND es.media_id = cc.media_id
                AND es.index_run_id = cc.index_run_id
            JOIN media m ON m.id = cc.media_id
            WHERE cc.id = :chunk_id
            """
        ),
        {"chunk_id": chunk_id, "evidence_span_id": evidence_span_id},
    ).fetchone()
    if row is None or not can_read_media(db, viewer_id, row[0]):
        return None

    lines = [
        '<app_search_result type="content_chunk">',
        f"<source>{xml_escape(row[4])}</source>",
        f"<evidence_span_id>{row[6]}</evidence_span_id>",
        f"<citation_label>{xml_escape(row[7])}</citation_label>",
    ]
    if row[5]:
        lines.append(f"<url>{xml_escape(row[5])}</url>")
    locator = dict(row[2] or {})
    timestamp = _format_timestamp_ms(locator.get("t_start_ms"))
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    if row[3]:
        lines.append(f"<source_kind>{xml_escape(str(row[3]))}</source_kind>")
    _append_contributors_xml(lines, citation.contributors)
    lines.append(f"<evidence_span>{xml_escape(row[8] or '')}</evidence_span>")
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_message_context(db: Session, viewer_id: UUID, message_id: UUID) -> str | None:
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

    return "\n".join(
        [
            '<app_search_result type="message">',
            f"<conversation_id>{row[0]}</conversation_id>",
            f"<message_seq>{row[1]}</message_seq>",
            f"<message_role>{xml_escape(row[2])}</message_role>",
            f"<excerpt>{xml_escape(row[3] or '')}</excerpt>",
            "</app_search_result>",
        ]
    )


def _render_podcast_context(
    db: Session,
    viewer_id: UUID,
    podcast_id: UUID,
    citation: AppSearchCitation,
) -> str | None:
    row = db.execute(
        text(
            """
            SELECT p.title, p.description, p.website_url
            FROM podcasts p
            WHERE p.id = :podcast_id
              AND (
                    EXISTS (
                        SELECT 1
                        FROM podcast_subscriptions ps
                        WHERE ps.podcast_id = p.id
                          AND ps.user_id = :viewer_id
                          AND ps.status = 'active'
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM library_entries le
                        JOIN memberships m ON m.library_id = le.library_id
                                          AND m.user_id = :viewer_id
                        WHERE le.podcast_id = p.id
                    )
              )
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
