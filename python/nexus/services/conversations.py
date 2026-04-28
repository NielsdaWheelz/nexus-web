"""Conversation and Message service layer.

Read visibility: shared read allowed via canonical visibility predicate
(owner, public, or library-shared with active dual membership per S4 spec §5.3).
Write boundary: owner-only for all mutation operations.

Error masking: E_CONVERSATION_NOT_FOUND / E_MESSAGE_NOT_FOUND consistently (prevent probing).
Pagination: cursor-based, ordered by updated_at DESC, id DESC.

Helper split (S4):
- get_conversation_for_visible_read_or_404: read path (visibility predicate)
- get_conversation_for_owner_write_or_404: write path (owner-only)

Service functions correspond 1:1 with route handlers.
Routes are transport-only and call exactly one service function.
"""

import base64
import json
from collections.abc import Sequence
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session, joinedload

from nexus.auth.permissions import can_read_conversation, can_read_media, is_library_member
from nexus.db.models import (
    Annotation,
    Conversation,
    Highlight,
    HighlightFragmentAnchor,
    Library,
    Media,
    Message,
    MessageContext,
    MessageToolCall,
)
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    HIGHLIGHT_COLORS,
    ConversationOut,
    ConversationScopeOut,
    ConversationScopeRequest,
    MessageContextSnapshot,
    MessageOut,
    MessageToolCallOut,
    PageInfo,
)

logger = get_logger(__name__)


def _message_context_color(color: str | None) -> HIGHLIGHT_COLORS | None:
    if color not in {"yellow", "green", "blue", "pink", "purple"}:
        return None
    return cast(HIGHLIGHT_COLORS, color)


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
    db: Session,
    conversation: Conversation,
    message_count: int,
    viewer_id: UUID | None = None,
) -> ConversationOut:
    """Convert Conversation ORM model to ConversationOut schema.

    Args:
        conversation: The ORM conversation.
        message_count: Pre-computed message count.
        viewer_id: The viewing user. Used to compute is_owner.
    """
    return ConversationOut(
        id=conversation.id,
        title=conversation.title,
        owner_user_id=conversation.owner_user_id,
        is_owner=(viewer_id is not None and conversation.owner_user_id == viewer_id),
        sharing=conversation.sharing,
        scope=conversation_scope_to_out(db, conversation),
        message_count=message_count,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
    )


def conversation_scope_to_out(db: Session, conversation: Conversation) -> ConversationScopeOut:
    if conversation.scope_type == "general":
        return ConversationScopeOut(type="general")

    if conversation.scope_type == "media":
        media = db.get(Media, conversation.scope_media_id) if conversation.scope_media_id else None
        if media is None:
            return ConversationScopeOut(type="media", media_id=conversation.scope_media_id)
        authors = [author.name for author in media.authors]
        return ConversationScopeOut(
            type="media",
            media_id=media.id,
            title=media.title,
            media_kind=media.kind,
            authors=authors,
            published_date=media.published_date,
            publisher=media.publisher,
            canonical_source_url=media.canonical_source_url,
        )

    if conversation.scope_type == "library":
        library = (
            db.get(Library, conversation.scope_library_id)
            if conversation.scope_library_id
            else None
        )
        if library is None:
            return ConversationScopeOut(type="library", library_id=conversation.scope_library_id)
        rows = db.execute(
            text(
                """
                SELECT COUNT(le.media_id), array_remove(array_agg(DISTINCT m.kind), NULL)
                FROM library_entries le
                LEFT JOIN media m ON m.id = le.media_id
                WHERE le.library_id = :library_id
                """
            ),
            {"library_id": library.id},
        ).one()
        return ConversationScopeOut(
            type="library",
            library_id=library.id,
            title=library.name,
            library_name=library.name,
            entry_count=int(rows[0] or 0),
            media_kinds=list(rows[1] or []),
            source_policy="library_membership",
        )

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def conversation_scope_metadata(db: Session, conversation: Conversation) -> dict[str, object]:
    scope = conversation_scope_to_out(db, conversation)
    return scope.model_dump(mode="json")


def authorize_conversation_scope(
    db: Session,
    viewer_id: UUID,
    conversation_scope: ConversationScopeRequest,
) -> None:
    if conversation_scope.type == "general":
        return

    if conversation_scope.type == "media":
        media_id = conversation_scope.media_id
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
        return

    if conversation_scope.type == "library":
        library_id = conversation_scope.library_id
        if library_id is None or not is_library_member(db, viewer_id, library_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library not found")
        return

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def _lock_scoped_conversation(
    db: Session, viewer_id: UUID, scope_type: str, scope_id: UUID
) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"conversation_scope:{viewer_id}:{scope_type}:{scope_id}"},
    )


def resolve_conversation_for_scope(
    db: Session,
    viewer_id: UUID,
    conversation_scope: ConversationScopeRequest,
    title_content: str | None = None,
) -> Conversation:
    authorize_conversation_scope(db, viewer_id, conversation_scope)

    if conversation_scope.type == "general":
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=derive_conversation_title(title_content),
            sharing="private",
            scope_type="general",
            scope_media_id=None,
            scope_library_id=None,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        return conversation

    if conversation_scope.type == "media":
        media = db.get(Media, conversation_scope.media_id) if conversation_scope.media_id else None
        if conversation_scope.media_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Media scope requires media_id"
            )
        _lock_scoped_conversation(db, viewer_id, "media", conversation_scope.media_id)
        conversation = (
            db.execute(
                select(Conversation).where(
                    Conversation.owner_user_id == viewer_id,
                    Conversation.scope_type == "media",
                    Conversation.scope_media_id == conversation_scope.media_id,
                )
            )
            .scalars()
            .first()
        )
        if conversation is not None:
            return conversation
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=media.title if media is not None else DEFAULT_CONVERSATION_TITLE,
            sharing="private",
            scope_type="media",
            scope_media_id=conversation_scope.media_id,
            scope_library_id=None,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        return conversation

    if conversation_scope.type == "library":
        if conversation_scope.library_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Library scope requires library_id",
            )
        library = db.get(Library, conversation_scope.library_id)
        _lock_scoped_conversation(db, viewer_id, "library", conversation_scope.library_id)
        conversation = (
            db.execute(
                select(Conversation).where(
                    Conversation.owner_user_id == viewer_id,
                    Conversation.scope_type == "library",
                    Conversation.scope_library_id == conversation_scope.library_id,
                )
            )
            .scalars()
            .first()
        )
        if conversation is not None:
            return conversation
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=library.name if library is not None else DEFAULT_CONVERSATION_TITLE,
            sharing="private",
            scope_type="library",
            scope_media_id=None,
            scope_library_id=conversation_scope.library_id,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        return conversation

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def message_to_out(
    message: Message,
    contexts: list[MessageContextSnapshot] | None = None,
    tool_calls: list[MessageToolCallOut] | None = None,
) -> MessageOut:
    """Convert Message ORM model to MessageOut schema."""
    return MessageOut(
        id=message.id,
        seq=message.seq,
        role=message.role,
        content=message.content,
        contexts=contexts or [],
        tool_calls=tool_calls or [],
        status=message.status,
        error_code=message.error_code,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def _resolve_context_highlight_media_id(highlight: Highlight) -> UUID | None:
    """Return the canonical media id for a typed highlight context."""

    media_id = highlight.anchor_media_id
    if media_id is None:
        return None

    if highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = highlight.fragment_anchor
        fragment = fragment_anchor.fragment if fragment_anchor is not None else None
        if fragment is not None and fragment.media_id == media_id:
            return media_id
        return None

    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = highlight.pdf_anchor
        if pdf_anchor is not None and pdf_anchor.media_id == media_id:
            return media_id
        return None

    return None


def _message_context_snapshot_from_media(
    context_id: UUID,
    media: Media | None,
) -> MessageContextSnapshot:
    if media is None:
        return MessageContextSnapshot(type="media", id=context_id)

    return MessageContextSnapshot(
        type="media",
        id=context_id,
        preview=media.title,
        media_id=media.id,
        media_title=media.title,
        media_kind=media.kind,
    )


def _message_context_snapshot_from_highlight(
    context_id: UUID,
    highlight: Highlight | None,
    media_by_id: dict[UUID, Media],
) -> MessageContextSnapshot:
    if highlight is None:
        return MessageContextSnapshot(type="highlight", id=context_id)

    media_id = _resolve_context_highlight_media_id(highlight)
    media = media_by_id.get(media_id) if media_id is not None else None
    return MessageContextSnapshot(
        type="highlight",
        id=context_id,
        color=_message_context_color(highlight.color),
        preview=highlight.exact,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        annotation_body=highlight.annotation.body if highlight.annotation is not None else None,
        media_id=media.id if media is not None else media_id,
        media_title=media.title if media is not None else None,
        media_kind=media.kind if media is not None else None,
    )


def _message_context_snapshot_from_annotation(
    context_id: UUID,
    annotation: Annotation | None,
    media_by_id: dict[UUID, Media],
) -> MessageContextSnapshot:
    if annotation is None:
        return MessageContextSnapshot(type="annotation", id=context_id)

    highlight = annotation.highlight
    if highlight is None:
        return MessageContextSnapshot(
            type="annotation",
            id=context_id,
            annotation_body=annotation.body,
        )

    media_id = _resolve_context_highlight_media_id(highlight)
    media = media_by_id.get(media_id) if media_id is not None else None
    return MessageContextSnapshot(
        type="annotation",
        id=context_id,
        color=_message_context_color(highlight.color),
        preview=highlight.exact,
        exact=highlight.exact,
        prefix=highlight.prefix,
        suffix=highlight.suffix,
        annotation_body=annotation.body,
        media_id=media.id if media is not None else media_id,
        media_title=media.title if media is not None else None,
        media_kind=media.kind if media is not None else None,
    )


def load_message_context_snapshots_for_message_ids(
    db: Session,
    message_ids: list[UUID],
) -> dict[UUID, list[MessageContextSnapshot]]:
    """Load typed context snapshots for the given messages."""

    if not message_ids:
        return {}

    context_rows = list(
        db.scalars(
            select(MessageContext)
            .options(
                joinedload(MessageContext.media),
                joinedload(MessageContext.highlight).joinedload(Highlight.annotation),
                joinedload(MessageContext.highlight)
                .joinedload(Highlight.fragment_anchor)
                .joinedload(HighlightFragmentAnchor.fragment),
                joinedload(MessageContext.highlight).joinedload(Highlight.pdf_anchor),
                joinedload(MessageContext.annotation)
                .joinedload(Annotation.highlight)
                .joinedload(Highlight.annotation),
                joinedload(MessageContext.annotation)
                .joinedload(Annotation.highlight)
                .joinedload(Highlight.fragment_anchor)
                .joinedload(HighlightFragmentAnchor.fragment),
                joinedload(MessageContext.annotation)
                .joinedload(Annotation.highlight)
                .joinedload(Highlight.pdf_anchor),
            )
            .where(MessageContext.message_id.in_(message_ids))
            .order_by(MessageContext.message_id.asc(), MessageContext.ordinal.asc())
        )
    )

    media_ids: set[UUID] = set()
    for context_row in context_rows:
        if context_row.media is not None:
            media_ids.add(context_row.media.id)

        highlight = context_row.highlight
        if highlight is not None:
            media_id = _resolve_context_highlight_media_id(highlight)
            if media_id is not None:
                media_ids.add(media_id)

        annotation = context_row.annotation
        annotation_highlight = annotation.highlight if annotation is not None else None
        if annotation_highlight is not None:
            media_id = _resolve_context_highlight_media_id(annotation_highlight)
            if media_id is not None:
                media_ids.add(media_id)

    media_by_id = {
        media.id: media for media in db.scalars(select(Media).where(Media.id.in_(media_ids))).all()
    }

    snapshots_by_message_id: dict[UUID, list[MessageContextSnapshot]] = {
        message_id: [] for message_id in message_ids
    }
    for context_row in context_rows:
        if context_row.target_type == "media":
            if context_row.media_id is None:
                continue
            snapshot = _message_context_snapshot_from_media(context_row.media_id, context_row.media)
        elif context_row.target_type == "highlight":
            if context_row.highlight_id is None:
                continue
            snapshot = _message_context_snapshot_from_highlight(
                context_row.highlight_id,
                context_row.highlight,
                media_by_id,
            )
        elif context_row.target_type == "annotation":
            if context_row.annotation_id is None:
                continue
            snapshot = _message_context_snapshot_from_annotation(
                context_row.annotation_id,
                context_row.annotation,
                media_by_id,
            )
        else:
            continue
        snapshots_by_message_id.setdefault(context_row.message_id, []).append(snapshot)

    return snapshots_by_message_id


def load_message_tool_calls_for_message_ids(
    db: Session,
    message_ids: list[UUID],
) -> dict[UUID, list[MessageToolCallOut]]:
    """Load persisted assistant tool calls for the given messages."""

    if not message_ids:
        return {}

    rows = (
        db.scalars(
            select(MessageToolCall)
            .options(joinedload(MessageToolCall.retrievals))
            .where(MessageToolCall.assistant_message_id.in_(message_ids))
            .order_by(
                MessageToolCall.assistant_message_id.asc(),
                MessageToolCall.tool_call_index.asc(),
            )
        )
        .unique()
        .all()
    )

    tool_calls_by_message_id: dict[UUID, list[MessageToolCallOut]] = {
        message_id: [] for message_id in message_ids
    }
    for row in rows:
        tool_calls_by_message_id.setdefault(row.assistant_message_id, []).append(
            MessageToolCallOut.model_validate(row, from_attributes=True)
        )
    return tool_calls_by_message_id


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
        title=DEFAULT_CONVERSATION_TITLE,
        sharing="private",
        scope_type="general",
        next_seq=1,
    )

    db.add(conversation)
    db.flush()
    db.commit()

    return conversation_to_out(db, conversation, message_count=0, viewer_id=viewer_id)


def resolve_conversation(
    db: Session,
    viewer_id: UUID,
    conversation_scope: ConversationScopeRequest,
) -> ConversationOut:
    conversation = resolve_conversation_for_scope(db, viewer_id, conversation_scope)
    db.commit()
    return conversation_to_out(
        db,
        conversation,
        get_message_count(db, conversation.id),
        viewer_id=viewer_id,
    )


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

    cursor_clause = ""
    if cursor:
        cursor_updated_at, cursor_id = decode_conversation_cursor(cursor)
        cursor_clause = "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)"
        params["cursor_updated_at"] = cursor_updated_at
        params["cursor_id"] = cursor_id

    result = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
                   c.scope_type, c.scope_media_id, c.scope_library_id,
                   sm.title AS scope_media_title, sm.kind AS scope_media_kind,
                   sl.name AS scope_library_name
            FROM conversations c
            LEFT JOIN media sm ON sm.id = c.scope_media_id
            LEFT JOIN libraries sl ON sl.id = c.scope_library_id
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
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
                   c.scope_type, c.scope_media_id, c.scope_library_id,
                   sm.title AS scope_media_title, sm.kind AS scope_media_kind,
                   sl.name AS scope_library_name
            FROM conversations c
            JOIN visible_conversations vc ON vc.id = c.id
            LEFT JOIN media sm ON sm.id = c.scope_media_id
            LEFT JOIN libraries sl ON sl.id = c.scope_library_id
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
    """Build paginated response from raw rows."""
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
            scope=_conversation_scope_out_from_row(row),
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


def _conversation_scope_out_from_row(row: Sequence) -> ConversationScopeOut:
    scope_type = row[7]
    if scope_type == "general":
        return ConversationScopeOut(type="general")
    if scope_type == "media":
        return ConversationScopeOut(
            type="media",
            media_id=row[8],
            title=row[10],
            media_kind=row[11],
        )
    if scope_type == "library":
        return ConversationScopeOut(
            type="library",
            library_id=row[9],
            title=row[12],
            library_name=row[12],
            source_policy="library_membership",
        )
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")


def delete_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    """Delete a conversation.

    Cascades to messages, message_context, conversation_media, conversation_shares,
    chat runs, and chat run events.

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

    message_ids = [row[0] for row in rows]
    contexts_by_message_id = load_message_context_snapshots_for_message_ids(db, message_ids)
    tool_calls_by_message_id = load_message_tool_calls_for_message_ids(db, message_ids)
    messages = [
        MessageOut(
            id=row[0],
            seq=row[1],
            role=row[2],
            content=row[3],
            contexts=contexts_by_message_id.get(row[0], []),
            tool_calls=tool_calls_by_message_id.get(row[0], []),
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
