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
)
from nexus.errors import ApiError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import MessageContextRef
from nexus.schemas.retrieval import (
    retrieval_context_ref_json,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.schemas.search import SearchResultOut
from nexus.services.context_rendering import render_context_blocks
from nexus.services.contexts import load_artifact_part_context_ref
from nexus.services.contributor_credits import normalize_contributor_role
from nexus.services.contributors import get_contributor_by_handle
from nexus.services.search import hash_query, parse_scope, search
from nexus.timestamps import format_timestamp_ms

logger = get_logger(__name__)

APP_SEARCH_TOOL_NAME = "app_search"
APP_SEARCH_LIMIT = 8
APP_SEARCH_SELECTED_LIMIT = 6
APP_SEARCH_CONTEXT_CHARS = 16000
STRICT_LOCATOR_RESULT_TYPES = frozenset(
    {
        "content_chunk",
        "fragment",
        "note_block",
        "highlight",
        "message",
        "evidence_span",
        "artifact_part",
    }
)
STRICT_SOURCE_VERSION_RESULT_TYPES = STRICT_LOCATOR_RESULT_TYPES | {"page"}


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
    locator: dict[str, Any] | None
    context_ref: dict[str, Any]
    evidence_span_id: str | None
    source_version: str | None
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
            "source_version": self.source_version,
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
                "source_version": self.source_version,
                "locator": self.locator,
                "media_id": self.media_id,
                "media_kind": self.media_kind,
            }
        if self.result_type == "fragment":
            return {
                **common,
                "citation_label": self.citation_label,
                "source_version": self.source_version,
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
                "source_version": self.source_version,
            }
        if self.result_type == "note_block":
            return {
                **common,
                "page_id": self.result_ref["page_id"],
                "page_title": self.result_ref["page_title"],
                "body_text": self.result_ref["body_text"],
                "highlight_excerpt": self.result_ref.get("highlight_excerpt"),
                "source_version": self.source_version,
                "locator": self.locator,
            }
        if self.result_type == "highlight":
            return {
                **common,
                "color": self.result_ref["color"],
                "exact": self.result_ref["exact"],
                "citation_label": self.citation_label,
                "source_version": self.source_version,
                "locator": self.locator,
                "media_id": self.media_id,
                "media_kind": self.media_kind,
            }
        if self.result_type == "message":
            return {
                **common,
                "conversation_id": self.result_ref["conversation_id"],
                "seq": self.result_ref["seq"],
                "source_version": self.source_version,
                "locator": self.locator,
            }
        if self.result_type == "artifact_part":
            return {
                "type": "artifact_part",
                "id": self.source_id,
                "result_type": "artifact_part",
                "source_id": self.source_id,
                "artifact_id": self.result_ref["artifact_id"],
                "message_id": self.result_ref["message_id"],
                "conversation_id": self.result_ref["conversation_id"],
                "artifact_kind": self.result_ref["artifact_kind"],
                "artifact_title": self.result_ref.get("artifact_title"),
                "part_key": self.result_ref.get("part_key"),
                "part_type": self.result_ref.get("part_type"),
                "title": self.title,
                "source_label": self.source_label,
                "snippet": self.snippet,
                "deep_link": self.deep_link,
                "context_ref": self.context_ref,
                "source_version": self.source_version,
                "locator": self.locator,
                "media_id": None,
                "media_kind": None,
                "score": self.score,
                "selected": self.selected,
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
                "source_version": self.source_version,
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
                "source_version": None,
                "locator": None,
                "media_id": None,
                "media_kind": None,
                "score": self.score,
                "selected": self.selected,
            }
        if self.result_type == "artifact":
            return {
                "type": "artifact",
                "id": self.source_id,
                "result_type": "artifact",
                "source_id": self.source_id,
                "conversation_id": self.result_ref["conversation_id"],
                "message_id": self.result_ref["message_id"],
                "artifact_kind": self.result_ref["artifact_kind"],
                "title": self.title,
                "source_label": self.source_label,
                "snippet": self.snippet,
                "deep_link": self.deep_link,
                "context_ref": self.context_ref,
                "source_version": None,
                "locator": None,
                "media_id": None,
                "media_kind": None,
                "score": self.score,
                "selected": self.selected,
            }
        raise ValueError(f"Unsupported app search result type: {self.result_type}")


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
            "semantic": self.semantic,
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


def execute_app_search(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
    scope: str,
    planned_query: str,
    planned_types: Sequence[str],
    planned_filters: Mapping[str, object],
) -> AppSearchRun:
    """Run app search for a chat turn and persist tool/retrieval metadata."""
    query = planned_query
    requested_types = [str(result_type) for result_type in planned_types]
    filters = _normalize_app_search_filters(planned_filters)
    semantic = True
    start = time.monotonic()
    status = "complete"
    error_code = None
    empty_status: str | None = None

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
            empty_status = result_status
            context_text = (
                f'<app_search_results status="{result_status}" scope="{xml_escape(scope)}" '
                f'filters="{xml_escape(json.dumps(filters, sort_keys=True))}" />'
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
        semantic=semantic,
        citations=citations,
        selected_citations=selected,
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=latency_ms,
        status=status,
        error_code=error_code,
        filters=filters,
        empty_status=empty_status,
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
    evidence_span_id = payload.get("evidence_span_id")
    if not isinstance(evidence_span_id, str):
        evidence_span_id = (
            str(evidence_span_ids[0])
            if isinstance(evidence_span_ids, list) and evidence_span_ids
            else None
        )
    result_ref = dict(payload)
    result_type = str(payload["type"])
    return AppSearchCitation(
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
        source_version=_source_version_from_search_payload(payload),
        media_id=payload.get("media_id"),
        media_kind=payload.get("media_kind"),
        score=float(payload["score"]) if payload.get("score") is not None else None,
        contributors=_contributors_from_search_payload(payload),
        filters=filters,
        result_ref=result_ref,
    )


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


def _source_version_from_search_payload(payload: Mapping[str, Any]) -> str | None:
    source_version = payload.get("source_version")
    if isinstance(source_version, str) and source_version.strip():
        return source_version

    result_type = str(payload.get("type") or "")
    if result_type in STRICT_SOURCE_VERSION_RESULT_TYPES:
        raise ValueError(f"{result_type} search result is missing source_version")
    return None


def _strict_citation_locator(citation: AppSearchCitation) -> dict[str, Any] | None:
    locator = retrieval_locator_json(citation.locator)
    if locator is None and citation.result_type in STRICT_LOCATOR_RESULT_TYPES:
        raise ValueError(f"{citation.result_type} citation is missing locator")
    return locator


def _strict_citation_source_version(citation: AppSearchCitation) -> str | None:
    source_version = citation.source_version
    if isinstance(source_version, str) and source_version.strip():
        return source_version
    if citation.result_type in STRICT_SOURCE_VERSION_RESULT_TYPES:
        raise ValueError(f"{citation.result_type} citation is missing source_version")
    return None


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
                "result_refs": result_refs,
                "selected_context_refs": selected_context_refs,
                "latency_ms": run.latency_ms,
                "status": run.status,
                "error_code": run.error_code,
            },
        )
    run.tool_call_id = tool_call_id

    select_retrieval = text(
        """
        SELECT id
        FROM message_retrievals
        WHERE tool_call_id = :tool_call_id
          AND ordinal = :ordinal
        """
    )
    update_retrieval = text(
        """
        UPDATE message_retrievals
        SET result_type = :result_type,
            source_id = :source_id,
            media_id = :media_id,
            evidence_span_id = :evidence_span_id,
            scope = :scope,
            context_ref = :context_ref,
            result_ref = :result_ref,
            deep_link = :deep_link,
            score = :score,
            selected = :selected,
            source_title = :source_title,
            section_label = :section_label,
            exact_snippet = :exact_snippet,
            snippet_prefix = NULL,
            snippet_suffix = NULL,
            locator = :locator,
            retrieval_status = :retrieval_status,
            included_in_prompt = false,
            source_version = :source_version
        WHERE id = :retrieval_id
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
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
            retrieval_status,
            source_version
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
            :retrieval_status,
            :source_version
        )
        RETURNING id
        """
    ).bindparams(
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
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
            locator,
            source_version
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
            :locator,
            :source_version
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
        locator = _strict_citation_locator(citation)
        source_version = _strict_citation_source_version(citation)
        result_ref = retrieval_result_ref_json(citation.result_ref_json())
        retrieval_payload = {
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "result_type": citation.result_type,
            "source_id": citation.source_id,
            "media_id": citation.media_id,
            "evidence_span_id": UUID(citation.evidence_span_id)
            if citation.evidence_span_id
            else None,
            "scope": run.scope,
            "context_ref": retrieval_context_ref_json(citation.context_ref),
            "result_ref": result_ref,
            "deep_link": citation.deep_link,
            "score": citation.score,
            "selected": selected,
            "source_title": citation.title,
            "section_label": citation.source_label,
            "exact_snippet": citation.snippet,
            "locator": locator,
            "retrieval_status": "selected" if selected else "retrieved",
            "source_version": source_version,
        }
        existing_retrieval = db.execute(select_retrieval, retrieval_payload).first()
        if existing_retrieval is None:
            retrieval_id = db.execute(insert_retrieval, retrieval_payload).scalar_one()
        else:
            retrieval_id = existing_retrieval[0]
            db.execute(update_retrieval, {**retrieval_payload, "retrieval_id": retrieval_id})
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
                "source_version": source_version,
            },
        )
        persisted_count = ordinal + 1
    db.execute(
        text(
            """
            UPDATE message_retrieval_candidate_ledgers
            SET retrieval_id = NULL
            WHERE retrieval_id IN (
                SELECT id
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND ordinal >= :persisted_count
                  AND NOT EXISTS (
                      SELECT 1
                      FROM assistant_message_claim_evidence e
                      WHERE e.retrieval_id = message_retrievals.id
                  )
            )
            """
        ),
        {"tool_call_id": tool_call_id, "persisted_count": persisted_count},
    )
    db.execute(
        text(
            """
            DELETE FROM message_retrievals
            WHERE tool_call_id = :tool_call_id
              AND ordinal >= :persisted_count
              AND NOT EXISTS (
                  SELECT 1
                  FROM assistant_message_claim_evidence e
                  WHERE e.retrieval_id = message_retrievals.id
              )
            """
        ),
        {"tool_call_id": tool_call_id, "persisted_count": persisted_count},
    )
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
                "semantic": run.semantic,
                "scope": run.scope,
            },
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
        return _render_contributor_context(
            db,
            viewer_id,
            citation.result_ref.get("contributor_handle") or citation.context_ref.get("id"),
        )

    context_id = _parse_uuid(citation.context_ref.get("id"))
    if context_id is None:
        return None

    if context_type in {"media", "episode", "video"}:
        if not can_read_media(db, viewer_id, context_id):
            return None
        return render_context_blocks(db, [MessageContextRef(type="media", id=context_id)])[0]

    if context_type in {"page", "note_block"}:
        return render_context_blocks(db, [MessageContextRef(type=context_type, id=context_id)])[0]

    if context_type == "highlight":
        if not can_read_highlight(db, viewer_id, context_id):
            return None
        source_version = citation.source_version
        locator = retrieval_locator_json(citation.locator)
        if not isinstance(source_version, str) or not source_version.strip() or locator is None:
            return None
        return render_context_blocks(
            db,
            [
                MessageContextRef.model_validate(
                    {
                        "type": "highlight",
                        "id": context_id,
                        "source_version": source_version,
                        "locator": locator,
                    }
                )
            ],
        )[0]

    if context_type == "fragment":
        return _render_fragment_context(db, viewer_id, context_id, citation)

    if context_type == "content_chunk":
        evidence_span_id = _parse_uuid(citation.evidence_span_id)
        if evidence_span_id is None:
            return None
        return _render_content_chunk_context(db, viewer_id, context_id, evidence_span_id, citation)

    if context_type == "message":
        return _render_message_context(db, viewer_id, context_id, citation)

    if context_type == "conversation":
        if not can_read_conversation(db, viewer_id, context_id):
            return None
        return render_context_blocks(db, [MessageContextRef(type="conversation", id=context_id)])[0]

    if context_type == "evidence_span":
        row = db.execute(
            text("SELECT media_id FROM evidence_spans WHERE id = :evidence_span_id"),
            {"evidence_span_id": context_id},
        ).fetchone()
        if row is None or not can_read_media(db, viewer_id, row[0]):
            return None
        return render_context_blocks(db, [MessageContextRef(type="evidence_span", id=context_id)])[
            0
        ]

    if context_type == "podcast":
        return _render_podcast_context(db, viewer_id, context_id, citation)

    if context_type == "artifact":
        row = db.execute(
            text("SELECT conversation_id FROM message_artifacts WHERE id = :artifact_id"),
            {"artifact_id": context_id},
        ).fetchone()
        if row is None or not can_read_conversation(db, viewer_id, row[0]):
            return None
        return render_context_blocks(db, [MessageContextRef(type="artifact", id=context_id)])[0]

    if context_type == "artifact_part":
        try:
            context = load_artifact_part_context_ref(db, context_id)
        except (ApiError, NotFoundError, ValueError):  # justify-ignore-error: skip retrieved context block when artifact_part is missing, inaccessible, or malformed
            return None
        provenance = context.artifact_part_provenance
        if provenance is None or provenance.conversation_id is None:
            return None
        if not can_read_conversation(db, viewer_id, provenance.conversation_id):
            return None
        return render_context_blocks(db, [context])[0]

    return None


def _parse_uuid(value: Any) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None




def _append_citation_source_xml(lines: list[str], citation: AppSearchCitation) -> None:
    if citation.locator:
        lines.append(
            "<source_locator>"
            f"{xml_escape(json.dumps(citation.locator, sort_keys=True, separators=(',', ':'), default=str))}"
            "</source_locator>"
        )
    if citation.source_version:
        lines.append(f"<source_version>{xml_escape(citation.source_version)}</source_version>")


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
    timestamp = format_timestamp_ms(locator.get("t_start_ms"))
    if timestamp:
        lines.append(f"<timestamp>{timestamp}</timestamp>")
    if row[3]:
        lines.append(f"<source_kind>{xml_escape(str(row[3]))}</source_kind>")
    _append_contributors_xml(lines, citation.contributors)
    lines.append(f"<evidence_span>{xml_escape(row[8] or '')}</evidence_span>")
    _append_citation_source_xml(lines, citation)
    lines.append("</app_search_result>")
    return "\n".join(lines)


def _render_fragment_context(
    db: Session,
    viewer_id: UUID,
    fragment_id: UUID,
    citation: AppSearchCitation,
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
    citation: AppSearchCitation,
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
