"""Conversation-scope predicates and constraints for a chat run."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, Message, MessageToolCall


def is_source_backed_run(
    db: Session,
    *,
    run: ChatRun,
    assistant_message: Message | None,
    evidence_rows: list[dict[str, Any]],
) -> bool:
    if evidence_rows:
        return True
    conversation = db.get(Conversation, run.conversation_id)
    if conversation is not None and conversation.scope_type in {"media", "library"}:
        return True
    if assistant_message is None:
        return False
    tool_call_count = db.execute(
        select(func.count(MessageToolCall.id)).where(
            MessageToolCall.assistant_message_id == assistant_message.id
        )
    ).scalar_one()
    return bool(tool_call_count)


def scope_constraints_for_run(db: Session, run: ChatRun) -> dict[str, object]:
    conversation = db.get(Conversation, run.conversation_id)
    if conversation is None:
        return {"type": "general"}
    if conversation.scope_type == "media" and conversation.scope_media_id is not None:
        return {"type": "media", "media_id": str(conversation.scope_media_id)}
    if conversation.scope_type == "library" and conversation.scope_library_id is not None:
        return {"type": "library", "library_id": str(conversation.scope_library_id)}
    return {"type": conversation.scope_type}
