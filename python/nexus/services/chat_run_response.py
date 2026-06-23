"""Assemble the ChatRunResponse envelope from a persisted ChatRun row."""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent, Conversation, Message
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    AssistantTrustTrailOut,
    ChatRunOut,
    ChatRunResponse,
    ChatRunStreamActivityOut,
    ChatRunStreamStateOut,
    ChatRunStreamToolCallOut,
)
from nexus.services.conversations import (
    conversation_to_out,
    get_message_count,
    message_to_out,
    retryable_assistant_message_ids,
)
from nexus.services.message_trust_trails import build_assistant_trust_trail


def build_chat_run_response(db: Session, viewer_id: UUID, run: ChatRun) -> ChatRunResponse:
    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    assistant_message = db.get(Message, run.assistant_message_id)
    if conversation is None or user_message is None or assistant_message is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")

    message_ids = [user_message.id, assistant_message.id]
    retryable_message_ids = retryable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=message_ids,
    )
    user_message_out = message_to_out(
        user_message,
        can_retry_response=user_message.id in retryable_message_ids,
    )
    trust_trail = build_assistant_trust_trail(
        db,
        viewer_id=viewer_id,
        assistant_message_id=assistant_message.id,
    )
    assistant_message_out = message_to_out(
        assistant_message,
        can_retry_response=assistant_message.id in retryable_message_ids,
        trust_trail=trust_trail,
        citations=[trust_citation.citation for trust_citation in trust_trail.citations],
    )
    return ChatRunResponse(
        run=ChatRunOut.model_validate(run),
        conversation=conversation_to_out(
            db,
            conversation,
            get_message_count(db, conversation.id),
            viewer_id=viewer_id,
        ),
        user_message=user_message_out,
        assistant_message=assistant_message_out,
        stream_state=_stream_state(db, run, assistant_message.content or "", trust_trail),
    )


def _stream_state(
    db: Session,
    run: ChatRun,
    assistant_content: str,
    trust_trail: AssistantTrustTrailOut,
) -> ChatRunStreamStateOut:
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
            index = row.payload.get("tool_call_index")
            if not isinstance(index, int):
                folded_event_seq = row.seq
                continue
            item = tool_calls_by_index.setdefault(
                index,
                {
                    "id": row.payload.get("tool_call_id"),
                    "assistant_message_id": row.payload.get("assistant_message_id"),
                    "tool_name": row.payload.get("tool_name"),
                    "tool_call_index": index,
                    "status": "running",
                    "input_preview": None,
                },
            )
            if row.payload.get("tool_call_id") is not None:
                item["id"] = row.payload.get("tool_call_id")
            if isinstance(row.payload.get("tool_name"), str):
                item["tool_name"] = row.payload["tool_name"]
            if isinstance(row.payload.get("input_preview"), str):
                item["input_preview"] = row.payload["input_preview"]
        elif row.event_type == "tool_result":
            index = row.payload.get("tool_call_index")
            if not isinstance(index, int):
                folded_event_seq = row.seq
                continue
            item = tool_calls_by_index.setdefault(
                index,
                {
                    "id": row.payload.get("tool_call_id"),
                    "assistant_message_id": row.payload.get("assistant_message_id"),
                    "tool_name": row.payload.get("tool_name"),
                    "tool_call_index": index,
                    "status": row.payload.get("status", "running"),
                    "input_preview": None,
                },
            )
            item["id"] = row.payload.get("tool_call_id") or item.get("id")
            item["tool_name"] = row.payload.get("tool_name") or item.get("tool_name")
            item["status"] = row.payload.get("status", item.get("status", "running"))
            item["scope"] = row.payload.get("scope", "provider_tool")
            item["requested_types"] = row.payload.get("types", [])
            item["result_refs"] = row.payload.get("results", [])
            item["source_domain"] = row.payload.get("source_domain")
            item["source_policy"] = row.payload.get("source_policy")
            item["result_count"] = row.payload.get("result_count") or 0
            item["selected_count"] = row.payload.get("selected_count") or 0
            item["provider_request_ids"] = row.payload.get("provider_request_ids") or []
            item["error_code"] = row.payload.get("error_code")
            item["latency_ms"] = row.payload.get("latency_ms")
            item["more_candidates_available"] = (
                row.payload.get("more_candidates_available") or False
            )
        folded_event_seq = row.seq
    for tool in trust_trail.tool_calls:
        item = tool_calls_by_index.setdefault(
            tool.tool_call_index,
            {
                "input_preview": None,
            },
        )
        input_preview = item.get("input_preview")
        item.update(
            {
                "id": tool.id,
                "assistant_message_id": trust_trail.assistant_message_id,
                "tool_name": tool.tool_name,
                "tool_call_index": tool.tool_call_index,
                "status": tool.status,
                "scope": tool.scope,
                "requested_types": tool.requested_types,
                "query_hash": tool.query_hash,
                "latency_ms": tool.latency_ms,
                "error_code": tool.error_code,
                "more_candidates_available": tool.more_candidates_available,
                "result_refs": tool.result_refs,
                "selected_context_refs": tool.selected_context_refs,
                "provider_request_ids": tool.provider_request_ids,
                "source_domain": tool.source_domain,
                "source_policy": tool.source_policy,
                "result_count": tool.result_count,
                "selected_count": tool.selected_count,
                "retrievals": tool.retrievals,
                "candidate_ledgers": tool.candidate_ledgers,
                "rerank_ledgers": tool.rerank_ledgers,
                "input_preview": input_preview,
            }
        )
    terminal = run.status in {"complete", "error", "cancelled"}
    status = (
        "interrupted"
        if run.status == "error" and run.error_code == ApiErrorCode.E_LLM_INTERRUPTED.value
        else run.status
    )
    return ChatRunStreamStateOut(
        status=cast(Any, status),
        last_event_seq=rows[-1].seq if rows else 0,
        folded_event_seq=folded_event_seq,
        assistant_current_text=assistant_content if terminal else text,
        tool_calls=[
            ChatRunStreamToolCallOut.model_validate(item)
            for item in sorted(
                tool_calls_by_index.values(), key=lambda value: value["tool_call_index"]
            )
            if item.get("assistant_message_id") and item.get("tool_name")
        ],
        activity=activity,
        reconnectable=not terminal,
        terminal=terminal,
    )
