"""Chat read models: failure and rerun policy, the run response, the tree, trust trails.

A trust trail is read, never stored: batched runs, queue jobs, scope references,
tool calls and captured retrievals. Citations belong directly to the answer.
Saved and streamed calls share one semantic projection; a stream frame stores only
the call's identity. Chats are owner-only at every read entry point.
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, Message, MessageRetrieval, ToolCall
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import project_execution_phase
from nexus.schemas.conversation import (
    AssistantTrustTrailOut,
    ChatFailureOut,
    ChatPublicationWarning,
    ChatRunExecutionOut,
    ChatRunResponse,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
    ConversationOut,
    ConversationTreeOut,
    MessageOut,
    TrustRetrievalOut,
    TrustRunOut,
    TrustToolCallOut,
)
from nexus.schemas.resource_evidence import CapturedEvidence
from nexus.schemas.resource_items import RetrievalSourceTargetKey
from nexus.services.chat import events, quotes
from nexus.services.generation.contract import GenerationSpec
from nexus.services.resource_graph.citations import build_citation_outs_for_sources
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.evidence import evidence_items
from nexus.services.resource_items.items import resource_items_out
from nexus.services.tools import assistant_writes, presentation

# An errored run's code -> its failure card; an unlisted code has no card.
FAILURES = {
    "timeout": "incomplete",
    "output_limit": "incomplete",
    "content_filtered": "incomplete",
    "auth": "assistant_unavailable",
    "quota": "assistant_unavailable",
    "rate_limited": "assistant_unavailable",
    "runtime_unavailable": "assistant_unavailable",
    "interrupted": "assistant_unavailable",
    "context_too_large": "context_too_large",
    "invalid_output": "invalid_output",
    "policy_violation": "operator_defect",
    "defect": "operator_defect",
}
# Transient or chosen outcomes; a deterministic or operator-owned one never reruns.
RERUNNABLE = frozenset({"cancelled", "incomplete", "assistant_unavailable"})

type Execution = ChatRunExecutionOut | None


def failure(run: ChatRun) -> ChatFailureOut | None:
    code = "cancelled" if run.status == "cancelled" else None
    if run.status == "error":
        code = FAILURES.get(run.error_code or "")
    return ChatFailureOut.model_validate({"code": code}) if code else None


def can_rerun(run: ChatRun) -> bool:
    """The one rerun policy: failure cards, action facts and admission all ask it."""

    card = failure(run)
    return card is not None and card.code in RERUNNABLE


def spec(run: ChatRun) -> GenerationSpec:
    """The run's admitted spec. Stored JSON decodes in JSON mode: the strict llm
    schemas take a JSON array as a tuple only there."""

    return GenerationSpec.model_validate_json(json.dumps(run.generation_spec))


def require_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run


def advisory(db: Session, *, run_id: UUID) -> ChatRunExecutionOut | None:
    """The stream's unsequenced liveness frame; None once the run is over."""

    run = db.get(ChatRun, run_id)
    return _executions(db, [run])[run.id] if run is not None else None


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
            conversation=_conversation(conversation), user_message=user, assistant_message=assistant
        )
    finally:
        db.rollback()


def tree(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> ConversationTreeOut:
    """Every message once in seq order; the browser derives paths and forks."""

    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    messages = db.scalars(
        select(Message).where(Message.conversation_id == conversation_id).order_by(Message.seq)
    ).all()
    return ConversationTreeOut(
        conversation=_conversation(conversation),
        messages=_message_outs(db, viewer_id, list(messages)),
        active_leaf_message_id=conversation.active_leaf_message_id,
    )


def _conversation(conversation: Conversation) -> ConversationOut:
    return ConversationOut(
        id=conversation.id, title=conversation.title, branch_revision=conversation.branch_revision
    )


def _executions(db: Session, runs: list[ChatRun]) -> dict[UUID, Execution]:
    """A live run projects its one ``chat_run:{id}`` job's phase and the stop intent."""

    live = {f"chat_run:{run.id}": run for run in runs if run.status not in events.TERMINAL}
    out: dict[UUID, Execution] = {run.id: None for run in runs}
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
        out[run.id] = ChatRunExecutionOut(
            phase=phase, cancel_requested=run.cancel_requested_at is not None
        )
    return out


def _message_outs(db: Session, viewer_id: UUID, messages: list[Message]) -> list[MessageOut]:
    trails = _trails(
        db, viewer_id, [message for message in messages if message.role == "assistant"]
    )
    citations = build_citation_outs_for_sources(
        db,
        viewer_id=viewer_id,
        edge_owner_id=viewer_id,
        sources=[ResourceRef("message", message.id) for message in messages],
    )
    outs: list[MessageOut] = []
    for message in messages:
        trail, run = trails.get(message.id, (None, None))
        snapshot = message.reader_selection_snapshot
        outs.append(
            MessageOut.model_validate(
                {
                    "id": message.id,
                    "seq": message.seq,
                    "role": message.role,
                    "content": message.content,
                    "status": message.status,
                    "parent_message_id": message.parent_message_id,
                    "branch_anchor": {"kind": message.branch_anchor_kind, **message.branch_anchor},
                    "fork_title": message.fork_title,
                    "reader_selection": quotes.selection_out(
                        db,
                        viewer_id=viewer_id,
                        snapshot=quotes.decode(snapshot),
                        message_id=message.id,
                    )
                    if snapshot is not None
                    else None,
                    "citations": citations[f"message:{message.id}"],
                    "trust_trail": trail,
                    "can_rerun": run is not None and can_rerun(run),
                    "created_at": message.created_at,
                    "updated_at": message.updated_at,
                }
            )
        )
    return outs


def _retrieved(
    db: Session, viewer_id: UUID, rows: Sequence[MessageRetrieval]
) -> dict[UUID, list[TrustRetrievalOut]]:
    """A call's captured results in their recorded order, with current navigation."""

    occurrences = []
    for row in rows:
        captured = CapturedEvidence.model_validate(row.captured_evidence)
        uri = row.result_ref.get("citation_target") or captured.target.owner_ref
        occurrences.append(
            (
                assert_resource_ref(cast(str, uri)),
                captured,
                RetrievalSourceTargetKey(retrieval_id=row.id),
            )
        )
    items = evidence_items(db, viewer_id=viewer_id, occurrences=occurrences)
    out: dict[UUID, list[TrustRetrievalOut]] = defaultdict(list)
    for row, item in zip(rows, items, strict=True):
        out[cast(UUID, row.tool_call_id)].append(TrustRetrievalOut(id=row.id, item=item))
    return out


def _trails(
    db: Session, viewer_id: UUID, answers: list[Message]
) -> dict[UUID, tuple[AssistantTrustTrailOut, ChatRun]]:
    """Saved scope membership and observed actions, independently of current edges."""

    ids = [answer.id for answer in answers]
    if not ids:
        return {}
    runs = {
        run.assistant_message_id: run
        for run in db.scalars(select(ChatRun).where(ChatRun.assistant_message_id.in_(ids)))
    }
    scopes = {
        answer_id: [assert_resource_ref(uri) for uri in spec(run).tool_scope]
        for answer_id, run in runs.items()
    }
    executions = _executions(db, list(runs.values()))
    calls = list(
        db.scalars(
            select(ToolCall)
            .where(ToolCall.assistant_message_id.in_(ids))
            .order_by(ToolCall.assistant_message_id, ToolCall.position)
        )
    )
    refs = {ref.uri: ref for scope in scopes.values() for ref in scope}
    for call in calls:
        refs.update({ref.uri: ref for ref in presentation.references(call.arguments, call.result)})
    items = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    retrieval_rows = list(
        db.scalars(
            select(MessageRetrieval)
            .where(MessageRetrieval.assistant_message_id.in_(ids))
            .order_by(MessageRetrieval.ordinal)
        )
    )
    retrieved = _retrieved(db, viewer_id, [r for r in retrieval_rows if r.tool_call_id is not None])
    # The context identity is not necessarily its citation target (a highlight
    # cites its parent). One saved ref uses its earliest attached receipt.
    scope_uris = {answer_id: {ref.uri for ref in scope} for answer_id, scope in scopes.items()}
    attachments: dict[tuple[UUID, str], MessageRetrieval] = {}
    for row in retrieval_rows:
        uri = f"{row.context_ref['type']}:{row.context_ref['id']}"
        if row.tool_call_id is None and uri in scope_uris[row.assistant_message_id]:
            attachments.setdefault((row.assistant_message_id, uri), row)
    captured_context = evidence_items(
        db,
        viewer_id=viewer_id,
        occurrences=[
            (
                assert_resource_ref(uri),
                CapturedEvidence.model_validate(row.captured_evidence),
                RetrievalSourceTargetKey(retrieval_id=row.id),
            )
            for (_, uri), row in attachments.items()
        ],
    )
    historical = dict(zip(attachments, captured_context, strict=True))
    tools: dict[UUID, list[TrustToolCallOut]] = defaultdict(list)
    for call in calls:
        projected = presentation.project(
            call.tool_id,
            arguments=call.arguments,
            result=call.result,
            status=call.status,
            items=items,
        )
        tools[cast(UUID, call.assistant_message_id)].append(
            TrustToolCallOut.model_validate(
                {
                    **projected.model_dump(),
                    "id": call.id,
                    "tool_call_index": call.position,
                    "status": call.status,
                    "created_refs": presentation.created_refs(call.created_refs),
                    "machine_authorships": assistant_writes.authorships(call),
                    "reverted_at": call.reverted_at,
                    "retrievals": retrieved[call.id],
                }
            )
        )
    trails: dict[UUID, tuple[AssistantTrustTrailOut, ChatRun]] = {}
    for answer in answers:
        run = runs[answer.id]  # every answer has its run; the chat reslice migration refused others
        trail = AssistantTrustTrailOut(
            run=_trust_run(run, executions[run.id]),
            context=[
                historical.get((answer.id, ref.uri), items[ref.uri]) for ref in scopes[answer.id]
            ],
            tool_calls=tools[answer.id],
        )
        trails[answer.id] = (trail, run)
    return trails


def _trust_run(run: ChatRun, execution: Execution) -> TrustRunOut:
    """The selection as admitted, never the current catalog's view of it."""

    selection = spec(run)
    return TrustRunOut.model_validate(
        {
            "run_id": run.id,
            "run_selection": {
                "selection": selection.selection,
                "display_at_dispatch": selection.display_at_dispatch,
            },
            "status": "pending" if run.status == "queued" else run.status,
            "support_id": run.support_id,
            "publication_warning": ChatPublicationWarning()
            if run.publication_warning_code
            else None,
            "failure": failure(run),
            "execution": execution,
        }
    )


@dataclass(frozen=True, slots=True)
class StreamEvent:
    seq: int
    event_type: str
    payload: dict[str, Any]


def read_events(
    db: Session, *, viewer_id: UUID, run_id: UUID, after: int
) -> tuple[list[StreamEvent], bool]:
    """The single live/replay read boundary; tool pages hydrate once, text pages never.

    Calls are joined by message and position (every tool frame has its call row; the
    chat reslice migration refused others). Historical frame ids survive a call rekey. A start frame
    projects arguments alone, even when this snapshot also holds the call's result.
    """

    run = require_run(db, viewer_id=viewer_id, run_id=run_id)
    rows, terminal = events.read_after(db, run_id, after)
    tool_types = {"tool_call_start", "tool_result"}
    positions = {row.payload["tool_call_index"] for row in rows if row.event_type in tool_types}
    if not positions:
        return [StreamEvent(row.seq, row.event_type, row.payload) for row in rows], terminal
    calls = {
        call.position: call
        for call in db.scalars(
            select(ToolCall).where(
                ToolCall.assistant_message_id == run.assistant_message_id,
                ToolCall.position.in_(positions),
            )
        )
    }
    results = {row.payload["tool_call_index"] for row in rows if row.event_type == "tool_result"}
    result_ids = [calls[position].id for position in results]
    retrieval_rows = (
        db.scalars(
            select(MessageRetrieval)
            .where(MessageRetrieval.tool_call_id.in_(result_ids))
            .order_by(MessageRetrieval.ordinal)
        ).all()
        if result_ids
        else []
    )
    retrieved = _retrieved(db, viewer_id, retrieval_rows)
    refs: dict[str, ResourceRef] = {}
    for position, call in calls.items():
        result = call.result if position in results else None
        refs.update({ref.uri: ref for ref in presentation.references(call.arguments, result)})
    items = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    out = []
    for row in rows:
        if row.event_type not in tool_types:
            out.append(StreamEvent(row.seq, row.event_type, row.payload))
            continue
        payload = row.payload
        call = calls[payload["tool_call_index"]]
        is_result = row.event_type == "tool_result"
        facts = {
            **presentation.project(
                call.tool_id,
                arguments=call.arguments,
                result=call.result if is_result else None,
                status=payload["status"] if is_result else "running",
                items=items,
            ).model_dump(),
            "tool_call_id": payload["tool_call_id"],
            "tool_call_index": payload["tool_call_index"],
        }
        frame = (
            ChatRunToolResultEventOut.model_validate(
                {
                    **facts,
                    "error_type": payload["error_type"],
                    "status": payload["status"],
                    "retrievals": retrieved[call.id],
                    "created_refs": presentation.created_refs(call.created_refs),
                }
            )
            if is_result
            else ChatRunToolCallStartEventOut.model_validate(facts)
        )
        out.append(StreamEvent(row.seq, row.event_type, frame.model_dump(mode="json")))
    return out, terminal
