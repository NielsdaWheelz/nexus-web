"""The ``ChatRunResponse`` envelope and the event-log fold behind it."""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent, Conversation, Message
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    ChatRunOut,
    ChatRunResponse,
    ChatRunStreamActivityOut,
    ChatRunStreamStateOut,
    ChatRunStreamToolCallOut,
    chat_publication_warning_from_nullable,
)
from nexus.schemas.llm import RunSelectionOut
from nexus.schemas.presence import presence_from_nullable
from nexus.services.chat_failure import chat_failure_projection
from nexus.services.chat_run_selection import run_selection_out
from nexus.services.conversations import (
    conversation_to_out,
    get_message_count,
    message_to_out,
    rerunnable_assistant_message_ids,
)
from nexus.services.message_trust_trails import build_assistant_trust_trail

_PROJECTION_KEYS = (
    "record_kind",
    "canonical_tool_id",
    "provider_wire_name",
    "effect",
    "result_kind",
    "activity_label",
    "error_type",
)
_TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})


def read_chat_run_response(
    db: Session,
    viewer_id: UUID,
    run_id: UUID,
) -> ChatRunResponse:
    """Read a committed command from one fresh bounded database snapshot."""

    get_repeatable_read_db(db)
    db.expire_all()
    try:
        run = db.get(ChatRun, run_id)
        if run is None or run.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
        return build_chat_run_response(
            db,
            viewer_id,
            run,
            run_selection=run_selection_out(run),
        )
    finally:
        db.rollback()


def build_chat_run_response(
    db: Session,
    viewer_id: UUID,
    run: ChatRun,
    *,
    run_selection: RunSelectionOut,
) -> ChatRunResponse:
    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    assistant_message = db.get(Message, run.assistant_message_id)
    if conversation is None or user_message is None or assistant_message is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")

    rerunnable_ids = rerunnable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=[assistant_message.id],
    )
    trust_trail = build_assistant_trust_trail(
        db,
        viewer_id=viewer_id,
        assistant_message_id=assistant_message.id,
        run_selections={run.id: run_selection},
    )
    if trust_trail.run is None or trust_trail.run.run_id != run.id:
        raise AssertionError("Chat run response trust projection lost its owning run")
    return ChatRunResponse(
        run=ChatRunOut(
            id=run.id,
            status=cast(Any, run.status),
            conversation_id=run.conversation_id,
            user_message_id=run.user_message_id,
            assistant_message_id=run.assistant_message_id,
            run_selection=run_selection,
            support_id=presence_from_nullable(run.support_id),
            publication_warning=chat_publication_warning_from_nullable(
                run.publication_warning_code
            ),
            failure=chat_failure_projection(run),
            execution=trust_trail.run.execution,
            started_at=run.started_at,
            completed_at=run.completed_at,
            error_code=run.error_code,
            created_at=run.created_at,
            updated_at=run.updated_at,
        ),
        conversation=conversation_to_out(
            db,
            conversation,
            get_message_count(db, conversation.id),
            viewer_id=viewer_id,
        ),
        user_message=message_to_out(db, user_message, viewer_id=viewer_id),
        assistant_message=message_to_out(
            db,
            assistant_message,
            viewer_id=viewer_id,
            can_rerun=assistant_message.id in rerunnable_ids,
            trust_trail=trust_trail,
            citations=[trust_citation.citation for trust_citation in trust_trail.citations],
        ),
        stream_state=_stream_state(db, run, assistant_message.content or ""),
    )


def _stream_state(db: Session, run: ChatRun, assistant_content: str) -> ChatRunStreamStateOut:
    """Fold the run's replay log into the state a reconnecting client needs."""

    rows = (
        db.execute(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id == run.id)
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    text = ""
    folded_event_seq = 0
    activity: ChatRunStreamActivityOut | None = None
    tool_calls_by_index: dict[int, dict[str, Any]] = {}
    for row in rows:
        folded_event_seq = row.seq
        payload = row.payload
        if row.event_type == "assistant_text_delta":
            raw = payload.get("text")
            if isinstance(raw, str):
                text += raw
        elif row.event_type == "assistant_activity":
            phase = payload.get("phase")
            if isinstance(phase, str):
                label = payload.get("label")
                activity = ChatRunStreamActivityOut(
                    phase=cast(Any, phase),
                    label=label if isinstance(label, str) else None,
                )
        elif row.event_type in {"tool_call_start", "tool_call_done", "tool_result"}:
            index = payload.get("tool_call_index")
            if not isinstance(index, int):
                continue
            item = tool_calls_by_index.setdefault(
                index,
                {
                    "assistant_message_id": payload.get("assistant_message_id"),
                    "tool_call_index": index,
                    "status": "running",
                    "input_preview": None,
                },
            )
            item.update({key: payload.get(key) for key in _PROJECTION_KEYS})
            if payload.get("tool_call_id") is not None or row.event_type == "tool_result":
                item["id"] = payload.get("tool_call_id")
            if row.event_type == "tool_result":
                item.update(
                    {
                        "assistant_message_id": payload.get("assistant_message_id"),
                        "status": payload.get("status"),
                        "scope": payload.get("scope"),
                        "requested_types": payload.get("types", []),
                        "provider_request_ids": payload.get("provider_request_ids", []),
                        "result_count": payload.get("result_count") or 0,
                        "selected_count": payload.get("selected_count") or 0,
                    }
                )
    terminal = run.status in _TERMINAL_RUN_STATUSES
    return ChatRunStreamStateOut(
        status=cast(Any, run.status),
        last_event_seq=rows[-1].seq if rows else 0,
        folded_event_seq=folded_event_seq,
        assistant_current_text=assistant_content if terminal else text,
        tool_calls=[
            ChatRunStreamToolCallOut.model_validate(item)
            for item in sorted(
                tool_calls_by_index.values(), key=lambda value: value["tool_call_index"]
            )
            if item.get("assistant_message_id") and item.get("record_kind")
        ],
        activity=activity,
        reconnectable=not terminal,
        terminal=terminal,
    )
