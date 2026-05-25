"""ChatRun and Message loaders: ownership checks plus retry-flow source loaders."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation, Message, MessageContextItem, ObjectLink
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


def load_context_rows_for_message(db: Session, message_id: UUID) -> list[MessageContextItem]:
    return list(
        db.execute(
            select(MessageContextItem)
            .where(MessageContextItem.message_id == message_id)
            .order_by(MessageContextItem.ordinal.asc(), MessageContextItem.id.asc())
        )
        .scalars()
        .all()
    )


def copy_context_rows(
    db: Session,
    *,
    viewer_id: UUID,
    source_message_id: UUID,
    target_message_id: UUID,
    rows: Sequence[MessageContextItem],
) -> None:
    for row in rows:
        db.add(
            MessageContextItem(
                message_id=target_message_id,
                user_id=viewer_id,
                context_kind=row.context_kind,
                object_type=row.object_type,
                object_id=row.object_id,
                source_media_id=row.source_media_id,
                locator_json=row.locator_json,
                ordinal=row.ordinal,
                context_snapshot_json=row.context_snapshot_json,
            )
        )
    links = db.scalars(
        select(ObjectLink).where(
            ObjectLink.user_id == viewer_id,
            ObjectLink.relation_type == "used_as_context",
            or_(
                (ObjectLink.a_type == "message") & (ObjectLink.a_id == source_message_id),
                (ObjectLink.b_type == "message") & (ObjectLink.b_id == source_message_id),
            ),
        )
    ).all()
    for link in links:
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type=link.relation_type,
                a_type=link.a_type,
                a_id=target_message_id
                if link.a_type == "message" and link.a_id == source_message_id
                else link.a_id,
                b_type=link.b_type,
                b_id=target_message_id
                if link.b_type == "message" and link.b_id == source_message_id
                else link.b_id,
                a_order_key=link.a_order_key,
                b_order_key=link.b_order_key,
                a_locator_json=(
                    dict(link.a_locator_json) if link.a_locator_json is not None else None
                ),
                b_locator_json=(
                    dict(link.b_locator_json) if link.b_locator_json is not None else None
                ),
                metadata_json=dict(link.metadata_json or {}),
            )
        )
    db.flush()
