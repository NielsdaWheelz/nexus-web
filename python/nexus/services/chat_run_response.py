"""Assemble the ChatRunResponse envelope from a persisted ChatRun row."""

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
    chat_run_event_payload_json,
)
from nexus.schemas.llm import ExpectedChatFailure, RunSelectionOut, Selectable
from nexus.schemas.presence import presence_from_nullable
from nexus.services.chat_failure import (
    chat_failure_projection,
)
from nexus.services.chat_run_access import get_run_for_owner
from nexus.services.chat_run_selection import run_selection_out
from nexus.services.conversations import (
    conversation_to_out,
    get_message_count,
    message_to_out,
    rerunnable_assistant_message_ids,
)
from nexus.services.generation_catalog import GenerationCatalogSnapshot
from nexus.services.message_trust_trails import build_assistant_trust_trail


def read_chat_run_response(
    db: Session,
    viewer_id: UUID,
    run_id: UUID,
    *,
    catalog_snapshot: GenerationCatalogSnapshot,
) -> ChatRunResponse:
    """Read a committed command from one fresh bounded database snapshot."""
    get_repeatable_read_db(db)
    db.expire_all()
    try:
        run = get_run_for_owner(db, viewer_id, run_id)
        return build_chat_run_response(
            db,
            viewer_id,
            run,
            run_selection=run_selection_out(run, catalog_snapshot=catalog_snapshot),
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
    user_message_out = message_to_out(
        db,
        user_message,
        viewer_id=viewer_id,
    )
    trust_trail = build_assistant_trust_trail(
        db,
        viewer_id=viewer_id,
        assistant_message_id=assistant_message.id,
        run_selections={run.id: run_selection},
    )
    assistant_message_out = message_to_out(
        db,
        assistant_message,
        viewer_id=viewer_id,
        can_rerun=assistant_message.id in rerunnable_ids,
        trust_trail=trust_trail,
        citations=[trust_citation.citation for trust_citation in trust_trail.citations],
    )
    failure = chat_failure_projection(
        run,
        selection_selectable=isinstance(run_selection.current_state, Selectable),
    )
    if trust_trail.run is None or trust_trail.run.run_id != run.id:
        raise AssertionError("Chat run response trust projection lost its owning run")
    run_out = _run_out(
        run,
        failure,
        execution=trust_trail.run.execution,
        run_selection=run_selection,
    )
    return ChatRunResponse(
        run=run_out,
        conversation=conversation_to_out(
            db,
            conversation,
            get_message_count(db, conversation.id),
            viewer_id=viewer_id,
        ),
        user_message=user_message_out,
        assistant_message=assistant_message_out,
        stream_state=_stream_state(db, run, assistant_message.content or ""),
    )


def _run_out(
    run: ChatRun,
    failure: ExpectedChatFailure | None,
    *,
    execution: Any,
    run_selection: RunSelectionOut,
) -> ChatRunOut:
    """Project nullable row facts once into the owned chat-run wire contract."""
    return ChatRunOut(
        id=run.id,
        status=cast(Any, run.status),
        conversation_id=run.conversation_id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
        run_selection=run_selection,
        support_id=presence_from_nullable(run.support_id),
        publication_warning=chat_publication_warning_from_nullable(run.publication_warning_code),
        failure=failure,
        execution=execution,
        cancel_requested_at=run.cancel_requested_at,
        started_at=run.started_at,
        completed_at=run.completed_at,
        error_code=run.error_code,
        created_at=run.created_at,
        updated_at=run.updated_at,
    )


def _stream_state(db: Session, run: ChatRun, assistant_content: str) -> ChatRunStreamStateOut:
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
        if row.event_type == "assistant_text_delta":
            raw = row.payload.get("text")
            if isinstance(raw, str):
                text += raw
        elif row.event_type == "assistant_activity":
            phase = row.payload.get("phase")
            if isinstance(phase, str):
                label = row.payload.get("label")
                activity = ChatRunStreamActivityOut(
                    phase=cast(Any, phase),
                    label=label if isinstance(label, str) else None,
                )
        elif row.event_type in {"tool_call_start", "tool_call_delta", "tool_call_done"}:
            payload = chat_run_event_payload_json(row.event_type, row.payload)
            index = payload.get("tool_call_index")
            if not isinstance(index, int):
                folded_event_seq = row.seq
                continue
            item = tool_calls_by_index.setdefault(
                index,
                {
                    "id": payload.get("tool_call_id"),
                    "assistant_message_id": payload.get("assistant_message_id"),
                    "record_kind": payload.get("record_kind"),
                    "canonical_tool_id": payload.get("canonical_tool_id"),
                    "provider_wire_name": payload.get("provider_wire_name"),
                    "effect": payload.get("effect"),
                    "result_kind": payload.get("result_kind"),
                    "activity_label": payload.get("activity_label"),
                    "error_type": payload.get("error_type"),
                    "tool_call_index": index,
                    "status": "running",
                    "input_preview": None,
                },
            )
            if payload.get("tool_call_id") is not None:
                item["id"] = payload.get("tool_call_id")
            for field in (
                "record_kind",
                "canonical_tool_id",
                "provider_wire_name",
                "effect",
                "result_kind",
                "activity_label",
                "error_type",
            ):
                item[field] = payload.get(field)
            if isinstance(payload.get("input_preview"), str):
                item["input_preview"] = payload["input_preview"]
        elif row.event_type == "tool_result":
            payload = chat_run_event_payload_json(row.event_type, row.payload)
            index = payload.get("tool_call_index")
            if not isinstance(index, int):
                folded_event_seq = row.seq
                continue
            item = tool_calls_by_index.setdefault(
                index,
                {
                    "id": payload.get("tool_call_id"),
                    "assistant_message_id": payload.get("assistant_message_id"),
                    "tool_call_index": index,
                    "input_preview": None,
                },
            )
            item.update(
                {
                    "id": payload.get("tool_call_id"),
                    "assistant_message_id": payload.get("assistant_message_id"),
                    "record_kind": payload.get("record_kind"),
                    "canonical_tool_id": payload.get("canonical_tool_id"),
                    "provider_wire_name": payload.get("provider_wire_name"),
                    "effect": payload.get("effect"),
                    "result_kind": payload.get("result_kind"),
                    "activity_label": payload.get("activity_label"),
                    "error_type": payload.get("error_type"),
                    "status": payload.get("status"),
                    "scope": payload.get("scope"),
                    "requested_types": payload.get("types", []),
                    "provider_request_ids": payload.get("provider_request_ids", []),
                    "result_count": payload.get("result_count") or 0,
                    "selected_count": payload.get("selected_count") or 0,
                }
            )
        folded_event_seq = row.seq
    terminal = run.status in {"complete", "error", "cancelled"}
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
