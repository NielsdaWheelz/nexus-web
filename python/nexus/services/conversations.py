"""Conversation and Message service layer.

Read visibility: shared read allowed via canonical visibility predicate
(owner, public, or library-shared with active dual membership).
Write boundary: owner-only for all mutation operations.

Error masking: E_CONVERSATION_NOT_FOUND / E_MESSAGE_NOT_FOUND consistently (prevent probing).
Pagination: cursor-based, ordered by updated_at DESC, id DESC.

Conversation access helpers:
- get_conversation_for_visible_read_or_404: read path (visibility predicate)
- get_conversation_for_owner_write_or_404: write path (owner-only)

Service functions correspond 1:1 with route handlers.
Routes are transport-only and call exactly one service function.
"""

import base64
import json
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import (
    ChatRun,
    Conversation,
    Message,
    MessageRerankLedger,
    MessageRetrieval,
    MessageRetrievalCandidateLedger,
    MessageToolCall,
)
from nexus.errors import (
    CHAT_RESPONSE_RETRYABLE_ERROR_CODES,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    BRANCH_ANCHOR_KINDS,
    ConversationOut,
    MessageDocument,
    MessageOut,
    MessageRerankLedgerOut,
    MessageRetrievalCandidateLedgerOut,
    PageInfo,
)

logger = get_logger(__name__)


# =============================================================================
# Constants
# =============================================================================

# Pagination limits
DEFAULT_LIMIT = 50
MIN_LIMIT = 1
MAX_LIMIT = 100
DEFAULT_CONVERSATION_TITLE = "Chat"
MAX_CONVERSATION_TITLE_LENGTH = 120


# =============================================================================
# Cursor Encoding/Decoding
# =============================================================================


def _encode_cursor(payload: dict[str, object]) -> str:
    """Encode a cursor payload as base64url without padding."""
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def _decode_cursor[T](cursor: str, extract: Callable[[dict[str, Any]], T]) -> T:
    """Decode a base64url cursor and project it with `extract`.

    Raises InvalidRequestError on any decode/projection failure.
    """
    try:
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding
        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))
        return extract(payload)
    except (ValueError, KeyError, TypeError):
        # justify-ignore-error: expected malformed-cursor failures from the
        # base64url/JSON decode path and from `extract` parsing primitive
        # fields (int/UUID/datetime). Other exceptions propagate.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


def encode_conversation_cursor(updated_at: datetime, id: UUID) -> str:
    return _encode_cursor({"updated_at": updated_at.isoformat(), "id": str(id)})


def decode_conversation_cursor(cursor: str) -> tuple[datetime, UUID]:
    return _decode_cursor(
        cursor, lambda p: (datetime.fromisoformat(p["updated_at"]), UUID(p["id"]))
    )


def encode_message_cursor(seq: int, id: UUID) -> str:
    return _encode_cursor({"seq": seq, "id": str(id)})


def decode_message_cursor(cursor: str) -> tuple[int, UUID]:
    return _decode_cursor(cursor, lambda p: (int(p["seq"]), UUID(p["id"])))


def _conversation_cursor_clause(cursor: str | None) -> tuple[str, dict[str, object]]:
    """SQL fragment + bound params for conversation pagination, or empty when no cursor."""
    if not cursor:
        return "", {}
    updated_at, conversation_id = decode_conversation_cursor(cursor)
    return (
        "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)",
        {"cursor_updated_at": updated_at, "cursor_id": conversation_id},
    )


# =============================================================================
# Helper Functions
# =============================================================================


def clamp_limit(limit: int) -> int:
    """Clamp limit to valid range [MIN_LIMIT, MAX_LIMIT]."""
    return min(max(limit, MIN_LIMIT), MAX_LIMIT)


def derive_conversation_title(content: str | None) -> str:
    """Derive a conversation title from user content.

    Empty or whitespace-only input falls back to the default title.
    """
    if content is None:
        return DEFAULT_CONVERSATION_TITLE
    normalized = " ".join(content.split()).strip()
    if not normalized:
        return DEFAULT_CONVERSATION_TITLE
    return normalized[:MAX_CONVERSATION_TITLE_LENGTH].rstrip()


def get_conversation_for_visible_read_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    """Load conversation and verify canonical read visibility.

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
    db: Session,
    conversation: Conversation,
    message_count: int,
    viewer_id: UUID | None = None,
) -> ConversationOut:
    """Convert Conversation ORM model to ConversationOut schema."""
    return ConversationOut(
        id=conversation.id,
        title=conversation.title,
        owner_user_id=conversation.owner_user_id,
        is_owner=(viewer_id is not None and conversation.owner_user_id == viewer_id),
        sharing=conversation.sharing,
        message_count=message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def message_to_out(
    message: Message,
    can_retry_response: bool = False,
) -> MessageOut:
    """Convert Message ORM model to MessageOut schema."""
    branch_anchor = {"kind": message.branch_anchor_kind, **(message.branch_anchor or {})}
    return MessageOut(
        id=message.id,
        seq=message.seq,
        role=message.role,
        message_document=MessageDocument.model_validate(message.message_document),
        parent_message_id=message.parent_message_id,
        branch_root_message_id=message.branch_root_message_id,
        branch_anchor_kind=cast(BRANCH_ANCHOR_KINDS, message.branch_anchor_kind),
        branch_anchor=branch_anchor,
        status=message.status,
        error_code=message.error_code,
        can_retry_response=can_retry_response,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def retryable_assistant_message_ids(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
) -> set[UUID]:
    if not assistant_message_ids:
        return set()

    rows = db.scalars(
        select(ChatRun.assistant_message_id)
        .join(Message, Message.id == ChatRun.assistant_message_id)
        .where(
            ChatRun.owner_user_id == viewer_id,
            ChatRun.assistant_message_id.in_(assistant_message_ids),
            ChatRun.status == "error",
            ChatRun.error_code.in_(CHAT_RESPONSE_RETRYABLE_ERROR_CODES),
            Message.role == "assistant",
            Message.status == "error",
        )
    )
    return set(rows)


# =============================================================================
# Service Functions
# =============================================================================


def create_conversation(db: Session, viewer_id: UUID) -> ConversationOut:
    """Create a new empty private conversation.

    The caller commits the surrounding transaction. This lets callers compose
    creation with additional inserts inside a single SERIALIZABLE transaction.

    Args:
        db: Database session.
        viewer_id: The ID of the user creating the conversation.

    Returns:
        The created conversation with message_count=0.
    """
    conversation = Conversation(
        owner_user_id=viewer_id,
        title=DEFAULT_CONVERSATION_TITLE,
        sharing="private",
        next_seq=1,
    )

    db.add(conversation)
    db.flush()

    return conversation_to_out(db, conversation, message_count=0, viewer_id=viewer_id)


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
    return conversation_to_out(db, conversation, message_count, viewer_id=viewer_id)


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
    cursor_clause, cursor_params = _conversation_cursor_clause(cursor)
    params.update(cursor_params)

    result = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
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
    cursor_clause, cursor_params = _conversation_cursor_clause(cursor)
    params.update(cursor_params)

    scope_filter = ""
    if scope == "shared":
        scope_filter = "AND c.owner_user_id != :viewer_id"

    cte = _build_visibility_cte(viewer_id)

    result = db.execute(
        text(f"""
            WITH {cte}
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
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
    rows: Sequence, limit: int, viewer_id: UUID
) -> tuple[list[ConversationOut], PageInfo]:
    """Build paginated response from raw rows.

    Row columns (in order): id, owner_user_id, title, sharing, created_at,
    updated_at, message_count.
    """
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    conversations = [
        ConversationOut(
            id=row[0],
            owner_user_id=row[1],
            title=row[2],
            is_owner=(row[1] == viewer_id),
            sharing=row[3],
            created_at=row[4],
            updated_at=row[5],
            message_count=row[6],
        )
        for row in rows
    ]

    next_cursor = None
    if has_more and conversations:
        last = conversations[-1]
        next_cursor = encode_conversation_cursor(last.updated_at, last.id)

    return conversations, PageInfo(next_cursor=next_cursor)


def delete_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    """Delete a conversation and its owned rows.

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

    delete_conversation_rows_without_commit(db, conversation_id)
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

    rows = _selected_path_message_rows(db, viewer_id, conversation_id)
    if cursor:
        cursor_seq, cursor_id = decode_message_cursor(cursor)
        rows = [row for row in rows if (row[1], row[0]) > (cursor_seq, cursor_id)]

    # Check if there are more results
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    message_ids = [row[0] for row in rows]
    retryable_message_ids = retryable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=message_ids,
    )
    messages = [
        MessageOut(
            id=row[0],
            seq=row[1],
            role=row[2],
            message_document=MessageDocument.model_validate(row[12]),
            parent_message_id=row[8],
            branch_root_message_id=row[9],
            branch_anchor_kind=row[10],
            branch_anchor={"kind": row[10], **(row[11] or {})},
            status=row[4],
            error_code=row[5],
            can_retry_response=row[0] in retryable_message_ids,
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


def _get_message_for_visible_read_or_404(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
) -> Message:
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    try:
        get_conversation_for_visible_read_or_404(db, viewer_id, message.conversation_id)
    except NotFoundError:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found") from None
    return message


def list_message_retrieval_candidate_ledgers(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
    tool_call_id: UUID | None = None,
) -> list[MessageRetrievalCandidateLedgerOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    stmt = (
        select(
            MessageRetrievalCandidateLedger,
            MessageRetrieval.included_in_prompt,
        )
        .join(
            MessageToolCall,
            MessageToolCall.id == MessageRetrievalCandidateLedger.tool_call_id,
        )
        .outerjoin(
            MessageRetrieval,
            MessageRetrieval.id == MessageRetrievalCandidateLedger.retrieval_id,
        )
        .where(MessageToolCall.assistant_message_id == message_id)
        .order_by(
            MessageToolCall.tool_call_index.asc(),
            MessageRetrievalCandidateLedger.ordinal.asc(),
            MessageRetrievalCandidateLedger.id.asc(),
        )
    )
    if tool_call_id is not None:
        stmt = stmt.where(MessageRetrievalCandidateLedger.tool_call_id == tool_call_id)

    rows = db.execute(stmt).all()
    return [
        _retrieval_candidate_ledger_to_out(row, linked_retrieval_included_in_prompt)
        for row, linked_retrieval_included_in_prompt in rows
    ]


def _retrieval_candidate_ledger_to_out(
    row: MessageRetrievalCandidateLedger,
    linked_retrieval_included_in_prompt: bool | None,
) -> MessageRetrievalCandidateLedgerOut:
    if linked_retrieval_included_in_prompt is None:
        included_in_prompt = row.included_in_prompt
        included_in_prompt_source = "candidate_ledger"
        included_in_prompt_reconciled = True
    else:
        included_in_prompt = linked_retrieval_included_in_prompt
        included_in_prompt_source = "linked_retrieval"
        included_in_prompt_reconciled = (
            row.included_in_prompt == linked_retrieval_included_in_prompt
        )

    return MessageRetrievalCandidateLedgerOut(
        id=row.id,
        tool_call_id=row.tool_call_id,
        retrieval_id=row.retrieval_id,
        ordinal=row.ordinal,
        result_type=cast(Any, row.result_type),
        source_id=row.source_id,
        score=row.score,
        selected=row.selected,
        included_in_prompt=included_in_prompt,
        ledger_included_in_prompt=row.included_in_prompt,
        linked_retrieval_included_in_prompt=linked_retrieval_included_in_prompt,
        included_in_prompt_source=cast(Any, included_in_prompt_source),
        included_in_prompt_reconciled=included_in_prompt_reconciled,
        selection_status=row.selection_status,
        selection_reason=row.selection_reason,
        result_ref=cast(Any, row.result_ref),
        locator=cast(Any, row.locator),
        source_version=row.source_version,
        created_at=row.created_at,
    )


def list_message_rerank_ledgers(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
    tool_call_id: UUID | None = None,
) -> list[MessageRerankLedgerOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    stmt = (
        select(MessageRerankLedger)
        .join(MessageToolCall, MessageToolCall.id == MessageRerankLedger.tool_call_id)
        .where(MessageToolCall.assistant_message_id == message_id)
        .order_by(
            MessageToolCall.tool_call_index.asc(),
            MessageRerankLedger.created_at.asc(),
            MessageRerankLedger.id.asc(),
        )
    )
    if tool_call_id is not None:
        stmt = stmt.where(MessageRerankLedger.tool_call_id == tool_call_id)

    rows = db.scalars(stmt).all()
    return [
        MessageRerankLedgerOut(
            id=row.id,
            tool_call_id=row.tool_call_id,
            strategy=row.strategy,
            input_count=row.input_count,
            selected_count=row.selected_count,
            budget_chars=row.budget_chars,
            selected_chars=row.selected_chars,
            status=row.status,
            metadata=row.metadata_,
            created_at=row.created_at,
        )
        for row in rows
    ]


def _selected_path_message_rows(db: Session, viewer_id: UUID, conversation_id: UUID) -> list:
    active_leaf_id = db.scalar(
        text(
            """
            SELECT cap.active_leaf_message_id
            FROM conversation_active_paths cap
            JOIN messages active_message ON active_message.id = cap.active_leaf_message_id
            WHERE cap.conversation_id = :conversation_id
              AND cap.viewer_user_id = :viewer_id
              AND active_message.conversation_id = :conversation_id
            """
        ),
        {"conversation_id": conversation_id, "viewer_id": viewer_id},
    )
    if active_leaf_id is None:
        active_leaf_id = db.scalar(
            select(Message.id)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq.desc(), Message.id.desc())
            .limit(1)
        )
    if active_leaf_id is None:
        return []

    return list(
        db.execute(
            text(
                """
                WITH RECURSIVE path AS (
                    SELECT id, parent_message_id
                    FROM messages
                    WHERE conversation_id = :conversation_id
                      AND id = :active_leaf_id
                    UNION ALL
                    SELECT parent.id, parent.parent_message_id
                    FROM messages parent
                    JOIN path child ON child.parent_message_id = parent.id
                    WHERE parent.conversation_id = :conversation_id
                )
                SELECT m.id, m.seq, m.role, m.content, m.status, m.error_code,
                       m.created_at, m.updated_at, m.parent_message_id,
                       m.branch_root_message_id, m.branch_anchor_kind, m.branch_anchor,
                       m.message_document
                FROM messages m
                JOIN path ON path.id = m.id
                ORDER BY m.seq ASC, m.id ASC
                """
            ),
            {"conversation_id": conversation_id, "active_leaf_id": active_leaf_id},
        ).fetchall()
    )


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

    message_ids = _message_subtree_ids(db, conversation_id, message_id)
    delete_message_rows_without_commit(db, message_ids)
    db.flush()

    # Check remaining message count in same transaction
    remaining = db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id)
    )

    # If no messages remain, delete conversation
    if remaining == 0:
        delete_conversation_rows_without_commit(db, conversation_id)
        db.flush()

    db.commit()


def delete_conversation_rows_without_commit(db: Session, conversation_id: UUID) -> None:
    message_ids = _message_ids_for_conversation(db, conversation_id)
    delete_message_rows_without_commit(db, message_ids)

    db.execute(
        text("""
            DELETE FROM object_links
            WHERE (a_type = 'conversation' AND a_id = :conversation_id)
               OR (b_type = 'conversation' AND b_id = :conversation_id)
        """),
        {"conversation_id": conversation_id},
    )

    db.execute(
        text("DELETE FROM conversation_state_snapshots WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_active_paths WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_branches WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_media WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_shares WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_references WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(delete(Conversation).where(Conversation.id == conversation_id))
    db.flush()


def delete_message_rows_without_commit(db: Session, message_ids: Sequence[UUID]) -> None:
    if not message_ids:
        return

    db.execute(
        text("""
            DELETE FROM conversation_active_paths
            WHERE active_leaf_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM conversation_branches
            WHERE branch_user_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )

    chat_run_ids = _chat_run_ids_for_messages(db, message_ids)
    if chat_run_ids:
        db.execute(
            text("DELETE FROM chat_run_events WHERE run_id = ANY(:chat_run_ids)"),
            {"chat_run_ids": chat_run_ids},
        )

    db.execute(
        text("""
            DELETE FROM chat_prompt_assemblies
            WHERE assistant_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )

    tool_call_ids = _message_tool_call_ids_for_messages(db, message_ids)
    if tool_call_ids:
        db.execute(
            text("""
                DELETE FROM message_retrieval_candidate_ledgers
                WHERE tool_call_id = ANY(:tool_call_ids)
            """),
            {"tool_call_ids": tool_call_ids},
        )
        db.execute(
            text("""
                DELETE FROM message_rerank_ledgers
                WHERE tool_call_id = ANY(:tool_call_ids)
            """),
            {"tool_call_ids": tool_call_ids},
        )
        db.execute(
            text("DELETE FROM message_retrievals WHERE tool_call_id = ANY(:tool_call_ids)"),
            {"tool_call_ids": tool_call_ids},
        )
        db.execute(
            text("DELETE FROM message_tool_calls WHERE id = ANY(:tool_call_ids)"),
            {"tool_call_ids": tool_call_ids},
        )

    if chat_run_ids:
        db.execute(
            text("DELETE FROM chat_runs WHERE id = ANY(:chat_run_ids)"),
            {"chat_run_ids": chat_run_ids},
        )

    db.execute(
        text("""
            DELETE FROM object_links
            WHERE (a_type = 'message' AND a_id = ANY(:message_ids))
               OR (b_type = 'message' AND b_id = ANY(:message_ids))
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("DELETE FROM message_llm WHERE message_id = ANY(:message_ids)"),
        {"message_ids": list(message_ids)},
    )
    db.execute(delete(Message).where(Message.id.in_(message_ids)))
    db.flush()


def _message_ids_for_conversation(db: Session, conversation_id: UUID) -> list[UUID]:
    return list(
        db.scalars(
            select(Message.id)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.seq.asc(), Message.id.asc())
        )
    )


def _query_uuid_ids(db: Session, sql: str, params: dict[str, object]) -> list[UUID]:
    """Execute a SELECT id query and return the IDs as a list."""
    rows = db.execute(text(sql), params)
    return [row[0] for row in rows]


def _message_subtree_ids(db: Session, conversation_id: UUID, message_id: UUID) -> list[UUID]:
    return _query_uuid_ids(
        db,
        """
        WITH RECURSIVE subtree AS (
            SELECT id
            FROM messages
            WHERE conversation_id = :conversation_id
              AND id = :message_id
            UNION ALL
            SELECT child.id
            FROM messages child
            JOIN subtree parent ON parent.id = child.parent_message_id
            WHERE child.conversation_id = :conversation_id
        )
        SELECT id FROM subtree
        """,
        {"conversation_id": conversation_id, "message_id": message_id},
    )


def _chat_run_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    return _query_uuid_ids(
        db,
        """
        SELECT id
        FROM chat_runs
        WHERE user_message_id = ANY(:message_ids)
           OR assistant_message_id = ANY(:message_ids)
        ORDER BY created_at ASC, id ASC
        """,
        {"message_ids": list(message_ids)},
    )


def _message_tool_call_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    return _query_uuid_ids(
        db,
        """
        SELECT id
        FROM message_tool_calls
        WHERE user_message_id = ANY(:message_ids)
           OR assistant_message_id = ANY(:message_ids)
        ORDER BY tool_call_index ASC, id ASC
        """,
        {"message_ids": list(message_ids)},
    )


