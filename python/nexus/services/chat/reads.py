"""Librarian read models: bounded turns, live citations and operational trust trails.

A trust trail is read, never stored: batched runs, queue jobs, live references,
tool calls and current retrieval targets. Citations belong directly to the answer.
Saved and streamed calls share one semantic projection; a stream frame stores only
the call's identity. Chats are owner-only at every read entry point.
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from pydantic import TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message, MessageRetrieval, ToolCall
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import DurableExecutionPhase, project_execution_phase
from nexus.schemas.chat import (
    AssistantTrustTrailOut,
    AttachmentOut,
    ChatCitationOut,
    ChatFailureOut,
    ChatPublicationWarning,
    ChatRunExecutionOut,
    ChatRunResponse,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
    MessageOut,
    TrustRetrievalOut,
    TrustRunOut,
    TrustToolCallOut,
)
from nexus.schemas.live_reference import LiveReference, ResourceRetrievalTarget, RetrievalTarget
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.chat import events, references
from nexus.services.generation.contract import GenerationSpec
from nexus.services.resource_graph.refs import assert_resource_ref
from nexus.services.resource_items.items import resource_items_out
from nexus.services.tools import assistant_writes, presentation

# An errored run's code maps to its failure card.
FAILURES = {
    "timeout": "incomplete",
    "output_limit": "incomplete",
    "content_filtered": "incomplete",
    "auth": "assistant_unavailable",
    "quota": "assistant_unavailable",
    "rate_limited": "assistant_unavailable",
    "runtime_unavailable": "assistant_unavailable",
    "interrupted": "incomplete",
    "context_too_large": "context_too_large",
    "invalid_output": "invalid_output",
    "policy_violation": "operator_defect",
    "defect": "operator_defect",
}
type Execution = ChatRunExecutionOut | None


def failure(run: ChatRun) -> ChatFailureOut | None:
    code = "cancelled" if run.status == "cancelled" else None
    if run.status == "error":
        code = FAILURES.get(run.error_code or "")
    return ChatFailureOut.model_validate({"code": code}) if code else None


def can_retry(run: ChatRun) -> bool:
    return run.status in ("error", "cancelled")


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
    get_repeatable_read_db(db)
    try:
        return turns(db, viewer_id, [require_run(db, viewer_id=viewer_id, run_id=run_id)])[0]
    finally:
        db.rollback()


def turns(db: Session, viewer_id: UUID, runs: list[ChatRun]) -> list[ChatRunResponse]:
    """Project selected runs in the caller's snapshot with one shared resource batch."""
    if not runs:
        return []
    ids = [identity for run in runs for identity in (run.user_message_id, run.assistant_message_id)]
    messages = list(db.scalars(select(Message).where(Message.id.in_(ids)).order_by(Message.seq)))
    executions = _executions(db, runs)
    calls = list(
        db.scalars(
            select(ToolCall)
            .where(ToolCall.assistant_message_id.in_([run.assistant_message_id for run in runs]))
            .order_by(ToolCall.assistant_message_id, ToolCall.position)
        )
    )
    retrieval_rows = list(
        db.scalars(
            select(MessageRetrieval)
            .where(MessageRetrieval.assistant_message_id.in_(ids))
            .order_by(MessageRetrieval.ordinal)
        )
    )
    message_references = {
        message.id: [LiveReference.model_validate(raw) for raw in message.attachments]
        for message in messages
    }
    targets = _targets(retrieval_rows)
    live = [reference for values in message_references.values() for reference in values]
    live.extend(
        target.reference
        for target in targets.values()
        if isinstance(target, ResourceRetrievalTarget)
    )
    refs = {
        reference.resource_ref: assert_resource_ref(reference.resource_ref) for reference in live
    }
    for call in calls:
        refs.update({ref.uri: ref for ref in presentation.references(call.arguments, call.result)})
    items = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    attachments = references.attachments_by_reference(db, viewer_id, live, items=items)
    figure_keys = {
        reference.model_dump_json()
        for values in message_references.values()
        for reference in values
    }
    figure_keys.update(
        target.reference.model_dump_json()
        for row in retrieval_rows
        if row.citation_ordinal is not None
        and isinstance(target := targets[row.id], ResourceRetrievalTarget)
    )
    attachments.update(
        references.present_attachments(
            db, viewer_id, {key: value for key, value in attachments.items() if key in figure_keys}
        )
    )
    retrieved = _retrieved(
        [row for row in retrieval_rows if row.tool_call_id is not None], targets, attachments
    )
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
                    "undo_allowed": assistant_writes.undo_eligible(
                        db,
                        viewer_id=viewer_id,
                        result=call.result,
                        created_refs=call.created_refs,
                        reverted_at=call.reverted_at,
                    ),
                    "retrievals": retrieved[call.id],
                }
            )
        )
    trails = {
        run.assistant_message_id: AssistantTrustTrailOut(
            run=_trust_run(run, executions[run.id]),
            context=[
                items[reference.resource_ref]
                for reference in message_references[run.user_message_id]
            ],
            tool_calls=tools[run.assistant_message_id],
        )
        for run in runs
    }
    citations: dict[UUID, list[ChatCitationOut]] = defaultdict(list)
    for row in sorted(
        (row for row in retrieval_rows if row.citation_ordinal is not None),
        key=lambda row: cast(int, row.citation_ordinal),
    ):
        target = targets[row.id]
        item, available = _target_item(target, attachments)
        attached = (
            attachments[target.reference.model_dump_json()]
            if isinstance(target, ResourceRetrievalTarget)
            else None
        )
        citations[row.assistant_message_id].append(
            ChatCitationOut(
                id=row.id,
                ordinal=cast(int, row.citation_ordinal),
                target=target,
                item=item,
                location_available=available,
                excerpt=attached.excerpt if attached is not None else None,
                annotation=attached.annotation if attached is not None else None,
                source=attached.source if attached is not None else None,
            )
        )
    outs = {
        message.id: MessageOut(
            id=message.id,
            seq=str(message.seq),
            role=message.role,
            content=message.content,
            status=message.status,
            attachments=[
                attachments[reference.model_dump_json()]
                for reference in message_references[message.id]
            ],
            citations=citations[message.id],
            trust_trail=trails.get(message.id),
            created_at=message.created_at,
            updated_at=message.updated_at,
        )
        for message in messages
    }
    return [
        ChatRunResponse(
            run_id=run.id,
            user_message=outs[run.user_message_id],
            assistant_message=outs[run.assistant_message_id],
            retry_of_run_id=run.retry_of_run_id,
            execution=executions[run.id],
            can_cancel=run.status not in events.TERMINAL,
            can_retry=can_retry(run),
            can_delete=run.status in events.TERMINAL,
        )
        for run in runs
    ]


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
        job = jobs.get(key)
        if job is None:
            assert run.status == "queued", "a running turn requires its job"
            phase = DurableExecutionPhase.Queued
        else:
            phase = project_execution_phase(
                job_status=job.status, attempts=job.attempts, error_code=job.error_code
            )
        out[run.id] = ChatRunExecutionOut(
            phase=phase, cancel_requested=run.cancel_requested_at is not None
        )
    return out


def _targets(rows: Sequence[MessageRetrieval]) -> dict[UUID, RetrievalTarget]:
    decoder = TypeAdapter(RetrievalTarget)
    return {row.id: decoder.validate_python(row.target) for row in rows}


def _target_item(
    target: RetrievalTarget, attachments: Mapping[str, AttachmentOut]
) -> tuple[ResourceItemOut | None, bool]:
    if isinstance(target, ResourceRetrievalTarget):
        attached = attachments[target.reference.model_dump_json()]
        return attached.item, attached.location_available
    return None, True


def _retrieved(
    rows: Sequence[MessageRetrieval],
    targets: Mapping[UUID, RetrievalTarget],
    attachments: Mapping[str, AttachmentOut],
) -> dict[UUID, list[TrustRetrievalOut]]:
    out: dict[UUID, list[TrustRetrievalOut]] = defaultdict(list)
    for row in rows:
        target = targets[row.id]
        item, available = _target_item(target, attachments)
        out[cast(UUID, row.tool_call_id)].append(
            TrustRetrievalOut(id=row.id, target=target, item=item, location_available=available)
        )
    return out


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
            "status": run.status,
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
    targets = _targets(retrieval_rows)
    live = [
        target.reference
        for target in targets.values()
        if isinstance(target, ResourceRetrievalTarget)
    ]
    refs = {
        reference.resource_ref: assert_resource_ref(reference.resource_ref) for reference in live
    }
    for position, call in calls.items():
        result = call.result if position in results else None
        refs.update({ref.uri: ref for ref in presentation.references(call.arguments, result)})
    items = {
        item.ref: item
        for item in resource_items_out(db, viewer_id=viewer_id, refs=list(refs.values()))
    }
    attachments = references.attachments_by_reference(db, viewer_id, live, items=items)
    retrieved = _retrieved(retrieval_rows, targets, attachments)
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
