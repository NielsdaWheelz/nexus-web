"""Assemble the ChatRunResponse envelope from a persisted ChatRun row."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, Message
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import ChatRunOut, ChatRunResponse
from nexus.services.conversations import (
    conversation_to_out,
    get_message_count,
    message_to_out,
    retryable_assistant_message_ids,
)


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
    assistant_message_out = message_to_out(
        assistant_message,
        can_retry_response=assistant_message.id in retryable_message_ids,
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
    )
