"""Assistant-message trust trail read model."""

from __future__ import annotations

from collections.abc import Sequence
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
    MessageRerankLedger,
    MessageRetrieval,
    MessageRetrievalCandidateLedger,
    MessageToolCall,
    Model,
    ResourceEdge,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    AssistantTrustTrailOut,
    ChatRunContextRefAddedEventPayload,
    MessageRerankLedgerOut,
    MessageRetrievalCandidateLedgerOut,
    TrustCitationOut,
    TrustContextRefAddedOut,
    TrustIntegrityNoticeOut,
    TrustPromptAssemblyOut,
    TrustRetrievalOut,
    TrustRunOut,
    TrustToolCallOut,
)
from nexus.services.resource_graph.citations import build_citation_outs_for_sources
from nexus.services.resource_graph.refs import ResourceRef


def build_assistant_trust_trail(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> AssistantTrustTrailOut:
    trail = build_assistant_trust_trails(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=[assistant_message_id],
    ).get(assistant_message_id)
    if trail is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    return trail


def build_assistant_trust_trails(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
) -> dict[UUID, AssistantTrustTrailOut]:
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
    run_rows = db.execute(
        select(ChatRun, Model)
        .join(Model, Model.id == ChatRun.model_id)
        .where(ChatRun.assistant_message_id.in_(message_ids))
        .order_by(ChatRun.created_at.desc(), ChatRun.id.desc())
    ).all()
    runs_by_message: dict[UUID, tuple[ChatRun, Model]] = {}
    for run, model in run_rows:
        runs_by_message.setdefault(run.assistant_message_id, (run, model))

    run_ids = [run.id for run, _ in runs_by_message.values()]
    done_payloads: dict[UUID, dict[str, Any]] = {}
    if run_ids:
        for event in db.scalars(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id.in_(run_ids), ChatRunEvent.event_type == "done")
            .order_by(ChatRunEvent.seq.desc())
        ):
            done_payloads.setdefault(event.run_id, cast(dict[str, Any], event.payload))

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
    tool_ids = [tool.id for tool in tool_calls]

    retrievals_by_tool: dict[UUID, list[MessageRetrieval]] = {}
    retrieval_by_edge_id: dict[UUID, MessageRetrieval] = {}
    if tool_ids:
        for retrieval in db.scalars(
            select(MessageRetrieval)
            .where(MessageRetrieval.tool_call_id.in_(tool_ids))
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

    rerank_ledgers_by_tool: dict[UUID, list[MessageRerankLedgerOut]] = {}
    tool_output_tool_ids: set[UUID] = set()
    if tool_ids:
        for row in db.scalars(
            select(MessageRerankLedger)
            .where(MessageRerankLedger.tool_call_id.in_(tool_ids))
            .order_by(
                MessageRerankLedger.tool_call_id,
                MessageRerankLedger.created_at,
                MessageRerankLedger.id,
            )
        ):
            if row.metadata_.get("inclusion_surface") == "tool_output":
                tool_output_tool_ids.add(row.tool_call_id)
            rerank_ledgers_by_tool.setdefault(row.tool_call_id, []).append(
                MessageRerankLedgerOut(
                    id=row.id,
                    tool_call_id=row.tool_call_id,
                    strategy=row.strategy,
                    input_count=row.input_count,
                    selected_count=row.selected_count,
                    budget_chars=row.budget_chars,
                    selected_chars=row.selected_chars,
                    status=row.status,
                    metadata=row.metadata_,
                    created_at=row.created_at,
                )
            )

    candidate_ledgers_by_tool: dict[UUID, list[MessageRetrievalCandidateLedgerOut]] = {}
    if tool_ids:
        rows = db.execute(
            select(MessageRetrievalCandidateLedger, MessageRetrieval.included_in_prompt)
            .outerjoin(
                MessageRetrieval,
                MessageRetrieval.id == MessageRetrievalCandidateLedger.retrieval_id,
            )
            .where(MessageRetrievalCandidateLedger.tool_call_id.in_(tool_ids))
            .order_by(
                MessageRetrievalCandidateLedger.tool_call_id,
                MessageRetrievalCandidateLedger.ordinal,
                MessageRetrievalCandidateLedger.created_at,
                MessageRetrievalCandidateLedger.id,
            )
        ).all()
        for row, linked_included in rows:
            if linked_included is None:
                included = row.included_in_prompt
                source = "candidate_ledger"
                reconciled = True
            else:
                included = linked_included
                source = (
                    "tool_output"
                    if linked_included and row.tool_call_id in tool_output_tool_ids
                    else "linked_retrieval"
                )
                reconciled = row.included_in_prompt == linked_included
            candidate_ledgers_by_tool.setdefault(row.tool_call_id, []).append(
                MessageRetrievalCandidateLedgerOut(
                    id=row.id,
                    tool_call_id=row.tool_call_id,
                    retrieval_id=row.retrieval_id,
                    ordinal=row.ordinal,
                    result_type=cast(Any, row.result_type),
                    source_id=row.source_id,
                    score=row.score,
                    selected=row.selected,
                    included_in_prompt=included,
                    ledger_included_in_prompt=row.included_in_prompt,
                    linked_retrieval_included_in_prompt=linked_included,
                    included_in_prompt_source=cast(Any, source),
                    included_in_prompt_reconciled=reconciled,
                    selection_status=row.selection_status,
                    selection_reason=row.selection_reason,
                    result_ref=cast(Any, row.result_ref),
                    locator=cast(Any, row.locator),
                    created_at=row.created_at,
                )
            )

    retrievals_by_message: dict[UUID, list[MessageRetrieval]] = {}
    for tool in tool_calls:
        retrievals_by_message.setdefault(tool.assistant_message_id, []).extend(
            retrievals_by_tool.get(tool.id, [])
        )

    context_refs_by_run: dict[UUID, list[TrustContextRefAddedOut]] = {}
    if run_ids:
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
                    label=payload.label,
                    summary=payload.summary,
                    missing=payload.missing,
                    created_at=payload.created_at,
                    citation_edge_id=payload.citation_edge_id,
                )
            )

    sources_by_owner: dict[UUID, list[ResourceRef]] = {}
    for message in messages:
        owner_id = owner_by_conversation[message.conversation_id]
        sources_by_owner.setdefault(owner_id, []).append(
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
        prompt = prompt_by_message.get(tool.assistant_message_id)
        prompt_retrieval_ids = set(prompt.included_retrieval_ids if prompt is not None else [])
        retrievals: list[TrustRetrievalOut] = []
        for row in retrievals_by_tool.get(tool.id, []):
            citation_number = None
            citation_role = None
            if row.cited_edge_id is not None:
                edge = edge_by_id.get(row.cited_edge_id)
                if edge is not None:
                    citation_number = edge.ordinal
                    citation_role = cast(Any, edge.kind)
            if row.included_in_prompt:
                included_in_prompt = True
                included_source = (
                    "tool_output" if row.tool_call_id in tool_output_tool_ids else "retrieval"
                )
            elif str(row.id) in prompt_retrieval_ids:
                included_in_prompt = True
                included_source = "prompt_assembly"
            else:
                included_in_prompt = False
                included_source = "none"
            retrievals.append(
                TrustRetrievalOut(
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
                    included_in_prompt=included_in_prompt,
                    created_at=row.created_at,
                    cited_edge_id=row.cited_edge_id,
                    citation_number=citation_number,
                    citation_role=citation_role,
                    included_in_prompt_source=cast(Any, included_source),
                )
            )
        tools_by_message.setdefault(tool.assistant_message_id, []).append(
            TrustToolCallOut(
                id=tool.id,
                tool_name=tool.tool_name,
                tool_call_index=tool.tool_call_index,
                status=cast(Any, tool.status),
                scope=tool.scope,
                requested_types=tool.requested_types,
                query_hash=tool.query_hash,
                latency_ms=tool.latency_ms,
                result_count=len(tool.result_refs),
                selected_count=len(tool.selected_context_refs),
                more_candidates_available=tool.tool_name in {"app_search", "web_search"}
                and len(tool.result_refs) > len(tool.selected_context_refs),
                error_code=tool.error_code,
                provider_request_ids=tool.provider_request_ids,
                result_refs=tool.result_refs,
                selected_context_refs=tool.selected_context_refs,
                retrievals=retrievals,
                candidate_ledgers=candidate_ledgers_by_tool.get(tool.id, []),
                rerank_ledgers=rerank_ledgers_by_tool.get(tool.id, []),
                created_at=tool.created_at,
                updated_at=tool.updated_at,
            )
        )

    trails: dict[UUID, AssistantTrustTrailOut] = {}
    for message in messages:
        run_row = runs_by_message.get(message.id)
        run = run_row[0] if run_row is not None else None
        model = run_row[1] if run_row is not None else None
        prompt = prompt_by_message.get(message.id)
        citation_by_ordinal = citation_outs_by_message.get(message.id, {})
        trust_citations: list[TrustCitationOut] = []
        citation_ref_by_edge_id: dict[UUID, str] = {}
        citation_edge_ids = {edge.id for edge in citation_edges_by_message.get(message.id, [])}
        for edge in citation_edges_by_message.get(message.id, []):
            citation = citation_by_ordinal.get(cast(int, edge.ordinal))
            if citation is None:
                continue
            citation_ref_by_edge_id[edge.id] = f"{edge.target_scheme}:{edge.target_id}"
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
        if run is None:
            trail_status = "pending" if message.status == "pending" else message.status
        elif run.status == "queued":
            trail_status = "pending"
        elif run.status == "running":
            trail_status = "running"
        elif run.status == "cancelled":
            trail_status = "cancelled"
        else:
            trail_status = message.status

        context_refs_added = context_refs_by_run.get(run.id, []) if run is not None else []

        integrity_notices: list[TrustIntegrityNoticeOut] = []
        for row in retrievals_by_message.get(message.id, []):
            if row.selected and row.cited_edge_id is None:
                integrity_notices.append(
                    TrustIntegrityNoticeOut(
                        code=f"selected_retrieval_missing_citation:{row.id}",
                        message=f"Selected retrieval {row.id} has no citation edge.",
                    )
                )
            if row.cited_edge_id is not None and row.cited_edge_id not in citation_edge_ids:
                integrity_notices.append(
                    TrustIntegrityNoticeOut(
                        code=f"retrieval_cited_edge_missing:{row.id}",
                        message=(
                            f"Retrieval {row.id} points at missing citation edge "
                            f"{row.cited_edge_id}."
                        ),
                    )
                )
        for edge in citation_edges_by_message.get(message.id, []):
            if edge.id not in retrieval_by_edge_id:
                integrity_notices.append(
                    TrustIntegrityNoticeOut(
                        code=f"citation_missing_retrieval:{edge.id}",
                        message=f"Citation edge {edge.id} has no matching retrieval row.",
                    )
                )
            if edge.ordinal not in citation_by_ordinal:
                integrity_notices.append(
                    TrustIntegrityNoticeOut(
                        code=f"citation_missing_read_model:{edge.id}",
                        message=f"Citation edge {edge.id} did not build a citation read model.",
                    )
                )
        for tool in tools_by_message.get(message.id, []):
            for ledger in tool.candidate_ledgers:
                if not ledger.included_in_prompt_reconciled:
                    integrity_notices.append(
                        TrustIntegrityNoticeOut(
                            code=f"candidate_inclusion_mismatch:{ledger.id}",
                            message=(
                                f"Candidate ledger {ledger.id} prompt-inclusion flag "
                                "disagrees with its retrieval row."
                            ),
                        )
                    )
        if prompt is not None:
            retrieval_ids = {str(row.id) for row in retrievals_by_message.get(message.id, [])}
            for retrieval_id in prompt.included_retrieval_ids:
                if retrieval_id not in retrieval_ids:
                    integrity_notices.append(
                        TrustIntegrityNoticeOut(
                            code=f"prompt_retrieval_missing:{retrieval_id}",
                            message=(
                                f"Prompt assembly includes retrieval {retrieval_id}, "
                                "but the message has no matching retrieval row."
                            ),
                        )
                    )
        for context_ref in context_refs_added:
            if (
                context_ref.citation_edge_id is None
                or context_ref.citation_edge_id not in citation_edge_ids
                or citation_ref_by_edge_id.get(context_ref.citation_edge_id)
                != context_ref.resource_ref
            ):
                integrity_notices.append(
                    TrustIntegrityNoticeOut(
                        code=f"context_ref_missing_citation:{context_ref.chat_run_event_seq}",
                        message=(
                            f"Context-ref event {context_ref.chat_run_event_seq} does not "
                            "match a citation edge on this message."
                        ),
                    )
                )

        trails[message.id] = AssistantTrustTrailOut(
            assistant_message_id=message.id,
            conversation_id=message.conversation_id,
            chat_run_id=run.id if run is not None else None,
            status=cast(Any, trail_status),
            run=(
                TrustRunOut(
                    run_id=run.id,
                    model_id=run.model_id,
                    provider=model.provider,
                    model_name=model.model_name,
                    reasoning_mode=run.reasoning,
                    key_mode=run.key_mode,
                    status=cast(Any, "pending" if run.status == "queued" else run.status),
                    usage=cast(dict[str, Any] | None, done_payload.get("usage")),
                    error_code=run.error_code,
                    final_chars=cast(int | None, done_payload.get("final_chars")),
                    started_at=run.started_at,
                    completed_at=run.completed_at,
                )
                if run is not None and model is not None
                else None
            ),
            prompt=(
                TrustPromptAssemblyOut(
                    id=prompt.id,
                    cacheable_input_tokens_estimate=prompt.cacheable_input_tokens_estimate,
                    prompt_block_manifest=cast(dict[str, Any], prompt.prompt_block_manifest),
                    max_context_tokens=prompt.max_context_tokens,
                    reserved_output_tokens=prompt.reserved_output_tokens,
                    reserved_reasoning_tokens=prompt.reserved_reasoning_tokens,
                    input_budget_tokens=prompt.input_budget_tokens,
                    estimated_input_tokens=prompt.estimated_input_tokens,
                    included_message_ids=prompt.included_message_ids,
                    included_retrieval_ids=prompt.included_retrieval_ids,
                    included_context_refs=cast(list[dict[str, Any]], prompt.included_context_refs),
                    dropped_items=cast(list[dict[str, Any]], prompt.dropped_items),
                    budget_breakdown=cast(dict[str, Any], prompt.budget_breakdown),
                    created_at=prompt.created_at,
                )
                if prompt is not None
                else None
            ),
            tool_calls=tools_by_message.get(message.id, []),
            citations=trust_citations,
            context_refs_added=context_refs_added,
            integrity_notices=integrity_notices,
            created_at=message.created_at,
            updated_at=message.updated_at,
        )
    return trails
