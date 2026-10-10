"""Chat read models: failure and rerun policy, the run response, the tree, trust trails.

A trust trail is read, never stored: one batched pass over the answers' runs, their
queue jobs, tool calls, retrievals, citation edges and ``done``/``context_ref_added``
events. Chats are owner-only; every entry point here is owner-gated by its caller
or itself.
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    Conversation,
    Message,
    MessageRetrieval,
    MessageToolCall,
)
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import project_execution_phase
from nexus.schemas.conversation import (
    AssistantTrustTrailOut,
    ChatPublicationWarning,
    ChatRunExecutionOut,
    ChatRunResponse,
    ConversationOut,
    ConversationTreeOut,
    MessageOut,
    ToolProjectionOut,
    TrustCitationOut,
    TrustContextRefAddedOut,
    TrustRetrievalOut,
    TrustRunOut,
    TrustToolCallOut,
)
from nexus.schemas.llm import (
    AssistantUnavailableChatFailure,
    CancelledChatFailure,
    ContextTooLargeChatFailure,
    ExpectedChatFailure,
    IncompleteChatFailure,
    InvalidOutputChatFailure,
    OperatorDefectChatFailure,
    RunSelectionOut,
)
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services.assistant_write_authorship import machine_authorships_for_tool_calls
from nexus.services.chat import events, quotes
from nexus.services.generation.contract import GenerationSpec
from nexus.services.resource_graph.citations import build_citation_outs_for_sources
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.tool_runtime.declarations import CHAT_TOOL_DECLARATIONS_BY_ID

# An errored run's code -> its failure card; an unlisted code has no card.
FAILURES = {
    "timeout": IncompleteChatFailure,
    "output_limit": IncompleteChatFailure,
    "content_filtered": IncompleteChatFailure,
    "auth": AssistantUnavailableChatFailure,
    "quota": AssistantUnavailableChatFailure,
    "rate_limited": AssistantUnavailableChatFailure,
    "runtime_unavailable": AssistantUnavailableChatFailure,
    "interrupted": AssistantUnavailableChatFailure,
    "context_too_large": ContextTooLargeChatFailure,
    "invalid_output": InvalidOutputChatFailure,
    "policy_violation": OperatorDefectChatFailure,
    "defect": OperatorDefectChatFailure,
}
# Transient or chosen outcomes; a deterministic or operator-owned one never reruns.
RERUNNABLE = (CancelledChatFailure, IncompleteChatFailure, AssistantUnavailableChatFailure)

type Execution = Present[ChatRunExecutionOut] | Absent


def failure(run: ChatRun) -> ExpectedChatFailure | None:
    if run.status == "cancelled":
        return CancelledChatFailure(can_rerun=True)
    card = FAILURES.get(run.error_code or "") if run.status == "error" else None
    if card is None:
        return None
    if issubclass(card, RERUNNABLE):
        return card(can_rerun=True)
    return card()


def can_rerun(run: ChatRun) -> bool:
    """The one rerun policy: failure cards, action facts and admission all ask it."""

    return isinstance(failure(run), RERUNNABLE)


def spec(run: ChatRun) -> GenerationSpec:
    """The run's admitted spec. Stored JSON decodes in JSON mode: the strict llm
    schemas take a JSON array as a tuple only there."""

    return GenerationSpec.model_validate_json(json.dumps(run.generation_spec))


def run_selection(run: ChatRun) -> RunSelectionOut:
    """The selection as admitted, never the current catalog's view of it."""

    spec_ = spec(run)
    return RunSelectionOut.model_validate(
        {
            "selection": spec_.selection,
            "display_at_dispatch": spec_.display_at_dispatch,
            "tool_authority": spec_.effect_mode,
        }
    )


def require_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run


def advisory(db: Session, *, run_id: UUID) -> ChatRunExecutionOut | None:
    """The stream's unsequenced liveness frame; None once the run is over."""

    run = db.get(ChatRun, run_id)
    execution = _executions(db, [run])[run.id] if run is not None else absent()
    return execution.value if isinstance(execution, Present) else None


def run_response(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    """One repeatable-read snapshot of a run's conversation and message pair."""

    get_repeatable_read_db(db)
    try:
        run = require_run(db, viewer_id=viewer_id, run_id=run_id)
        conversation = db.get_one(Conversation, run.conversation_id)
        pair = db.scalars(
            select(Message)
            .where(Message.id.in_((run.user_message_id, run.assistant_message_id)))
            .order_by(Message.seq)
        ).all()
        user, assistant = _message_outs(db, viewer_id, list(pair))
        return ChatRunResponse(
            conversation=ConversationOut(id=conversation.id, title=conversation.title),
            user_message=user,
            assistant_message=assistant,
        )
    finally:
        db.rollback()


def tree(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> ConversationTreeOut:
    """Every message once in seq order; the browser derives paths and forks."""

    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    messages = list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq, Message.id)
        )
    )
    # A deleted leaf (FK SET NULL) falls back to the newest message, always a leaf.
    leaf = conversation.active_leaf_message_id or (messages[-1].id if messages else None)
    return ConversationTreeOut(
        conversation=ConversationOut(id=conversation.id, title=conversation.title),
        messages=_message_outs(db, viewer_id, messages),
        active_leaf_message_id=leaf,
    )


def tool_call(
    db: Session, *, viewer_id: UUID, assistant_message_id: UUID, tool_call_id: UUID
) -> TrustToolCallOut:
    """One tool call's trust projection, for the Undo response (the caller owns the answer)."""

    answer = db.get(Message, assistant_message_id)
    trails = _trails(db, viewer_id, [answer] if answer is not None else [])
    calls = trails[assistant_message_id][0].tool_calls if trails else []
    for call in calls:
        if call.id == tool_call_id:
            return call
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Write tool call not found")


def _executions(db: Session, runs: list[ChatRun]) -> dict[UUID, Execution]:
    """A live run projects its one ``chat_run:{id}`` job's phase and the stop intent."""

    live = {f"chat_run:{run.id}": run for run in runs if run.status not in events.TERMINAL}
    out: dict[UUID, Execution] = {run.id: absent() for run in runs}
    if not live:
        return out
    jobs = {
        row.dedupe_key: row
        for row in db.execute(
            text(
                "SELECT dedupe_key, status, attempts, error_code FROM background_jobs"
                " WHERE dedupe_key = ANY(:keys)"
            ),
            {"keys": list(live)},
        )
    }
    for key, run in live.items():
        job = jobs[key]  # a live run always has its job: a missing one is a defect
        phase = project_execution_phase(
            job_status=job.status, attempts=job.attempts, error_code=job.error_code
        )
        execution = ChatRunExecutionOut(
            phase=phase, cancel_requested=run.cancel_requested_at is not None
        )
        out[run.id] = present(execution)
    return out


def _message_outs(db: Session, viewer_id: UUID, messages: list[Message]) -> list[MessageOut]:
    trails = _trails(
        db, viewer_id, [message for message in messages if message.role == "assistant"]
    )
    outs: list[MessageOut] = []
    for message in messages:
        trail, rerun = trails.get(message.id, (None, False))
        snapshot = message.reader_selection_snapshot
        reader_selection = (
            present(quotes.selection_out(db, viewer_id=viewer_id, snapshot=quotes.decode(snapshot)))
            if snapshot is not None
            else absent()
        )
        outs.append(
            MessageOut(
                id=message.id,
                seq=message.seq,
                role=message.role,
                content=message.content,
                status=message.status,
                parent_message_id=message.parent_message_id,
                branch_anchor={"kind": message.branch_anchor_kind, **message.branch_anchor},
                fork_title=message.fork_title,
                reader_selection=reader_selection,
                citations=[item.citation for item in trail.citations] if trail else [],
                trust_trail=trail,
                can_rerun=rerun,
                created_at=message.created_at,
                updated_at=message.updated_at,
            )
        )
    return outs


def _trails(
    db: Session, viewer_id: UUID, answers: list[Message]
) -> dict[UUID, tuple[AssistantTrustTrailOut, bool]]:
    """Each answer's trail and whether it can be rerun, in one batched read."""

    ids = [answer.id for answer in answers]
    if not ids:
        return {}
    runs = {
        run.assistant_message_id: run
        for run in db.scalars(select(ChatRun).where(ChatRun.assistant_message_id.in_(ids)))
    }
    executions = _executions(db, list(runs.values()))
    usage: dict[UUID, Any] = {}
    added: dict[UUID, list[TrustContextRefAddedOut]] = defaultdict(list)
    # Stored payloads carry at least their current model's keys; read them by name.
    for event in db.scalars(
        select(ChatRunEvent)
        .where(
            ChatRunEvent.run_id.in_([run.id for run in runs.values()]),
            ChatRunEvent.event_type.in_(("done", "context_ref_added")),
        )
        .order_by(ChatRunEvent.seq)
    ):
        payload = event.payload
        if event.event_type == "done":
            usage[event.run_id] = payload["usage"]
            continue
        added[event.run_id].append(
            TrustContextRefAddedOut.model_validate(
                {
                    "id": payload["id"],
                    "resource_ref": payload["resource_ref"],
                    "label": payload["label"],
                    "missing": payload["missing"],
                    "chat_run_event_seq": event.seq,
                }
            )
        )
    calls = list(
        db.scalars(
            select(MessageToolCall)
            .where(MessageToolCall.assistant_message_id.in_(ids))
            .order_by(MessageToolCall.assistant_message_id, MessageToolCall.tool_call_index)
        )
    )
    authorships = machine_authorships_for_tool_calls(db, tool_calls=calls)
    retrievals: dict[UUID, list[TrustRetrievalOut]] = defaultdict(list)
    for row in db.scalars(
        select(MessageRetrieval)
        .where(MessageRetrieval.tool_call_id.in_([call.id for call in calls]))
        .order_by(MessageRetrieval.tool_call_id, MessageRetrieval.ordinal)
    ):
        retrievals[row.tool_call_id].append(
            TrustRetrievalOut(
                id=row.id,
                source_id=row.source_id,
                source_title=row.source_title,
                selected=row.selected,
                included_in_prompt=row.included_in_prompt,
                cited_edge_id=row.cited_edge_id,
            )
        )
    tools: dict[UUID, list[TrustToolCallOut]] = defaultdict(list)
    for call in calls:
        tools[call.assistant_message_id].append(
            TrustToolCallOut.model_validate(
                {
                    **_projection(call).model_dump(),
                    "id": call.id,
                    "tool_call_index": call.tool_call_index,
                    "status": call.status,
                    "result_refs": call.result_refs,
                    "machine_authorships": authorships.get(call.id, []),
                    "reverted_at": call.reverted_at,
                    "retrievals": retrievals[call.id],
                }
            )
        )
    sources = [ResourceRef("message", id_) for id_ in ids]
    citations = build_citation_outs_for_sources(
        db, viewer_id=viewer_id, edge_owner_id=viewer_id, sources=sources
    )
    edge_ids = {
        (row.source_id, row.ordinal): row.id
        for row in db.execute(
            text(
                "SELECT id, source_id, ordinal FROM resource_edges WHERE user_id = :viewer"
                " AND source_scheme = 'message' AND source_id = ANY(:ids)"
                " AND origin = 'citation' AND ordinal IS NOT NULL"
            ),
            {"viewer": viewer_id, "ids": ids},
        )
    }
    trails: dict[UUID, tuple[AssistantTrustTrailOut, bool]] = {}
    for answer, source in zip(answers, sources, strict=True):
        run = runs.get(answer.id)
        trail = AssistantTrustTrailOut(
            conversation_id=answer.conversation_id,
            run=_trust_run(run, usage.get(run.id), executions[run.id]) if run else None,
            tool_calls=tools[answer.id],
            citations=[
                TrustCitationOut(
                    citation_edge_id=edge_ids[(answer.id, citation.ordinal)],
                    ordinal=citation.ordinal,
                    citation=citation,
                )
                for citation in citations[source.uri]
            ],
            context_refs_added=added[run.id] if run else [],
        )
        trails[answer.id] = (trail, run is not None and can_rerun(run))
    return trails


def _trust_run(run: ChatRun, usage: Any, execution: Execution) -> TrustRunOut:
    warning = present(ChatPublicationWarning()) if run.publication_warning_code else absent()
    return TrustRunOut.model_validate(
        {
            "run_id": run.id,
            "run_selection": run_selection(run),
            "status": "pending" if run.status == "queued" else run.status,
            "usage": usage,
            "error_code": run.error_code,
            "support_id": presence_from_nullable(run.support_id),
            "publication_warning": warning,
            "failure": failure(run),
            "execution": execution,
        }
    )


def _projection(call: MessageToolCall) -> ToolProjectionOut:
    if call.record_kind == "attached_context":
        return ToolProjectionOut(
            record_kind="attached_context",
            canonical_tool_id=None,
            provider_wire_name=None,
            effect=None,
            result_kind="attached_context",
            activity_label="Attached conversation context",
            error_type=None,
        )
    declaration = CHAT_TOOL_DECLARATIONS_BY_ID[call.canonical_tool_id or ""]
    return ToolProjectionOut.model_validate(
        {
            "record_kind": call.record_kind,
            "canonical_tool_id": call.canonical_tool_id,
            "provider_wire_name": call.provider_wire_name,
            "effect": declaration.spec.effect,
            "result_kind": declaration.result_kind,
            "activity_label": declaration.activity_label,
            "error_type": call.error_code if call.record_kind == "current_execution" else None,
        }
    )
