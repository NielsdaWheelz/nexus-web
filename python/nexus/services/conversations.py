"""Conversation and Message service layer.

Implements conversation and message CRUD for Slice 3, PR-02.

All operations:
- Enforce owner-only access (sharing UI deferred to S4)
- Use E_CONVERSATION_NOT_FOUND / E_MESSAGE_NOT_FOUND consistently (prevent probing)
- Support cursor-based pagination

Service functions correspond 1:1 with route handlers.
Routes are transport-only and call exactly one service function.
"""

import base64
import json
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import ConversationOut, MessageOut, PageInfo

logger = get_logger(__name__)

# =============================================================================
# Constants
# =============================================================================

# Pagination limits
DEFAULT_LIMIT = 50
MIN_LIMIT = 1
MAX_LIMIT = 100


# =============================================================================
# Cursor Encoding/Decoding
# =============================================================================


def encode_conversation_cursor(updated_at: datetime, id: UUID) -> str:
    """Encode a cursor for conversation pagination.

    Cursor payload: {"updated_at": "<iso>", "id": "<uuid>"}
    Encoding: base64url without padding
    """
    payload = {"updated_at": updated_at.isoformat(), "id": str(id)}
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def decode_conversation_cursor(cursor: str) -> tuple[datetime, UUID]:
    """Decode a cursor for conversation pagination.

    Returns:
        Tuple of (updated_at, id)

    Raises:
        InvalidRequestError: If cursor is malformed or unparseable.
    """
    try:
        # Add padding if needed
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding

        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))

        updated_at = datetime.fromisoformat(payload["updated_at"])
        id = UUID(payload["id"])
        return updated_at, id
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def encode_message_cursor(seq: int, id: UUID) -> str:
    """Encode a cursor for message pagination.

    Cursor payload: {"seq": <int>, "id": "<uuid>"}
    Encoding: base64url without padding
    """
    payload = {"seq": seq, "id": str(id)}
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def decode_message_cursor(cursor: str) -> tuple[int, UUID]:
    """Decode a cursor for message pagination.

    Returns:
        Tuple of (seq, id)

    Raises:
        InvalidRequestError: If cursor is malformed or unparseable.
    """
    try:
        # Add padding if needed
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding

        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))

        seq = int(payload["seq"])
        id = UUID(payload["id"])
        return seq, id
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


# =============================================================================
# Helper Functions
# =============================================================================


def clamp_limit(limit: int) -> int:
    """Clamp limit to valid range [MIN_LIMIT, MAX_LIMIT]."""
    return min(max(limit, MIN_LIMIT), MAX_LIMIT)


def get_conversation_for_viewer_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Load conversation and verify ownership.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            OR viewer is not the owner.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def get_message_count(db: Session, conversation_id: UUID) -> int:
    """Get the count of messages in a conversation."""
    result = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id)
    )
    return result or 0


def conversation_to_out(conversation: Conversation, message_count: int) -> ConversationOut:
    """Convert Conversation ORM model to ConversationOut schema."""
    return ConversationOut(
        id=conversation.id,
        sharing=conversation.sharing,
        message_count=message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def message_to_out(message: Message) -> MessageOut:
    """Convert Message ORM model to MessageOut schema."""
    return MessageOut(
        id=message.id,
        seq=message.seq,
        role=message.role,
        content=message.content,
        status=message.status,
        error_code=message.error_code,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


# =============================================================================
# Service Functions
# =============================================================================


def create_conversation(db: Session, viewer_id: UUID) -> ConversationOut:
    """Create a new empty private conversation.

    Args:
        db: Database session.
        viewer_id: The ID of the user creating the conversation.

    Returns:
        The created conversation with message_count=0.
    """
    conversation = Conversation(
        owner_user_id=viewer_id,
        sharing="private",
        next_seq=1,
    )

    db.add(conversation)
    db.flush()
    db.commit()

    return conversation_to_out(conversation, message_count=0)


def get_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> ConversationOut:
    """Get a conversation by ID.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation.

    Returns:
        The conversation with message_count.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
    """
    conversation = get_conversation_for_viewer_or_404(db, viewer_id, conversation_id)
    message_count = get_message_count(db, conversation_id)
    return conversation_to_out(conversation, message_count)


def list_conversations(
    db: Session,
    viewer_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> tuple[list[ConversationOut], PageInfo]:
    """List conversations owned by the viewer.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque pagination cursor.

    Returns:
        Tuple of (conversations, page_info).

    Raises:
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    limit = clamp_limit(limit)

    # Build base query
    # Using raw SQL for complex tuple comparison with proper ordering
    if cursor:
        cursor_updated_at, cursor_id = decode_conversation_cursor(cursor)

        # Tuple comparison for DESC ordering: (updated_at, id) < (cursor.updated_at, cursor.id)
        # This means we want rows where:
        # - updated_at < cursor_updated_at, OR
        # - updated_at = cursor_updated_at AND id < cursor_id
        result = db.execute(
            text("""
                SELECT c.id, c.sharing, c.created_at, c.updated_at,
                       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
                FROM conversations c
                WHERE c.owner_user_id = :viewer_id
                  AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)
                ORDER BY c.updated_at DESC, c.id DESC
                LIMIT :limit
            """),
            {
                "viewer_id": viewer_id,
                "cursor_updated_at": cursor_updated_at,
                "cursor_id": cursor_id,
                "limit": limit + 1,  # Fetch one extra to check for more
            },
        )
    else:
        result = db.execute(
            text("""
                SELECT c.id, c.sharing, c.created_at, c.updated_at,
                       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
                FROM conversations c
                WHERE c.owner_user_id = :viewer_id
                ORDER BY c.updated_at DESC, c.id DESC
                LIMIT :limit
            """),
            {
                "viewer_id": viewer_id,
                "limit": limit + 1,  # Fetch one extra to check for more
            },
        )

    rows = result.fetchall()

    # Check if there are more results
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    conversations = [
        ConversationOut(
            id=row[0],
            sharing=row[1],
            created_at=row[2],
            updated_at=row[3],
            message_count=row[4],
        )
        for row in rows
    ]

    # Build next_cursor from last item
    next_cursor = None
    if has_more and conversations:
        last = conversations[-1]
        next_cursor = encode_conversation_cursor(last.updated_at, last.id)

    return conversations, PageInfo(next_cursor=next_cursor)


def delete_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    """Delete a conversation.

    Cascades to messages, message_context, conversation_media, conversation_shares
    via FK CASCADE.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation to delete.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
    """
    # Verify ownership
    get_conversation_for_viewer_or_404(db, viewer_id, conversation_id)

    # Delete via raw SQL to let CASCADE do its work
    db.execute(delete(Conversation).where(Conversation.id == conversation_id))
    db.flush()
    db.commit()


def list_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> tuple[list[MessageOut], PageInfo]:
    """List messages in a conversation.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque pagination cursor.

    Returns:
        Tuple of (messages, page_info).

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    # Verify ownership
    get_conversation_for_viewer_or_404(db, viewer_id, conversation_id)

    limit = clamp_limit(limit)

    # Build query with ASC ordering (oldest first, chat order)
    if cursor:
        cursor_seq, cursor_id = decode_message_cursor(cursor)

        # Tuple comparison for ASC ordering: (seq, id) > (cursor.seq, cursor.id)
        result = db.execute(
            text("""
                SELECT m.id, m.seq, m.role, m.content, m.status, m.error_code,
                       m.created_at, m.updated_at
                FROM messages m
                WHERE m.conversation_id = :conversation_id
                  AND (m.seq, m.id) > (:cursor_seq, :cursor_id)
                ORDER BY m.seq ASC, m.id ASC
                LIMIT :limit
            """),
            {
                "conversation_id": conversation_id,
                "cursor_seq": cursor_seq,
                "cursor_id": cursor_id,
                "limit": limit + 1,
            },
        )
    else:
        result = db.execute(
            text("""
                SELECT m.id, m.seq, m.role, m.content, m.status, m.error_code,
                       m.created_at, m.updated_at
                FROM messages m
                WHERE m.conversation_id = :conversation_id
                ORDER BY m.seq ASC, m.id ASC
                LIMIT :limit
            """),
            {
                "conversation_id": conversation_id,
                "limit": limit + 1,
            },
        )

    rows = result.fetchall()

    # Check if there are more results
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    messages = [
        MessageOut(
            id=row[0],
            seq=row[1],
            role=row[2],
            content=row[3],
            status=row[4],
            error_code=row[5],
            created_at=row[6],
            updated_at=row[7],
        )
        for row in rows
    ]

    # Build next_cursor from last item
    next_cursor = None
    if has_more and messages:
        last = messages[-1]
        next_cursor = encode_message_cursor(last.seq, last.id)

    return messages, PageInfo(next_cursor=next_cursor)


def delete_message(db: Session, viewer_id: UUID, message_id: UUID) -> None:
    """Delete a single message.

    If this is the last message in the conversation, deletes the conversation too.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        message_id: The ID of the message to delete.

    Raises:
        NotFoundError(E_MESSAGE_NOT_FOUND): If message doesn't exist
            or viewer is not the conversation owner.
    """
    # Load message with conversation
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    # Verify viewer owns the conversation (masked as message not found)
    conversation = message.conversation
    if conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

    conversation_id = conversation.id

    # Delete the message (CASCADE handles message_context)
    db.execute(delete(Message).where(Message.id == message_id))
    db.flush()

    # Check remaining message count in same transaction
    remaining = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id)
    )

    # If no messages remain, delete conversation
    if remaining == 0:
        db.execute(delete(Conversation).where(Conversation.id == conversation_id))
        db.flush()

    db.commit()
