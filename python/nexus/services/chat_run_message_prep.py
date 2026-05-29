"""Prepare the user + pending-assistant message pair for a new chat run."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import BranchAnchorRequest
from nexus.services.chat_run_message_blocks import message_document
from nexus.services.chat_run_validation import load_valid_parent_for_send
from nexus.services.conversation_branches import (
    branch_anchor_for_message,
    ensure_branch_metadata,
    persist_active_leaf,
)
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    derive_conversation_title,
)
from nexus.services.seq import assign_next_message_seq


@dataclass
class PreparedMessages:
    conversation: Conversation
    user_message: Message
    assistant_message: Message


def prepare_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
) -> PreparedMessages:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    parent_message = load_valid_parent_for_send(
        db,
        conversation_id=conversation.id,
        parent_message_id=parent_message_id,
    )

    user_seq = assign_next_message_seq(db, conversation.id)
    if user_seq == 1 and conversation.title == DEFAULT_CONVERSATION_TITLE:
        conversation.title = derive_conversation_title(content)
    branch_anchor_kind, branch_anchor_payload = branch_anchor_for_message(
        parent_message,
        branch_anchor,
    )
    branch_root_message_id = parent_message.id if parent_message is not None else None

    user_message = Message(
        conversation_id=conversation.id,
        seq=user_seq,
        role="user",
        content=content,
        message_document=message_document("user", content),
        status="complete",
        model_id=None,
        parent_message_id=parent_message.id if parent_message is not None else None,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind=branch_anchor_kind,
        branch_anchor=branch_anchor_payload,
    )
    db.add(user_message)
    db.flush()

    if parent_message is not None:
        ensure_branch_metadata(
            db,
            conversation_id=conversation.id,
            branch_user_message_id=user_message.id,
        )

    assistant_message = Message(
        conversation_id=conversation.id,
        seq=assign_next_message_seq(db, conversation.id),
        role="assistant",
        content="",
        message_document=message_document("assistant", ""),
        status="pending",
        model_id=model_id,
        parent_message_id=user_message.id,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind="none",
        branch_anchor={},
    )
    db.add(assistant_message)
    db.flush()
    persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation.id,
        active_leaf_message_id=assistant_message.id,
    )

    return PreparedMessages(
        conversation=conversation,
        user_message=user_message,
        assistant_message=assistant_message,
    )
