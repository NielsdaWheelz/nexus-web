"""ChatRun and Message loaders: ownership checks plus retry-flow source loaders."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, Message
from nexus.errors import (
    CHAT_RESPONSE_RETRYABLE_ERROR_CODES,
    ApiError,
    ApiErrorCode,
    NotFoundError,
)


def get_run_for_owner(db: Session, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run


def load_retryable_failed_assistant_message(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> Message:
    message = db.get(Message, assistant_message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    conversation = db.get(Conversation, message.conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    if message.role != "assistant" or message.status != "error":
        raise ApiError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Only failed assistant messages can be retried",
        )
    return message


def load_resendable_assistant_message(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> Message:
    message = db.get(Message, assistant_message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    conversation = db.get(Conversation, message.conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    if message.role != "assistant" or message.status not in {"error", "cancelled"}:
        raise ApiError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Only failed or cancelled assistant messages can be resent",
        )
    return message


def load_source_run_for_retry(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message: Message,
) -> ChatRun:
    run = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id == assistant_message.id,
            )
            .order_by(ChatRun.created_at.desc(), ChatRun.id.desc())
        )
        .scalars()
        .first()
    )
    if run is None:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source run not found")
    if run.conversation_id != assistant_message.conversation_id:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source run is invalid")
    if run.status != "error":
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source run is not failed")
    if run.error_code not in CHAT_RESPONSE_RETRYABLE_ERROR_CODES:
        raise ApiError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "Assistant response is not retryable")
    return run


def load_source_run_for_resend(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message: Message,
) -> ChatRun:
    run = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id == assistant_message.id,
            )
            .order_by(ChatRun.created_at.desc(), ChatRun.id.desc())
        )
        .scalars()
        .first()
    )
    if run is None:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Resend source run not found")
    if run.conversation_id != assistant_message.conversation_id:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Resend source run is invalid")
    if run.status not in {"error", "cancelled"}:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Resend source run is not terminal")
    return run
