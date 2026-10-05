"""The conversation tree: anchors, the owner's active leaf, paths and fork titles.

A conversation is a tree of user/assistant pairs. The browser receives every
message once and derives paths, alternatives and the fork outline itself; the
server owns only what needs a lock or a durable write: the active leaf (always a
leaf, or null after its deletion) and the per-turn fork title.
"""

from __future__ import annotations

from collections.abc import Mapping
from uuid import UUID

from sqlalchemy import exists, select, update
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.conversation import BranchAnchorRequest, ConversationTreeOut, MessageOut
from nexus.services.conversations import (
    conversation_to_out,
    get_conversation_for_visible_read_or_404,
    message_to_out,
    rerunnable_assistant_message_ids,
)
from nexus.services.message_trust_trails import build_assistant_trust_trails


def branch_anchor_for_message(
    parent_message: Message | None,
    branch_anchor: BranchAnchorRequest,
) -> tuple[str, dict[str, object]]:
    """Validate one send's anchor against its parent and render it for storage."""

    if branch_anchor.kind == "none":
        if parent_message is None:
            return "none", {}
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Existing conversation sends require a non-none branch_anchor",
        )
    if parent_message is None:
        raise ApiError(
            ApiErrorCode.E_BRANCH_PATH_INVALID, "Branch anchors require a parent message"
        )
    if branch_anchor.message_id != parent_message.id:
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Branch anchor message_id must match parent_message_id",
        )
    if branch_anchor.kind == "assistant_message":
        return "assistant_message", {"message_id": str(parent_message.id)}
    if parent_message.role != "assistant" or parent_message.status != "complete":
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Assistant selection anchors require a complete assistant parent",
        )
    payload: dict[str, object] = {
        "message_id": str(parent_message.id),
        "exact": branch_anchor.exact,
        "prefix": branch_anchor.prefix,
        "suffix": branch_anchor.suffix,
        "offset_status": branch_anchor.offset_status,
        "client_selection_id": branch_anchor.client_selection_id,
    }
    start, end = branch_anchor.start_offset, branch_anchor.end_offset
    if branch_anchor.offset_status == "unmapped":
        if start is not None or end is not None:
            raise ApiError(
                ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
                "Unmapped assistant selection anchors cannot include offsets",
            )
        return "assistant_selection", payload
    content = parent_message.content
    if (
        start is None
        or end is None
        or not 0 <= start < end <= len(content)
        or content[start:end] != branch_anchor.exact
        or not content[:start].endswith(branch_anchor.prefix or "")
        or not content[end:].startswith(branch_anchor.suffix or "")
    ):
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Mapped assistant selection offsets do not match the parent answer",
        )
    payload["start_offset"] = start
    payload["end_offset"] = end
    return "assistant_selection", payload


def load_message_path(
    db: Session,
    *,
    conversation_id: UUID,
    leaf_message_id: UUID,
) -> list[Message]:
    """The root-to-leaf path ending at one message of this conversation."""

    by_id = {message.id: message for message in _messages(db, conversation_id)}
    return _path(by_id, leaf_message_id)


def set_active_leaf(db: Session, *, conversation_id: UUID, leaf_message_id: UUID) -> None:
    """Point the conversation at a freshly admitted leaf. Flushes, never commits."""

    db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(active_leaf_message_id=leaf_message_id)
    )


def get_conversation_tree(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> ConversationTreeOut:
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    messages = _messages(db, conversation_id)
    # A null stored leaf (its message was deleted) falls back to the newest
    # message, which is always a leaf: children are admitted after parents.
    leaf_id = conversation.active_leaf_message_id or (messages[-1].id if messages else None)
    return ConversationTreeOut(
        conversation=conversation_to_out(db, conversation, len(messages), viewer_id=viewer_id),
        messages=_message_outs(db, viewer_id, messages),
        active_leaf_message_id=leaf_id,
    )


def select_active_leaf(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    leaf_message_id: UUID,
) -> None:
    """Persist the owner's chosen leaf: a message of this conversation with no children."""

    # The row lock orders this choice against admissions, which move the leaf.
    owned = db.scalar(
        select(Conversation.id)
        .where(Conversation.id == conversation_id, Conversation.owner_user_id == viewer_id)
        .with_for_update()
    )
    if owned is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    is_leaf = db.scalar(
        select(Message.id).where(
            Message.id == leaf_message_id,
            Message.conversation_id == conversation_id,
            ~exists().where(Message.parent_message_id == leaf_message_id),
        )
    )
    if is_leaf is None:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "active_leaf_message_id must be a leaf")
    set_active_leaf(db, conversation_id=conversation_id, leaf_message_id=leaf_message_id)
    db.commit()


def rename_fork(db: Session, *, viewer_id: UUID, message_id: UUID, title: str | None) -> None:
    """Name (or unname) the fork a user turn starts. Owner-only, user turns only."""

    message = db.scalar(
        select(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Message.id == message_id,
            Message.role == "user",
            Conversation.owner_user_id == viewer_id,
        )
    )
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    message.fork_title = title
    db.commit()


def _messages(db: Session, conversation_id: UUID) -> list[Message]:
    return list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq.asc(), Message.id.asc())
        )
    )


def _path(by_id: Mapping[UUID, Message], leaf_message_id: UUID) -> list[Message]:
    path: list[Message] = []
    message = by_id.get(leaf_message_id)
    while message is not None and len(path) <= len(by_id):
        path.append(message)
        if message.parent_message_id is None:
            return path[::-1]
        message = by_id.get(message.parent_message_id)
    raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Invalid conversation path")


def _message_outs(db: Session, viewer_id: UUID, messages: list[Message]) -> list[MessageOut]:
    assistant_ids = [message.id for message in messages if message.role == "assistant"]
    rerunnable = rerunnable_assistant_message_ids(
        db, viewer_id=viewer_id, assistant_message_ids=assistant_ids
    )
    trails = build_assistant_trust_trails(
        db, viewer_id=viewer_id, assistant_message_ids=assistant_ids
    )
    outs: list[MessageOut] = []
    for message in messages:
        trail = trails[message.id] if message.role == "assistant" else None
        outs.append(
            message_to_out(
                db,
                message,
                viewer_id=viewer_id,
                can_rerun=message.id in rerunnable,
                trust_trail=trail,
                citations=[item.citation for item in trail.citations] if trail else [],
            )
        )
    return outs
