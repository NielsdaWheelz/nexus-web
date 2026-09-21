"""The assistant-message trust trail: one batched read over a turn's evidence."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_conversation_ids_cte_sql
from nexus.db.models import (
    ChatPromptAssembly,
    ChatRun,
    ChatRunEvent,
    Conversation,
    Message,
    MessageRetrieval,
    MessageToolCall,
    ResourceEdge,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    AssistantTrustTrailOut,
    ChatRunContextRefAddedEventPayload,
    TrustCitationOut,
    TrustContextRefAddedOut,
    TrustPromptAssemblyOut,
    TrustRetrievalOut,
    TrustRunOut,
    TrustToolCallOut,
    chat_publication_warning_from_nullable,
    tool_projection_from_persisted_record,
)
from nexus.schemas.llm import RunSelectionOut, Selectable
from nexus.schemas.presence import presence_from_nullable
from nexus.services.assistant_write_authorship import machine_authorships_for_tool_calls
from nexus.services.chat_failure import chat_failure_projection
from nexus.services.chat_run_execution import project_chat_run_executions
from nexus.services.chat_run_selection import run_selections_out
from nexus.services.chat_run_tools import decode_persisted_tool_record
from nexus.services.generation_catalog import GenerationCatalogSnapshot
from nexus.services.resource_graph.citations import build_citation_outs_for_sources
from nexus.services.resource_graph.refs import ResourceRef


def build_assistant_trust_trail(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    catalog_snapshot: GenerationCatalogSnapshot | None = None,
    run_selections: Mapping[UUID, RunSelectionOut] | None = None,
) -> AssistantTrustTrailOut:
    trail = build_assistant_trust_trails(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=[assistant_message_id],
        catalog_snapshot=catalog_snapshot,
        run_selections=run_selections,
    ).get(assistant_message_id)
    if trail is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    return trail


def build_assistant_trust_trails(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
    catalog_snapshot: GenerationCatalogSnapshot | None = None,
    run_selections: Mapping[UUID, RunSelectionOut] | None = None,
) -> dict[UUID, AssistantTrustTrailOut]:
    """Read every visible assistant message's run, prompt, tools and citations."""

    if (catalog_snapshot is None) == (run_selections is None):
        raise ValueError(
            "assistant trust projection requires exactly one catalog observation source"
        )
    if not assistant_message_ids:
        return {}

    messages = list(
        db.scalars(
            select(Message).from_statement(
                text(
                    f"""
                    WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                    SELECT m.*
                    FROM messages m
                    JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
                    WHERE m.id = ANY(:assistant_message_ids)
                      AND m.role = 'assistant'
                    """
                )
            ),
            {"viewer_id": viewer_id, "assistant_message_ids": list(assistant_message_ids)},
        )
    )
    if not messages:
        return {}

    message_ids = [message.id for message in messages]
    owner_by_conversation = {
        conversation_id: owner_user_id
        for conversation_id, owner_user_id in db.execute(
            select(Conversation.id, Conversation.owner_user_id).where(
                Conversation.id.in_({message.conversation_id for message in messages})
            )
        )
    }
    runs_by_message = {
        run.assistant_message_id: run
        for run in db.scalars(select(ChatRun).where(ChatRun.assistant_message_id.in_(message_ids)))
    }
    runs = list(runs_by_message.values())
    run_ids = [run.id for run in runs]
    if catalog_snapshot is not None:
        run_selections = run_selections_out(runs, catalog_snapshot=catalog_snapshot)
    assert run_selections is not None
    missing_run_selections = {run.id for run in runs} - set(run_selections)
    if missing_run_selections:
        raise AssertionError(
            "assistant trust projection lacks current selection observations for "
            f"{sorted(str(run_id) for run_id in missing_run_selections)}"
        )
    execution_by_run = project_chat_run_executions(db, runs)

    done_payloads: dict[UUID, dict[str, Any]] = {}
    context_refs_by_run: dict[UUID, list[TrustContextRefAddedOut]] = {}
    if run_ids:
        for event in db.scalars(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id.in_(run_ids), ChatRunEvent.event_type == "done")
            .order_by(ChatRunEvent.seq.desc())
        ):
            done_payloads.setdefault(event.run_id, cast(dict[str, Any], event.payload))
        for event in db.scalars(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id.in_(run_ids), ChatRunEvent.event_type == "context_ref_added")
            .order_by(ChatRunEvent.run_id, ChatRunEvent.seq)
        ):
            payload = ChatRunContextRefAddedEventPayload.model_validate(event.payload)
            context_refs_by_run.setdefault(event.run_id, []).append(
                TrustContextRefAddedOut(
                    chat_run_event_seq=event.seq,
                    id=payload.id,
                    conversation_id=payload.conversation_id,
                    resource_ref=payload.resource_ref,
                    activation=payload.activation,
                    label=payload.label,
                    summary=payload.summary,
                    missing=payload.missing,
                    created_at=payload.created_at,
                    citation_edge_id=payload.citation_edge_id,
                )
            )

    prompt_by_message = {
        row.assistant_message_id: row
        for row in db.scalars(
            select(ChatPromptAssembly).where(
                ChatPromptAssembly.assistant_message_id.in_(message_ids)
            )
        )
    }
    tool_calls = list(
        db.scalars(
            select(MessageToolCall)
            .where(MessageToolCall.assistant_message_id.in_(message_ids))
            .order_by(
                MessageToolCall.assistant_message_id,
                MessageToolCall.tool_call_index,
                MessageToolCall.created_at,
                MessageToolCall.id,
            )
        )
    )
    machine_authorships = machine_authorships_for_tool_calls(db, tool_calls=tool_calls)

    retrievals_by_tool: dict[UUID, list[MessageRetrieval]] = {}
    retrieval_by_edge_id: dict[UUID, MessageRetrieval] = {}
    if tool_calls:
        for retrieval in db.scalars(
            select(MessageRetrieval)
            .where(MessageRetrieval.tool_call_id.in_([tool.id for tool in tool_calls]))
            .order_by(
                MessageRetrieval.tool_call_id,
                MessageRetrieval.ordinal,
                MessageRetrieval.created_at,
                MessageRetrieval.id,
            )
        ):
            retrievals_by_tool.setdefault(retrieval.tool_call_id, []).append(retrieval)
            if retrieval.cited_edge_id is not None:
                retrieval_by_edge_id[retrieval.cited_edge_id] = retrieval

    sources_by_owner: dict[UUID, list[ResourceRef]] = {}
    for message in messages:
        sources_by_owner.setdefault(owner_by_conversation[message.conversation_id], []).append(
            ResourceRef(scheme="message", id=message.id)
        )
    citation_outs_by_message: dict[UUID, dict[int, Any]] = {}
    citation_edges_by_message: dict[UUID, list[ResourceEdge]] = {}
    edge_by_id: dict[UUID, ResourceEdge] = {}
    for owner_id, sources in sources_by_owner.items():
        citation_outs_by_source = build_citation_outs_for_sources(
            db,
            viewer_id=viewer_id,
            edge_owner_id=owner_id,
            sources=sources,
        )
        for source in sources:
            citation_outs_by_message[source.id] = {
                citation.ordinal: citation
                for citation in citation_outs_by_source.get(source.uri, [])
            }
        for edge in db.scalars(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == owner_id,
                ResourceEdge.source_scheme == "message",
                ResourceEdge.source_id.in_([source.id for source in sources]),
                ResourceEdge.origin == "citation",
                ResourceEdge.ordinal.is_not(None),
            )
            .order_by(ResourceEdge.source_id, ResourceEdge.ordinal, ResourceEdge.id)
        ):
            edge_by_id[edge.id] = edge
            citation_edges_by_message.setdefault(edge.source_id, []).append(edge)

    tools_by_message: dict[UUID, list[TrustToolCallOut]] = {}
    for tool in tool_calls:
        projection = tool_projection_from_persisted_record(decode_persisted_tool_record(tool))
        tools_by_message.setdefault(tool.assistant_message_id, []).append(
            TrustToolCallOut(
                **projection.model_dump(mode="python"),
                id=tool.id,
                tool_call_index=tool.tool_call_index,
                status=cast(Any, tool.status),
                scope=tool.scope,
                requested_types=tool.requested_types,
                latency_ms=tool.latency_ms,
                result_count=len(tool.result_refs),
                selected_count=len(tool.selected_context_refs),
                provider_request_ids=tool.provider_request_ids,
                result_refs=tool.result_refs,
                selected_context_refs=tool.selected_context_refs,
                machine_authorships=machine_authorships.get(tool.id, []),
                reverted_at=tool.reverted_at,
                retrievals=[
                    _trust_retrieval(row, edge_by_id) for row in retrievals_by_tool.get(tool.id, [])
                ],
                created_at=tool.created_at,
                updated_at=tool.updated_at,
            )
        )

    trails: dict[UUID, AssistantTrustTrailOut] = {}
    for message in messages:
        run = runs_by_message.get(message.id)
        prompt = prompt_by_message.get(message.id)
        citation_by_ordinal = citation_outs_by_message.get(message.id, {})
        trust_citations: list[TrustCitationOut] = []
        for edge in citation_edges_by_message.get(message.id, []):
            citation = citation_by_ordinal.get(cast(int, edge.ordinal))
            if citation is None:
                continue
            retrieval = retrieval_by_edge_id.get(edge.id)
            trust_citations.append(
                TrustCitationOut(
                    citation_edge_id=edge.id,
                    ordinal=cast(int, edge.ordinal),
                    role=cast(Any, edge.kind),
                    target_ref=citation.target_ref,
                    retrieval_id=retrieval.id if retrieval is not None else None,
                    tool_call_id=retrieval.tool_call_id if retrieval is not None else None,
                    citation=citation,
                )
            )
        done_payload = done_payloads.get(run.id, {}) if run is not None else {}
        trails[message.id] = AssistantTrustTrailOut(
            assistant_message_id=message.id,
            conversation_id=message.conversation_id,
            chat_run_id=run.id if run is not None else None,
            status=cast(Any, _trail_status(message.status, run)),
            run=(
                TrustRunOut(
                    run_id=run.id,
                    run_selection=run_selections[run.id],
                    status=cast(Any, "pending" if run.status == "queued" else run.status),
                    usage=cast(dict[str, Any] | None, done_payload.get("usage")),
                    error_code=run.error_code,
                    support_id=presence_from_nullable(run.support_id),
                    publication_warning=chat_publication_warning_from_nullable(
                        run.publication_warning_code
                    ),
                    failure=chat_failure_projection(
                        run,
                        selection_selectable=isinstance(
                            run_selections[run.id].current_state, Selectable
                        ),
                    ),
                    execution=execution_by_run[run.id],
                    final_chars=cast(int | None, done_payload.get("final_chars")),
                    started_at=run.started_at,
                    completed_at=run.completed_at,
                )
                if run is not None
                else None
            ),
            prompt=(
                TrustPromptAssemblyOut(
                    reserved_output_tokens=prompt.reserved_output_tokens,
                    input_budget_tokens=prompt.input_budget_tokens,
                    estimated_input_tokens=prompt.estimated_input_tokens,
                    included_message_ids=prompt.included_message_ids,
                    included_retrieval_ids=prompt.included_retrieval_ids,
                    included_context_refs=cast(list[dict[str, Any]], prompt.included_context_refs),
                    dropped_items=cast(list[dict[str, Any]], prompt.dropped_items),
                )
                if prompt is not None
                else None
            ),
            tool_calls=tools_by_message.get(message.id, []),
            citations=trust_citations,
            context_refs_added=(context_refs_by_run.get(run.id, []) if run is not None else []),
            created_at=message.created_at,
            updated_at=message.updated_at,
        )
    return trails


def _trail_status(message_status: str, run: ChatRun | None) -> str:
    if run is None:
        return message_status
    if run.status == "queued":
        return "pending"
    if run.status in ("running", "cancelled"):
        return run.status
    return message_status


def _trust_retrieval(
    row: MessageRetrieval,
    edge_by_id: Mapping[UUID, ResourceEdge],
) -> TrustRetrievalOut:
    edge = edge_by_id.get(row.cited_edge_id) if row.cited_edge_id is not None else None
    return TrustRetrievalOut(
        id=row.id,
        tool_call_id=row.tool_call_id,
        ordinal=row.ordinal,
        result_type=cast(Any, row.result_type),
        source_id=row.source_id,
        media_id=row.media_id,
        evidence_span_id=row.evidence_span_id,
        scope=row.scope,
        context_ref=cast(Any, row.context_ref),
        result_ref=cast(Any, row.result_ref),
        deep_link=row.deep_link,
        score=row.score,
        selected=row.selected,
        source_title=row.source_title,
        section_label=row.section_label,
        exact_snippet=row.exact_snippet,
        snippet_prefix=row.snippet_prefix,
        snippet_suffix=row.snippet_suffix,
        locator=cast(Any, row.locator),
        retrieval_status=cast(Any, row.retrieval_status),
        included_in_prompt=row.included_in_prompt,
        created_at=row.created_at,
        citation_candidate_ordinal=presence_from_nullable(row.citation_candidate_ordinal),
        cited_edge_id=row.cited_edge_id,
        citation_number=edge.ordinal if edge is not None else None,
        citation_role=cast(Any, edge.kind) if edge is not None else None,
        included_in_prompt_source="retrieval" if row.included_in_prompt else "none",
    )
