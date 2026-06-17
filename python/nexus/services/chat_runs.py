"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import AsyncIterator, Mapping
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError
from provider_runtime.types import (
    ModelCall,
    ModelChunk,
    ModelMessage,
    ProviderApiKey,
    ProviderArtifact,
    TokenUsage,
    ToolResult,
    ToolSpec,
)
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    ChatRunTurnContext,
    Conversation,
    Message,
    MessageToolCall,
    Model,
    ResourceEdge,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    NotFoundError,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.jobs.queue import enqueue_job
from nexus.llm_catalog import model_max_context_tokens, model_reasoning_reserve_tokens
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import (
    CHAT_RUN_STATUS_FILTER,
    BranchAnchorRequest,
    ChatRunEventOut,
    ChatRunResponse,
    ChatSubjectRequest,
    ReaderSelectionRequest,
)
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_TOOL_DEFINITION,
    APP_SEARCH_TOOL_NAME,
    execute_app_search,
)
from nexus.services.agent_tools.inspect_resource import (
    INSPECT_RESOURCE_TOOL_DEFINITION,
    INSPECT_RESOURCE_TOOL_NAME,
    execute_inspect_resource,
)
from nexus.services.agent_tools.read_resource import (
    READ_RESOURCE_TOOL_DEFINITION,
    READ_RESOURCE_TOOL_NAME,
    execute_read_resource,
)
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_DEFINITION,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
)
from nexus.services.api_key_resolver import (
    get_model_by_id,
    resolve_api_key,
)
from nexus.services.chat_run_access import (
    get_run_for_owner,
    load_retryable_failed_assistant_message,
    load_source_run_for_retry,
)
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    append_and_commit,
    append_run_event,
    has_delta_without_terminal,
    is_cancel_requested,
    mark_running,
)
from nexus.services.chat_run_finalize import (
    ERROR_CODE_TO_MESSAGE,
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    finalize_cancelled,
    finalize_error,
    finalize_interrupted,
    finalize_run,
)
from nexus.services.chat_run_idempotency import (
    compute_payload_hash,
    compute_retry_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_blocks import (
    message_document,
)
from nexus.services.chat_run_message_prep import prepare_messages
from nexus.services.chat_run_prompt_tracking import (
    reconcile_prompt_retrievals,
)
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.chat_run_usage import usage_tokens
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.context_assembler import (
    assemble_chat_context,
    persist_prompt_assembly,
)
from nexus.services.conversation_branches import (
    ensure_branch_metadata,
    persist_active_leaf,
)
from nexus.services.llm_ledger import LlmCallOwner, observed_generate_stream
from nexus.services.prompt_budget import ContextBudgetError, estimate_tokens
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph import cleanup as graph_cleanup
from nexus.services.resource_graph.citations import build_citation_outs, record_citation
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    admits_resource_for_conversation_read,
)
from nexus.services.resource_graph.edges import delete_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.schemas import (
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
)
from nexus.services.resource_items.capabilities import resource_citation_result_type
from nexus.services.resource_items.chat_subjects import resolve_chat_subject
from nexus.services.retrieval_citation import (
    RetrievalCitation,
    citation_from_search_result,
    insert_retrieval_row,
)
from nexus.services.search import get_search_result
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)


REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096
LLM_TIMEOUT_SECONDS = 45.0
MAX_TOOL_ITERATIONS = 8

_CHAT_TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name=APP_SEARCH_TOOL_NAME,
        description=APP_SEARCH_TOOL_DEFINITION["description"],
        parameters=APP_SEARCH_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=WEB_SEARCH_TOOL_NAME,
        description=WEB_SEARCH_TOOL_DEFINITION["description"],
        parameters=WEB_SEARCH_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=READ_RESOURCE_TOOL_NAME,
        description=READ_RESOURCE_TOOL_DEFINITION["description"],
        parameters=READ_RESOURCE_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=INSPECT_RESOURCE_TOOL_NAME,
        description=INSPECT_RESOURCE_TOOL_DEFINITION["description"],
        parameters=INSPECT_RESOURCE_TOOL_DEFINITION["parameters"],
    ),
)


def _app_search_scopes_from_tool_args(args: Mapping[str, Any]) -> tuple[list[str], str | None]:
    if "scope" in args:
        return (
            [],
            "app_search uses scopes=[...] for URI scopes; the singular scope field is invalid",
        )

    raw_scopes = args.get("scopes")
    if raw_scopes is None:
        return [], None
    if not isinstance(raw_scopes, list):
        return [], "app_search scopes must be an array of URI strings"

    scopes: list[str] = []
    for scope in raw_scopes:
        if not isinstance(scope, str):
            return [], "app_search scopes must be an array of URI strings"
        normalized_scope = scope.strip()
        if not normalized_scope:
            return [], "app_search scopes must be non-empty URI strings"
        scopes.append(normalized_scope)
    return scopes, None


def _app_search_string_array_from_tool_args(
    args: Mapping[str, Any], key: str
) -> tuple[list[str] | None, str | None]:
    raw = args.get(key)
    if raw is None:
        return None, None
    if not isinstance(raw, list):
        return None, f"app_search {key} must be an array of strings"
    values: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            return None, f"app_search {key} must be an array of strings"
        value = item.strip()
        if value:
            values.append(value)
    return values, None


class ChatRunModelRuntime(Protocol):
    def stream(
        self,
        call: ModelCall,
        *,
        key: ProviderApiKey,
        timeout_s: float,
    ) -> AsyncIterator[ModelChunk]: ...


def _max_output_tokens_for_reasoning(model: Model, reasoning: str) -> int:
    max_context_tokens = model_max_context_tokens(model.provider, model.model_name)
    reasoning_reserve = model_reasoning_reserve_tokens(
        model.provider,
        model.model_name,
        reasoning,
    )
    if reasoning_reserve > 0:
        return min(REASONING_OUTPUT_TOKENS, max_context_tokens)
    return min(DEFAULT_OUTPUT_TOKENS, max_context_tokens)


def _record_tool_citations(
    db: Session, *, run: ChatRun, tool_call_id: UUID | None, start_ordinal: int
) -> int:
    """Record citation edges for a tool call's selected retrievals; return next ordinal.

    The dense turn-global numbering is unchanged from the old per-row ordinal
    column — only the storage moved: each selected row gets one
    ``origin='citation'`` edge (``source = message:<assistant_message_id>``) and a
    ``cited_edge_id`` back-pointer, in the same transaction the row was written.
    """
    if tool_call_id is None:
        return start_ordinal
    # Parity with the old column-nulling of unselected rows: a re-persisted row
    # that is no longer selected loses its citation edge.
    stale = db.execute(
        text(
            """
            SELECT id, cited_edge_id FROM message_retrievals
            WHERE tool_call_id = :tool_call_id
              AND selected = false
              AND cited_edge_id IS NOT NULL
            """
        ),
        {"tool_call_id": tool_call_id},
    ).fetchall()
    for row_id, edge_id in stale:
        _delete_citation_edge(db, viewer_id=run.owner_user_id, edge_id=edge_id)
        db.execute(
            text("UPDATE message_retrievals SET cited_edge_id = NULL WHERE id = :id"),
            {"id": row_id},
        )
    rows = (
        db.execute(
            text(
                """
                SELECT id, result_type, source_id, media_id, evidence_span_id,
                       source_title, section_label, exact_snippet, deep_link, result_ref
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND selected = true
                ORDER BY ordinal
                """
            ),
            {"tool_call_id": tool_call_id},
        )
        .mappings()
        .all()
    )
    for offset, row in enumerate(rows):
        _record_retrieval_citation(db, run=run, row=dict(row), ordinal=start_ordinal + offset)
    return start_ordinal + len(rows)


def _record_retrieval_citation(
    db: Session, *, run: ChatRun, row: Mapping[str, Any], ordinal: int
) -> None:
    """Write one citation edge for a selected telemetry row and point the row at it.

    Replace-by-ordinal: a re-executed run owns its message's citation set, so an
    existing edge at this ordinal (from a replaced tool result) is deleted first.
    Rows with no edge target in the citation render contract (attached ``page:``/
    ``message:`` refs) keep their `[n]` in the prompt but mint no edge.
    """
    target = _citation_target_ref(db, run=run, row=row)
    if target is None:
        return
    existing = db.execute(
        select(ResourceEdge.id).where(
            ResourceEdge.source_scheme == "message",
            ResourceEdge.source_id == run.assistant_message_id,
            ResourceEdge.ordinal == ordinal,
        )
    ).scalar_one_or_none()
    if existing is not None:
        _delete_citation_edge(db, viewer_id=run.owner_user_id, edge_id=existing)
    try:
        edge = record_citation(
            db,
            viewer_id=run.owner_user_id,
            source=ResourceRef(scheme="message", id=run.assistant_message_id),
            target=target,
            ordinal=ordinal,
            kind="context",
            snapshot=CitationSnapshot(
                title=row["source_title"],
                excerpt=row["exact_snippet"],
                section_label=row["section_label"],
                result_type=row["result_type"],
                deep_link=row["deep_link"],
            ),
        )
    except NotFoundError:
        # justify-ignore-error: the cited target was deleted between retrieval
        # and citation (e.g. a note reindex mid-run). The telemetry row stays;
        # the [n] renders without a chip.
        logger.warning(
            "chat_run.citation_target_vanished",
            run_id=str(run.id),
            target=target.uri,
            ordinal=ordinal,
        )
        return
    db.execute(
        text("UPDATE message_retrievals SET cited_edge_id = :edge_id WHERE id = :id"),
        {"edge_id": edge.id, "id": row["id"]},
    )


def _citation_target_ref(
    db: Session, *, run: ChatRun, row: Mapping[str, Any]
) -> ResourceRef | None:
    """The search-owned citation target for a cited telemetry row."""
    del db, run
    result_ref = row["result_ref"]
    if not isinstance(result_ref, Mapping):
        raise AssertionError("message_retrievals.result_ref must be an object")
    raw_target = result_ref.get("citation_target")
    if raw_target is None:
        return None
    if not isinstance(raw_target, str):
        raise AssertionError("message_retrievals.result_ref.citation_target must be a string")
    target = parse_resource_ref(raw_target)
    if isinstance(target, ResourceRefParseFailure):
        raise AssertionError(
            f"message_retrievals.result_ref.citation_target is invalid: {raw_target!r}"
        )
    if resource_citation_result_type(target) is None:
        raise AssertionError(
            f"message_retrievals.result_ref.citation_target is not citable: {raw_target}"
        )
    return target


def _uuid_or_none(raw: object) -> UUID | None:
    if isinstance(raw, UUID):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        parsed = UUID(raw)
    except ValueError:
        return None
    return parsed if str(parsed) == raw else None


def _app_search_tool_output(run_result: Any, start_ordinal: int) -> str:
    results = [
        {
            "n": start_ordinal + i,
            "title": citation.title,
            "snippet": citation.snippet,
            "kind": citation.result_type,
            "source_label": citation.source_label,
        }
        for i, citation in enumerate(run_result.selected_citations)
    ]
    return json.dumps(
        {
            "results": results,
            "total_candidates": len(run_result.citations),
            "status": run_result.status,
            "error_code": run_result.error_code,
        },
        default=str,
    )


def _web_search_tool_output(run_result: Any, start_ordinal: int) -> str:
    results = [
        {
            "n": start_ordinal + i,
            "title": citation.title,
            "url": citation.url,
            "snippet": citation.snippet,
            "source": citation.source_name,
            "published_at": citation.published_at,
        }
        for i, citation in enumerate(run_result.selected_citations)
    ]
    return json.dumps(
        {
            "results": results,
            "total_candidates": len(run_result.citations),
            "status": run_result.status,
            "error_code": run_result.error_code,
        },
        default=str,
    )


def _persist_attached_citations(
    db: Session, run: ChatRun, citations: tuple[RetrievalCitation, ...]
) -> None:
    """Insert the synthetic parent tool-call + one retrieval per citable attached
    resource, so attached ``<resources>`` get a ``[N]`` chip. The resource's `n`
    (dense, 1..k) is recorded as a citation edge through ``_record_tool_citations``.
    Idempotent on the synthetic ``tool_call_index = 0``.
    """
    existing = db.execute(
        text(
            "SELECT id FROM message_tool_calls "
            "WHERE assistant_message_id = :amid AND tool_call_index = 0 "
            "FOR UPDATE"
        ),
        {"amid": run.assistant_message_id},
    ).first()
    if not citations:
        if existing is not None:
            tool_call_id = existing[0]
            prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
            db.execute(
                text("DELETE FROM message_tool_calls WHERE id = :tool_call_id"),
                {"tool_call_id": tool_call_id},
            )
        return
    if existing is not None:
        tool_call_id = existing[0]
    else:
        tool_call_id = db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id, user_message_id, assistant_message_id, tool_name,
                    tool_call_index, scope, requested_types, result_refs,
                    selected_context_refs, provider_request_ids, status
                )
                VALUES (
                    :conversation_id, :user_message_id, :assistant_message_id,
                    'attached_resources', 0, 'attached_context', '[]'::jsonb,
                    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'complete'
                )
                RETURNING id
                """
            ),
            {
                "conversation_id": run.conversation_id,
                "user_message_id": run.user_message_id,
                "assistant_message_id": run.assistant_message_id,
            },
        ).scalar_one()
    for ordinal, citation in enumerate(citations):
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=ordinal,
            citation=citation,
            selected=True,
            scope="attached_context",
            retrieval_status="attached_context",
            included_in_prompt=True,
        )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id, min_ordinal=len(citations))
    _record_tool_citations(db, run=run, tool_call_id=tool_call_id, start_ordinal=1)


def prune_tool_call_retrievals(
    db: Session, *, tool_call_id: UUID, min_ordinal: int | None = None
) -> None:
    """Delete a tool call's telemetry rows AND the citation edges they cite.

    The single owner of "remove ``message_retrievals`` rows": every prune site —
    attached-citation rebuild, read/inspect trace re-write, and the
    ``app_search``/``web_search`` over-count trim on re-execution — routes here so
    no row is ever dropped without its paired ``origin='citation'`` edge (and any
    now-orphaned ``external_snapshot`` target) dying with it. A pruned cited row
    would otherwise leave a dangling edge that renders as a phantom chip.

    ``min_ordinal`` scopes the prune to ``ordinal >= min_ordinal`` (the over-count
    trim); ``None`` prunes every row for the tool call (full rebuild). Pruned rows
    rarely carry a ``cited_edge_id`` — citation edges are minted after persist — so
    the edge-cleanup work runs only on the re-execution path that produced them.
    """
    ordinal_clause = "" if min_ordinal is None else " AND ordinal >= :min_ordinal"
    params: dict[str, Any] = {"tool_call_id": tool_call_id}
    if min_ordinal is not None:
        params["min_ordinal"] = min_ordinal

    cited_edge_ids = (
        db.execute(
            text(
                "SELECT cited_edge_id FROM message_retrievals "
                f"WHERE tool_call_id = :tool_call_id{ordinal_clause} "
                "AND cited_edge_id IS NOT NULL"
            ),
            params,
        )
        .scalars()
        .all()
    )
    if cited_edge_ids:
        owner_user_id = db.execute(
            select(Conversation.owner_user_id)
            .select_from(MessageToolCall)
            .join(Conversation, Conversation.id == MessageToolCall.conversation_id)
            .where(MessageToolCall.id == tool_call_id)
        ).scalar_one()
        for edge_id in cited_edge_ids:
            _delete_citation_edge(db, viewer_id=owner_user_id, edge_id=edge_id)

    web_snapshot_ids = [
        snapshot_id
        for snapshot_id in (
            _uuid_or_none(source_id)
            for source_id in db.execute(
                text(
                    "SELECT source_id FROM message_retrievals "
                    f"WHERE tool_call_id = :tool_call_id{ordinal_clause} "
                    "AND result_type = 'web_result'"
                ),
                params,
            ).scalars()
        )
        if snapshot_id is not None
    ]

    # The candidate ledger FKs message_retrievals; null its pointer before the
    # delete (app_search/web_search write these; chat-run traces never do, so the
    # UPDATE is a harmless no-op there).
    db.execute(
        text(
            "UPDATE message_retrieval_candidate_ledgers SET retrieval_id = NULL "
            "WHERE retrieval_id IN ("
            "  SELECT id FROM message_retrievals "
            f"  WHERE tool_call_id = :tool_call_id{ordinal_clause}"
            ")"
        ),
        params,
    )
    db.execute(
        text(f"DELETE FROM message_retrievals WHERE tool_call_id = :tool_call_id{ordinal_clause}"),
        params,
    )
    if web_snapshot_ids:
        graph_cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=web_snapshot_ids)


def _delete_citation_edge(db: Session, *, viewer_id: UUID, edge_id: UUID) -> None:
    """Delete one citation edge and the external snapshot it leaves orphaned.

    Web citations mint a ``resource_external_snapshots`` row per cited result
    (``_citation_target_ref``); when the last edge pointing at one is deleted —
    here, in the ordinal-replace path, or by ``prune_tool_call_retrievals`` — the
    snapshot is garbage. Snapshot GC is owned by ``resource_graph.cleanup`` (the
    same owner the domain-parent delete path uses), so every citation-edge
    deletion path collapses to one rule.
    """
    target_scheme, target_id = db.execute(
        select(ResourceEdge.target_scheme, ResourceEdge.target_id).where(ResourceEdge.id == edge_id)
    ).one()
    delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    if target_scheme == "external_snapshot":
        graph_cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=[target_id])


def _persist_read_evidence_citation(
    db: Session,
    *,
    run: ChatRun,
    tool_call_id: UUID,
    result: Any,
    start_ordinal: int,
) -> int | None:
    """Make an evidence read (`quote`/`section`/`full`/`page_range`) citable.

    Materializes the chip via `get_search_result` under the read tool-call and
    returns its `n` (= ``start_ordinal``), or None when the result is not
    evidence (`too_large`/error) or no durable row materializes.
    """
    if result.is_error or result.citation_result_type is None or result.citation_source_id is None:
        return None
    try:
        search_result = get_search_result(
            db, run.owner_user_id, result.citation_result_type, result.citation_source_id
        )
        citation = citation_from_search_result(search_result, filters={})
        citation.selected = True
        insert_retrieval_row(
            db,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation=citation,
            selected=True,
            scope="read_resource",
            retrieval_status="selected",
            included_in_prompt=True,
        )
    except (NotFoundError, ValueError):
        # justify-ignore-error: no resolvable anchor → the read body still
        # returns, but it is not cited (no row, no `n`).
        return None
    _record_tool_citations(db, run=run, tool_call_id=tool_call_id, start_ordinal=start_ordinal)
    return start_ordinal


def _persist_tool_call_start(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_name: str,
    scope: str,
    requested_types: list[str],
) -> UUID:
    params = {
        "conversation_id": run.conversation_id,
        "user_message_id": run.user_message_id,
        "assistant_message_id": run.assistant_message_id,
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "scope": scope,
        "requested_types": requested_types,
    }
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
        params,
    ).first()
    if existing is None:
        return db.execute(
            text(
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
                    NULL,
                    :scope,
                    :requested_types,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    '[]'::jsonb,
                    NULL,
                    'running',
                    NULL
                )
                RETURNING id
                """
            ).bindparams(bindparam("requested_types", type_=JSONB)),
            params,
        ).scalar_one()

    tool_call_id = existing[0]
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET tool_name = :tool_name,
                query_hash = NULL,
                scope = :scope,
                requested_types = :requested_types,
                result_refs = '[]'::jsonb,
                selected_context_refs = '[]'::jsonb,
                provider_request_ids = '[]'::jsonb,
                latency_ms = NULL,
                status = 'running',
                error_code = NULL,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ).bindparams(bindparam("requested_types", type_=JSONB)),
        {**params, "tool_call_id": tool_call_id},
    )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def _persist_tool_call_error(db: Session, *, tool_call_id: UUID, error_code: str) -> None:
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET status = 'error',
                error_code = :error_code,
                updated_at = now()
            WHERE id = :tool_call_id
            """
        ),
        {"tool_call_id": tool_call_id, "error_code": error_code},
    )


def _tool_start_event(
    *,
    run: ChatRun,
    tool_call_id: UUID,
    tool_call_index: int,
    tool_name: str,
    scope: str,
    types: list[str],
    filters: dict[str, object],
) -> dict[str, object]:
    return {
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(run.assistant_message_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "status": "running",
        "scope": scope,
        "types": types,
        "filters": filters,
        "error_code": None,
    }


def _persist_tool_call_trace(
    db: Session,
    *,
    run: ChatRun,
    tool_call_index: int,
    tool_name: str,
    result: Any,
) -> UUID:
    """Persist a read_resource / inspect_resource invocation as a message_tool_calls row.

    Read evidence may get one message_retrievals row after this parent is
    inserted. Inspect maps and too_large redirects stay trace-only.
    """
    payload = {
        "uri": result.uri,
        "status": result.status,
        "error_code": result.error_code,
        "body_chars": len(result.body or ""),
    }
    params = {
        "conversation_id": run.conversation_id,
        "user_message_id": run.user_message_id,
        "assistant_message_id": run.assistant_message_id,
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "payload": json.dumps([payload]),
        "status": "error" if result.is_error else "complete",
        "error_code": result.error_code,
    }
    existing = db.execute(
        text(
            "SELECT id FROM message_tool_calls "
            "WHERE assistant_message_id = :assistant_message_id "
            "AND tool_call_index = :tool_call_index "
            "FOR UPDATE"
        ),
        params,
    ).first()
    if existing is None:
        return db.execute(
            text(
                """
                INSERT INTO message_tool_calls (
                    conversation_id,
                    user_message_id,
                    assistant_message_id,
                    tool_name,
                    tool_call_index,
                    scope,
                    result_refs,
                    selected_context_refs,
                    provider_request_ids,
                    status,
                    error_code
                )
                VALUES (
                    :conversation_id,
                    :user_message_id,
                    :assistant_message_id,
                    :tool_name,
                    :tool_call_index,
                    'conversation_context',
                    CAST(:payload AS JSONB),
                    '[]'::jsonb,
                    '[]'::jsonb,
                    :status,
                    :error_code
                )
                RETURNING id
                """
            ),
            params,
        ).scalar_one()

    tool_call_id = existing[0]
    db.execute(
        text(
            """
            UPDATE message_tool_calls
            SET tool_name = :tool_name,
                scope = 'conversation_context',
                result_refs = CAST(:payload AS JSONB),
                selected_context_refs = '[]'::jsonb,
                provider_request_ids = '[]'::jsonb,
                status = :status,
                error_code = :error_code
            WHERE id = :tool_call_id
            """
        ),
        {**params, "tool_call_id": tool_call_id},
    )
    prune_tool_call_retrievals(db, tool_call_id=tool_call_id)
    return tool_call_id


def _tool_trace_event(
    *,
    run: ChatRun,
    tool_call_id: UUID,
    tool_call_index: int,
    tool_name: str,
    result: Any,
) -> dict[str, object]:
    return {
        "tool_call_id": str(tool_call_id),
        "assistant_message_id": str(run.assistant_message_id),
        "tool_name": tool_name,
        "tool_call_index": tool_call_index,
        "status": "error" if result.is_error else "complete",
        "scope": "conversation_context",
        "types": [],
        "filters": {"uri": result.uri},
        "error_code": result.error_code,
    }


def _emit_citation_index(db: Session, run: ChatRun) -> None:
    """Emit the message's citation set (from edges) + graduate cited local targets.

    The citation_index event carries the graph-built ``CitationOut`` read model
    plus ``citation_edge_id``. Cited local resources not yet in the conversation
    context get an ``origin='citation'`` context edge plus a
    ``context_ref_added`` event built from the returned ContextRefOut.
    """
    message_ref = ResourceRef(scheme="message", id=run.assistant_message_id)
    edges = []
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=run.owner_user_id,
            query=ConnectionQuery(
                refs=(message_ref,),
                direction="outgoing",
                rollup="exact",
                filters=ConnectionFilters(origins=("citation",)),
                limit=100,
                cursor=cursor,
            ),
        )
        edges.extend(edge for edge in page.items if edge.ordinal is not None)
        if page.next_cursor is None:
            break
        cursor = page.next_cursor
    edges.sort(key=lambda edge: edge.ordinal or 0)
    if not edges:
        return
    edge_id_by_ordinal = {edge.ordinal: edge.edge_id for edge in edges}
    citations = []
    for citation in build_citation_outs(db, viewer_id=run.owner_user_id, source=message_ref):
        edge_id = edge_id_by_ordinal.get(citation.ordinal)
        assert edge_id is not None, f"citation ordinal {citation.ordinal} lost its edge id"
        citations.append(
            {
                "citation_edge_id": str(edge_id),
                "citation": citation.model_dump(mode="json"),
            }
        )
    assert len(citations) == len(edges), (
        f"citation read model count mismatch for message {run.assistant_message_id}"
    )
    append_run_event(
        db,
        run,
        "citation_index",
        {"assistant_message_id": str(run.assistant_message_id), "citations": citations},
    )
    for edge in edges:
        if edge.target_ref.scheme == "external_snapshot":
            continue
        if admits_resource_for_conversation_read(
            db, conversation_id=run.conversation_id, target=edge.target_ref
        ):
            continue
        try:
            context_ref = add_context_ref_without_commit(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                target=edge.target_ref,
                origin="citation",
            )
        except NotFoundError:
            # justify-ignore-error: the cited target was deleted after the edge
            # was recorded (mid-run reindex). The citation chip keeps rendering
            # from its snapshot; there is just no context ref to add.
            continue
        append_run_event(
            db,
            run,
            "context_ref_added",
            {
                "id": str(context_ref.edge_id),
                "conversation_id": str(context_ref.conversation_id),
                "resource_ref": context_ref.target.uri,
                "activation": context_ref.activation.model_dump(mode="json"),
                "label": context_ref.resolved.label,
                "summary": context_ref.resolved.summary,
                "missing": context_ref.resolved.missing,
                "created_at": context_ref.created_at,
                "citation_edge_id": str(edge.edge_id),
            },
        )


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    chat_subject: ChatSubjectRequest | None,
    reader_selection: ReaderSelectionRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    requested_subject_ref = _parse_chat_subject(chat_subject)
    resolved_subject = (
        resolve_chat_subject(db, viewer_id=viewer_id, requested_ref=requested_subject_ref)
        if requested_subject_ref is not None
        else None
    )
    subject_ref = resolved_subject.subject_ref if resolved_subject is not None else None

    payload_hash = compute_payload_hash(
        content,
        model_id,
        reasoning,
        key_mode,
        conversation_id,
        parent_message_id,
        branch_anchor,
        requested_subject_ref,
        subject_ref,
        reader_selection,
    )

    existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
        return build_chat_run_response(db, viewer_id, existing)

    model = get_model_by_id(db, model_id)
    if model is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

    try:
        resolved = resolve_api_key(db, viewer_id, model.provider, key_mode)
        use_platform_key = resolved.mode == "platform"
    except ApiError as exc:
        if exc.code != ApiErrorCode.E_MODEL_NOT_AVAILABLE:
            raise
        use_platform_key = False
    except ModelCallError:
        # justify-ignore-error: BYOK probe may fail when the user has no key
        # yet; treat as "no platform key in use" and continue pre-validation.
        use_platform_key = False

    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        parent_message_id,
        branch_anchor,
        subject_ref,
        reader_selection,
        content,
        model_id,
        reasoning,
        key_mode,
        use_platform_key,
    )

    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        subject_context_edge_id: UUID | None = None
        if resolved_subject is not None:
            for ref in resolved_subject.context_refs:
                context_ref = add_context_ref_without_commit(
                    db,
                    viewer_id=viewer_id,
                    conversation_id=conversation_id,
                    target=ref,
                    origin="user" if ref == resolved_subject.subject_ref else "system",
                )
                if ref == resolved_subject.subject_ref:
                    subject_context_edge_id = context_ref.edge_id
        if reader_selection is not None and (
            resolved_subject is None or resolved_subject.subject_ref.scheme != "highlight"
        ):
            add_context_ref_without_commit(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation_id,
                target=ResourceRef(scheme="highlight", id=reader_selection.highlight_id),
                origin="user",
            )

        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
            content,
            model_id,
        )
        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=prepared.conversation.id,
            user_message_id=prepared.user_message.id,
            assistant_message_id=prepared.assistant_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            model_id=model_id,
            reasoning=reasoning,
            key_mode=key_mode,
        )
        db.add(run)
        db.flush()
        if subject_ref is not None or reader_selection is not None:
            db.add(
                ChatRunTurnContext(
                    chat_run_id=run.id,
                    requested_subject_scheme=(
                        requested_subject_ref.scheme if requested_subject_ref else None
                    ),
                    requested_subject_id=requested_subject_ref.id
                    if requested_subject_ref
                    else None,
                    subject_scheme=subject_ref.scheme if subject_ref else None,
                    subject_id=subject_ref.id if subject_ref else None,
                    subject_context_edge_id=subject_context_edge_id,
                    reader_selection_media_id=(
                        reader_selection.media_id if reader_selection is not None else None
                    ),
                    reader_selection_highlight_id=(
                        reader_selection.highlight_id if reader_selection is not None else None
                    ),
                )
            )
        append_run_event(
            db,
            run,
            "meta",
            {
                "run_id": str(run.id),
                "conversation_id": str(prepared.conversation.id),
                "user_message_id": str(prepared.user_message.id),
                "assistant_message_id": str(prepared.assistant_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
                "chat_subject": (
                    {
                        "requested_resource_ref": resolved_subject.requested_ref.uri,
                        "resource_ref": resolved_subject.subject_ref.uri,
                        "context_edge_id": (
                            str(subject_context_edge_id)
                            if subject_context_edge_id is not None
                            else None
                        ),
                        "companions": [ref.uri for ref in resolved_subject.companion_refs],
                    }
                    if resolved_subject is not None
                    else None
                ),
            },
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(run.id)},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def _parse_chat_subject(chat_subject: ChatSubjectRequest | None) -> ResourceRef | None:
    if chat_subject is None:
        return None
    parsed = parse_resource_ref(chat_subject.resource_ref)
    if isinstance(parsed, ResourceRefParseFailure):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "chat_subject.resource_ref is invalid")
    return parsed


def retry_failed_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        assistant_message = load_retryable_failed_assistant_message(
            db,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
        )
        source_run = load_source_run_for_retry(
            db,
            viewer_id=viewer_id,
            assistant_message=assistant_message,
        )
        source_user_message = db.get(Message, source_run.user_message_id)
        if source_user_message is None or source_user_message.role != "user":
            raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source prompt not found")
        payload_hash = compute_retry_payload_hash(
            failed_assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user_message=source_user_message,
        )

        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        model = db.get(Model, source_run.model_id)
        if model is None:
            raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

        user_message = Message(
            conversation_id=source_run.conversation_id,
            seq=assign_next_message_seq(db, source_run.conversation_id),
            role="user",
            content=source_user_message.content,
            message_document=message_document("user", source_user_message.content),
            status="complete",
            parent_message_id=source_user_message.parent_message_id,
            branch_root_message_id=source_user_message.branch_root_message_id,
            branch_anchor_kind=source_user_message.branch_anchor_kind,
            branch_anchor=dict(source_user_message.branch_anchor or {}),
        )
        db.add(user_message)
        db.flush()
        if user_message.parent_message_id is not None:
            ensure_branch_metadata(
                db,
                conversation_id=source_run.conversation_id,
                branch_user_message_id=user_message.id,
            )

        assistant_retry_message = Message(
            conversation_id=source_run.conversation_id,
            seq=assign_next_message_seq(db, source_run.conversation_id),
            role="assistant",
            content="",
            message_document=message_document("assistant", ""),
            status="pending",
            model_id=source_run.model_id,
            parent_message_id=user_message.id,
            branch_root_message_id=user_message.branch_root_message_id,
            branch_anchor_kind="none",
            branch_anchor={},
        )
        db.add(assistant_retry_message)
        db.flush()
        persist_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=source_run.conversation_id,
            active_leaf_message_id=assistant_retry_message.id,
        )

        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=source_run.conversation_id,
            user_message_id=user_message.id,
            assistant_message_id=assistant_retry_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            model_id=source_run.model_id,
            reasoning=source_run.reasoning,
            key_mode=source_run.key_mode,
        )
        db.add(run)
        db.flush()
        source_turn_context = db.get(ChatRunTurnContext, source_run.id)
        if source_turn_context is not None:
            db.add(
                ChatRunTurnContext(
                    chat_run_id=run.id,
                    requested_subject_scheme=source_turn_context.requested_subject_scheme,
                    requested_subject_id=source_turn_context.requested_subject_id,
                    subject_scheme=source_turn_context.subject_scheme,
                    subject_id=source_turn_context.subject_id,
                    subject_context_edge_id=source_turn_context.subject_context_edge_id,
                    reader_selection_media_id=source_turn_context.reader_selection_media_id,
                    reader_selection_highlight_id=source_turn_context.reader_selection_highlight_id,
                )
            )
        append_run_event(
            db,
            run,
            "meta",
            {
                "run_id": str(run.id),
                "conversation_id": str(source_run.conversation_id),
                "user_message_id": str(user_message.id),
                "assistant_message_id": str(assistant_retry_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
                "chat_subject": None,
            },
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(run.id)},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def get_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    return build_chat_run_response(db, viewer_id, run)


def list_chat_runs_for_conversation(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    status: CHAT_RUN_STATUS_FILTER,
) -> list[ChatRunResponse]:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    # "active" means non-terminal; every other value is an exact status match. The
    # filter vocabulary is validated once at the boundary by CHAT_RUN_STATUS_FILTER.
    if status == "active":
        filters = [ChatRun.status.notin_(TERMINAL_RUN_STATUSES)]
    else:
        filters = [ChatRun.status == status]

    runs = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.conversation_id == conversation_id,
                *filters,
            )
            .order_by(ChatRun.created_at.asc(), ChatRun.id.asc())
        )
        .scalars()
        .all()
    )
    return [build_chat_run_response(db, viewer_id, run) for run in runs]


def cancel_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    if run.status not in TERMINAL_RUN_STATUSES and run.cancel_requested_at is None:
        run.cancel_requested_at = datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
        db.commit()
    return build_chat_run_response(db, viewer_id, run)


def get_chat_run_events(
    db: Session,
    *,
    viewer_id: UUID,
    run_id: UUID,
    after: int,
) -> list[ChatRunEventOut]:
    get_run_for_owner(db, viewer_id, run_id)
    rows = (
        db.execute(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id == run_id, ChatRunEvent.seq > after)
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    return [
        ChatRunEventOut(
            seq=row.seq,
            event_type=cast(Any, row.event_type),
            payload=row.payload,
            created_at=row.created_at,
        )
        for row in rows
    ]


def is_chat_run_terminal(db: Session, *, viewer_id: UUID, run_id: UUID) -> bool:
    run = get_run_for_owner(db, viewer_id, run_id)
    return run.status in TERMINAL_RUN_STATUSES


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    get_run_for_owner(db, viewer_id, run_id)


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunModelRuntime,
    web_search_provider: WebSearchProvider | None = None,
) -> dict[str, str]:
    flow_id = str(run_id)
    set_flow_id(flow_id)
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
        )
    except ApiError as exc:
        logger.warning(
            "chat_run.api_error",
            run_id=str(run_id),
            error_code=exc.code.value,
            error=str(exc),
        )
        try:
            finalize_error(
                db,
                run_id=run_id,
                error_code=exc.code.value,
                error_detail=exception_error_detail(exc),
                assistant_content=ERROR_CODE_TO_MESSAGE.get(exc.code.value, exc.message),
            )
            return {"status": "error", "error_code": exc.code.value}
        except Exception:
            db.rollback()
            raise
    except Exception as exc:  # justify-ignore-error: chat-run boundary; finalize the run as failed and report E_INTERNAL
        logger.exception("chat_run.unhandled_error", run_id=str(run_id), error=str(exc))
        try:
            finalize_error(
                db,
                run_id=run_id,
                error_code=ApiErrorCode.E_INTERNAL.value,
                error_detail=exception_error_detail(exc),
            )
            return {"status": "error", "error_code": ApiErrorCode.E_INTERNAL.value}
        except Exception:
            db.rollback()
            raise
    finally:
        set_flow_id(None)


async def _execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunModelRuntime,
    web_search_provider: WebSearchProvider | None = None,
) -> dict[str, str]:
    run = db.get(ChatRun, run_id)
    if run is None:
        return {"status": "skipped", "reason": "run_not_found"}
    if run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}

    if has_delta_without_terminal(db, run.id):
        finalize_interrupted(db, run)
        return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

    model = db.get(Model, run.model_id)
    if model is None:
        finalize_error(
            db,
            run_id=run.id,
            error_code=ApiErrorCode.E_MODEL_NOT_AVAILABLE.value,
        )
        return {"status": "error", "error_code": ApiErrorCode.E_MODEL_NOT_AVAILABLE.value}

    mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        finalize_cancelled(db, run, None)
        return {"status": "cancelled"}

    try:
        resolved_key = resolve_api_key(db, run.owner_user_id, model.provider, run.key_mode)
    except ApiError as exc:
        finalize_error(
            db,
            run_id=run.id,
            error_code=exc.code.value,
            error_detail=exception_error_detail(exc),
            assistant_content=ERROR_CODE_TO_MESSAGE.get(exc.code.value, exc.message),
        )
        return {"status": "error", "error_code": exc.code.value}
    except ModelCallError as exc:
        error_code = api_error_code_for_model_call(exc.error_code).value
        finalize_error(
            db,
            run_id=run.id,
            error_code=error_code,
            error_detail=exception_error_detail(exc),
            assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INVALID_KEY"],
        )
        return {"status": "error", "error_code": error_code}

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(run.owner_user_id)
    budget_reserved = False
    max_output_tokens = _max_output_tokens_for_reasoning(model, run.reasoning)
    try:
        conversation = db.get(Conversation, run.conversation_id)
        user_message = db.get(Message, run.user_message_id)
        if conversation is None or user_message is None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_CONVERSATION_NOT_FOUND.value,
                resolved_key=resolved_key,
                assistant_content="Conversation not found.",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_CONVERSATION_NOT_FOUND.value}

        if is_cancel_requested(db, run.id):
            finalize_cancelled(db, run, resolved_key)
            return {"status": "cancelled"}

        try:
            assembly = assemble_chat_context(
                db,
                run=run,
                model=model,
                max_output_tokens=max_output_tokens,
            )
            persist_prompt_assembly(db, run=run, assembly=assembly)
            reconcile_prompt_retrievals(db, run=run, assembly=assembly)
            _persist_attached_citations(db, run, assembly.attached_citations)
            db.commit()
        except ContextBudgetError as exc:
            logger.warning(
                "chat_run.context_budget_exceeded",
                run_id=str(run.id),
                lane=exc.lane,
                item_key=exc.item_key,
                requested_tokens=exc.requested_tokens,
                remaining_tokens=exc.remaining_tokens,
            )
            error_code = exc.api_error_code.value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                error_detail=exception_error_detail(exc),
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": error_code}

        llm_request = dataclasses.replace(assembly.llm_request, tools=_CHAT_TOOL_SPECS)
        if resolved_key.mode == "platform":
            est_tokens = (
                estimate_tokens("\n".join(turn.content for turn in llm_request.messages))
                + llm_request.max_output_tokens
            )
            rate_limiter.reserve_token_budget(
                run.owner_user_id, run.assistant_message_id, est_tokens
            )
            budget_reserved = True
        turns: list[ModelMessage] = list(llm_request.messages)
        full_content = ""
        usage: TokenUsage | None = None
        provider_request_id: str | None = None
        actual_budget_tokens = 0
        incomplete_reason: str | None = None
        terminal_seen = False
        locally_truncated = False
        citation_n_next = len(assembly.attached_citations) + 1
        tool_call_index_next = 0
        call_owner = LlmCallOwner(kind="chat_run", id=run.id)
        try:
            for _iteration in range(MAX_TOOL_ITERATIONS):
                pending_tool_calls: list[Any] = []
                provider_artifacts: list[ProviderArtifact] = []
                iter_text = ""
                iter_terminal = False
                iter_request = dataclasses.replace(llm_request, messages=turns)
                stream = observed_generate_stream(
                    db,
                    owner=call_owner,
                    # The ledger is typed against the nominal router; chat's seam
                    # stays the structural ChatRunModelRuntime (test fakes), same
                    # cast precedent as llm_task's fixture swap.
                    llm=cast(ModelRuntime, llm_router),
                    provider=model.provider,
                    request=iter_request,
                    api_key=resolved_key.api_key,
                    timeout_s=int(LLM_TIMEOUT_SECONDS),
                    llm_operation="chat_send",
                    key_mode_requested=run.key_mode,
                    key_mode_used=resolved_key.mode,
                )
                try:
                    async for chunk in stream:
                        if chunk.done:
                            iter_terminal = True
                            terminal_seen = True
                            usage = chunk.usage
                            provider_request_id = chunk.provider_request_id
                            terminal_tokens = usage_tokens(chunk.usage)["total_tokens"]
                            if terminal_tokens is not None:
                                actual_budget_tokens += terminal_tokens
                            if chunk.status == "incomplete":
                                incomplete_reason = "unknown"
                                if chunk.incomplete_details is not None:
                                    reason = chunk.incomplete_details.get("reason")
                                    incomplete_reason = (
                                        reason if isinstance(reason, str) else "unknown"
                                    )
                            break
                        if chunk.delta_text:
                            delta = chunk.delta_text
                            if len(full_content) + len(delta) > MAX_ASSISTANT_CONTENT_LENGTH:
                                remaining = MAX_ASSISTANT_CONTENT_LENGTH - len(full_content)
                                delta = delta[: max(remaining, 0)] + TRUNCATION_NOTICE
                            if delta:
                                full_content += delta
                                iter_text += delta
                                append_and_commit(db, run.id, "delta", {"delta": delta})
                            if len(full_content) >= MAX_ASSISTANT_CONTENT_LENGTH:
                                locally_truncated = True
                                stream.record_abandoned(
                                    error_class=ApiErrorCode.E_LLM_INTERRUPTED.value,
                                    error_detail=(
                                        "stream abandoned after local assistant content limit"
                                    ),
                                )
                                break
                        if chunk.tool_call is not None:
                            pending_tool_calls.append(chunk.tool_call)
                        if chunk.provider_artifact is not None:
                            provider_artifacts.append(chunk.provider_artifact)
                        if is_cancel_requested(db, run.id):
                            stream.record_abandoned(
                                error_class=ApiErrorCode.E_CANCELLED.value,
                                error_detail="chat run cancelled during provider stream",
                            )
                            await stream.aclose()
                            finalize_cancelled(db, run, resolved_key)
                            return {"status": "cancelled"}
                finally:
                    await stream.aclose()
                if locally_truncated or not pending_tool_calls:
                    break
                if not iter_terminal:
                    break
                turns.append(
                    ModelMessage(
                        role="assistant",
                        content=iter_text,
                        tool_calls=tuple(pending_tool_calls),
                        provider_artifacts=tuple(provider_artifacts),
                    )
                )
                tool_results: list[ToolResult] = []
                for tc in pending_tool_calls:
                    tool_call_index_next += 1
                    if tc.name == APP_SEARCH_TOOL_NAME:
                        raw_args = tc.arguments or {}
                        args: Mapping[str, Any]
                        if isinstance(raw_args, Mapping):
                            args = raw_args
                            scopes, forced_error = _app_search_scopes_from_tool_args(args)
                            kinds, filter_error = _app_search_string_array_from_tool_args(
                                args, "kinds"
                            )
                            forced_error = forced_error or filter_error
                            formats, filter_error = _app_search_string_array_from_tool_args(
                                args, "formats"
                            )
                            forced_error = forced_error or filter_error
                            authors, filter_error = _app_search_string_array_from_tool_args(
                                args, "authors"
                            )
                            forced_error = forced_error or filter_error
                            roles, filter_error = _app_search_string_array_from_tool_args(
                                args, "roles"
                            )
                            forced_error = forced_error or filter_error
                        else:
                            args = {}
                            scopes = []
                            kinds = None
                            formats = None
                            authors = None
                            roles = None
                            forced_error = "app_search arguments must be an object"
                        app_tool_call_id = _persist_tool_call_start(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=APP_SEARCH_TOOL_NAME,
                            scope="all",
                            requested_types=[],
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_start_event(
                                run=run,
                                tool_call_id=app_tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=APP_SEARCH_TOOL_NAME,
                                scope="all",
                                types=[],
                                filters={},
                            ),
                        )
                        db.commit()
                        run_result = execute_app_search(
                            db,
                            viewer_id=run.owner_user_id,
                            conversation_id=run.conversation_id,
                            user_message_id=run.user_message_id,
                            assistant_message_id=run.assistant_message_id,
                            scopes=scopes,
                            query=str(args.get("query") or ""),
                            kinds=kinds,
                            formats=formats,
                            authors=authors,
                            roles=roles,
                            tool_call_index=tool_call_index_next,
                            forced_error=forced_error,
                        )
                        assert run_result.tool_call_id is not None
                        start_n = citation_n_next
                        citation_n_next = _record_tool_citations(
                            db,
                            run=run,
                            tool_call_id=run_result.tool_call_id,
                            start_ordinal=citation_n_next,
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            {
                                **run_result.tool_call_event(),
                                "status": run_result.status,
                                "error_code": run_result.error_code,
                            },
                        )
                        append_run_event(
                            db, run, "retrieval_result", run_result.retrieval_result_event()
                        )
                        db.commit()
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=_app_search_tool_output(run_result, start_n),
                                is_error=run_result.status == "error",
                            )
                        )
                    elif tc.name == WEB_SEARCH_TOOL_NAME:
                        args = tc.arguments or {}
                        fresh_arg = args.get("freshness_days")
                        freshness_days = fresh_arg if isinstance(fresh_arg, int) else None
                        web_filters: dict[str, object] = {
                            "freshness_days": freshness_days,
                            "allowed_domains": [],
                            "blocked_domains": [],
                        }
                        web_tool_call_id = _persist_tool_call_start(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=WEB_SEARCH_TOOL_NAME,
                            scope="public_web",
                            requested_types=["mixed"],
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_start_event(
                                run=run,
                                tool_call_id=web_tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=WEB_SEARCH_TOOL_NAME,
                                scope="public_web",
                                types=["mixed"],
                                filters=web_filters,
                            ),
                        )
                        db.commit()
                        if web_search_provider is None:
                            error_code = "web_search_not_configured"
                            _persist_tool_call_error(
                                db,
                                tool_call_id=web_tool_call_id,
                                error_code=error_code,
                            )
                            append_run_event(
                                db,
                                run,
                                "tool_call",
                                {
                                    **_tool_start_event(
                                        run=run,
                                        tool_call_id=web_tool_call_id,
                                        tool_call_index=tool_call_index_next,
                                        tool_name=WEB_SEARCH_TOOL_NAME,
                                        scope="public_web",
                                        types=["mixed"],
                                        filters=web_filters,
                                    ),
                                    "status": "error",
                                    "error_code": error_code,
                                },
                            )
                            db.commit()
                            tool_results.append(
                                ToolResult(
                                    call_id=tc.id,
                                    output='{"error":"web_search is not configured"}',
                                    is_error=True,
                                )
                            )
                            continue
                        run_result = await execute_web_search(
                            db,
                            provider=web_search_provider,
                            conversation_id=run.conversation_id,
                            user_message_id=run.user_message_id,
                            assistant_message_id=run.assistant_message_id,
                            query=str(args.get("query") or ""),
                            freshness_days=freshness_days,
                            tool_call_index=tool_call_index_next,
                        )
                        assert run_result.tool_call_id is not None
                        start_n = citation_n_next
                        citation_n_next = _record_tool_citations(
                            db,
                            run=run,
                            tool_call_id=run_result.tool_call_id,
                            start_ordinal=citation_n_next,
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            {
                                **run_result.tool_call_event(),
                                "status": run_result.status,
                                "error_code": run_result.error_code,
                            },
                        )
                        append_run_event(
                            db, run, "retrieval_result", run_result.retrieval_result_event()
                        )
                        db.commit()
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=_web_search_tool_output(run_result, start_n),
                                is_error=run_result.status == "error",
                            )
                        )
                    elif tc.name == READ_RESOURCE_TOOL_NAME:
                        args = tc.arguments or {}
                        uri = str(args.get("uri") or "")
                        read_tool_call_id = _persist_tool_call_start(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=READ_RESOURCE_TOOL_NAME,
                            scope="conversation_context",
                            requested_types=[],
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_start_event(
                                run=run,
                                tool_call_id=read_tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=READ_RESOURCE_TOOL_NAME,
                                scope="conversation_context",
                                types=[],
                                filters={"uri": uri},
                            ),
                        )
                        db.commit()
                        read_result = execute_read_resource(
                            db,
                            viewer_id=run.owner_user_id,
                            conversation_id=run.conversation_id,
                            uri=uri,
                        )
                        read_tool_call_id = _persist_tool_call_trace(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=READ_RESOURCE_TOOL_NAME,
                            result=read_result,
                        )
                        read_n = _persist_read_evidence_citation(
                            db,
                            run=run,
                            tool_call_id=read_tool_call_id,
                            result=read_result,
                            start_ordinal=citation_n_next,
                        )
                        if read_n is not None:
                            citation_n_next += 1
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_trace_event(
                                run=run,
                                tool_call_id=read_tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=READ_RESOURCE_TOOL_NAME,
                                result=read_result,
                            ),
                        )
                        db.commit()
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=read_result.tool_output(n=read_n),
                                is_error=read_result.is_error,
                            )
                        )
                    elif tc.name == INSPECT_RESOURCE_TOOL_NAME:
                        args = tc.arguments or {}
                        uri = str(args.get("uri") or "")
                        inspect_tool_call_id = _persist_tool_call_start(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=INSPECT_RESOURCE_TOOL_NAME,
                            scope="conversation_context",
                            requested_types=[],
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_start_event(
                                run=run,
                                tool_call_id=inspect_tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=INSPECT_RESOURCE_TOOL_NAME,
                                scope="conversation_context",
                                types=[],
                                filters={"uri": uri},
                            ),
                        )
                        db.commit()
                        inspect_result = execute_inspect_resource(
                            db,
                            viewer_id=run.owner_user_id,
                            conversation_id=run.conversation_id,
                            uri=uri,
                        )
                        inspect_tool_call_id = _persist_tool_call_trace(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=INSPECT_RESOURCE_TOOL_NAME,
                            result=inspect_result,
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_trace_event(
                                run=run,
                                tool_call_id=inspect_tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=INSPECT_RESOURCE_TOOL_NAME,
                                result=inspect_result,
                            ),
                        )
                        db.commit()
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=inspect_result.tool_output(),
                                is_error=inspect_result.is_error,
                            )
                        )
                    else:
                        error_code = "unknown_tool"
                        tool_call_id = _persist_tool_call_start(
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_name=tc.name,
                            scope="provider_tool",
                            requested_types=[],
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            _tool_start_event(
                                run=run,
                                tool_call_id=tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=tc.name,
                                scope="provider_tool",
                                types=[],
                                filters={},
                            ),
                        )
                        _persist_tool_call_error(
                            db,
                            tool_call_id=tool_call_id,
                            error_code=error_code,
                        )
                        append_run_event(
                            db,
                            run,
                            "tool_call",
                            {
                                **_tool_start_event(
                                    run=run,
                                    tool_call_id=tool_call_id,
                                    tool_call_index=tool_call_index_next,
                                    tool_name=tc.name,
                                    scope="provider_tool",
                                    types=[],
                                    filters={},
                                ),
                                "status": "error",
                                "error_code": error_code,
                            },
                        )
                        db.commit()
                        tool_results.append(
                            ToolResult(
                                call_id=tc.id,
                                output=f'{{"error":"unknown tool: {tc.name}"}}',
                                is_error=True,
                            )
                        )
                db.commit()
                turns.append(ModelMessage(role="tool", tool_results=tuple(tool_results)))
            else:
                logger.warning(
                    "chat_run.max_tool_iterations_exceeded",
                    run_id=str(run.id),
                    iterations=MAX_TOOL_ITERATIONS,
                )
        except ModelCallError as llm_error:
            error_code = api_error_code_for_model_call(llm_error.error_code).value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                error_detail=exception_error_detail(
                    llm_error, provider_request_id=provider_request_id
                ),
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": error_code}

        if not terminal_seen and not locally_truncated:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if locally_truncated:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                error_detail="stream abandoned after local assistant content limit",
                assistant_content=full_content,
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if incomplete_reason is not None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INCOMPLETE.value,
                error_detail=f"provider stopped early: {incomplete_reason}",
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INCOMPLETE.value}

        if usage_tokens(usage)["total_tokens"] is None:
            error_code = ApiErrorCode.E_LLM_PROVIDER_DOWN.value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                error_detail="provider terminal chunk carried no usage",
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": error_code}

        _emit_citation_index(db, run)
        finalize_run(
            db,
            run_id=run.id,
            assistant_content=full_content,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            resolved_key=resolved_key,
        )
        db.commit()
        if resolved_key.mode == "platform":
            actual_tokens = actual_budget_tokens or usage_tokens(usage)["total_tokens"]
            assert actual_tokens is not None
            rate_limiter.commit_token_budget(
                run.owner_user_id, run.assistant_message_id, actual_tokens
            )
            budget_reserved = False
        return {"status": "complete"}
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(run.owner_user_id, run.assistant_message_id)
        rate_limiter.release_inflight_slot(run.owner_user_id)
