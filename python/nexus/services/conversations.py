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

from nexus.auth.permissions import can_read_conversation
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


def get_conversation_for_visible_read_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Load conversation and verify read visibility under s4 rules.

    Visible iff viewer is owner, or conversation is public, or conversation is
    library-shared with both viewer and owner as members of a share-target library.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer cannot read it.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def get_conversation_for_owner_write_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Load conversation and verify owner-only write access.

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


def conversation_to_out(
    conversation: Conversation, message_count: int, viewer_id: UUID | None = None
) -> ConversationOut:
    """Convert Conversation ORM model to ConversationOut schema.

    Args:
        conversation: The ORM conversation.
        message_count: Pre-computed message count.
        viewer_id: The viewing user. Used to compute is_owner.
    """
    return ConversationOut(
        id=conversation.id,
        owner_user_id=conversation.owner_user_id,
        is_owner=(viewer_id is not None and conversation.owner_user_id == viewer_id),
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

    return conversation_to_out(conversation, message_count=0, viewer_id=viewer_id)


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
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    message_count = get_message_count(db, conversation_id)
    return conversation_to_out(conversation, message_count, viewer_id=viewer_id)


VALID_SCOPES = {"mine", "all", "shared"}


def _build_visibility_cte(viewer_id: UUID) -> str:
    """Return a SQL CTE that selects conversation IDs visible to viewer.

    Visible means:
    - Owner, OR
    - Public, OR
    - Library-shared with active dual membership (viewer + owner in share-target library)
    """
    return """
        visible_conversations AS (
            SELECT c.id
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
            UNION
            SELECT c.id
            FROM conversations c
            WHERE c.sharing = 'public'
            UNION
            SELECT c.id
            FROM conversations c
            JOIN conversation_shares cs ON cs.conversation_id = c.id
            JOIN memberships vm ON vm.library_id = cs.library_id AND vm.user_id = :viewer_id
            JOIN memberships om ON om.library_id = cs.library_id AND om.user_id = c.owner_user_id
            WHERE c.sharing = 'library'
        )
    """


def list_conversations(
    db: Session,
    viewer_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
    scope: str = "mine",
) -> tuple[list[ConversationOut], PageInfo]:
    """List conversations with scope-based visibility.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque pagination cursor.
        scope: One of 'mine' (default), 'all', 'shared'.

    Returns:
        Tuple of (conversations, page_info).

    Raises:
        InvalidRequestError(E_INVALID_REQUEST): If scope is invalid.
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    if scope not in VALID_SCOPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid scope: {scope}. Must be one of: mine, all, shared",
        )

    limit = clamp_limit(limit)

    if scope == "mine":
        return _list_conversations_mine(db, viewer_id, limit, cursor)
    else:
        return _list_conversations_visible(db, viewer_id, limit, cursor, scope)


def _list_conversations_mine(
    db: Session,
    viewer_id: UUID,
    limit: int,
    cursor: str | None,
) -> tuple[list[ConversationOut], PageInfo]:
    """List only conversations owned by viewer (scope=mine)."""
    params: dict = {"viewer_id": viewer_id, "limit": limit + 1}

    cursor_clause = ""
    if cursor:
        cursor_updated_at, cursor_id = decode_conversation_cursor(cursor)
        cursor_clause = "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)"
        params["cursor_updated_at"] = cursor_updated_at
        params["cursor_id"] = cursor_id

    result = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    )

    return _build_conversation_page(result.fetchall(), limit, viewer_id)


def _list_conversations_visible(
    db: Session,
    viewer_id: UUID,
    limit: int,
    cursor: str | None,
    scope: str,
) -> tuple[list[ConversationOut], PageInfo]:
    """List visible conversations (scope=all or scope=shared).

    Visibility predicate is applied in SQL before cursor+limit to maintain
    correct global cursor ordering.
    """
    params: dict = {"viewer_id": viewer_id, "limit": limit + 1}

    cursor_clause = ""
    if cursor:
        cursor_updated_at, cursor_id = decode_conversation_cursor(cursor)
        cursor_clause = "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)"
        params["cursor_updated_at"] = cursor_updated_at
        params["cursor_id"] = cursor_id

    scope_filter = ""
    if scope == "shared":
        scope_filter = "AND c.owner_user_id != :viewer_id"

    cte = _build_visibility_cte(viewer_id)

    result = db.execute(
        text(f"""
            WITH {cte}
            SELECT c.id, c.owner_user_id, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
            FROM conversations c
            JOIN visible_conversations vc ON vc.id = c.id
            WHERE true
              {scope_filter}
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    )

    return _build_conversation_page(result.fetchall(), limit, viewer_id)


def _build_conversation_page(
    rows: list, limit: int, viewer_id: UUID
) -> tuple[list[ConversationOut], PageInfo]:
    """Build paginated response from raw rows."""
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    conversations = [
        ConversationOut(
            id=row[0],
            owner_user_id=row[1],
            is_owner=(row[1] == viewer_id),
            sharing=row[2],
            created_at=row[3],
            updated_at=row[4],
            message_count=row[5],
        )
        for row in rows
    ]

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
    # Verify ownership (write = owner-only)
    get_conversation_for_owner_write_or_404(db, viewer_id, conversation_id)

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
    # Verify read visibility (shared readers can list messages too)
    get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)

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
