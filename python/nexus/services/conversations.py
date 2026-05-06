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
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session, joinedload

from nexus.auth.permissions import can_read_conversation, can_read_media, is_library_member
from nexus.db.models import (
    AssistantMessageClaim,
    AssistantMessageEvidenceSummary,
    Conversation,
    Library,
    Media,
    Message,
    MessageContextItem,
    MessageToolCall,
)
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    BRANCH_ANCHOR_KINDS,
    HIGHLIGHT_COLORS,
    MESSAGE_CONTEXT_TYPES,
    ConversationOut,
    ConversationScopeOut,
    ConversationScopeRequest,
    MessageClaimEvidenceOut,
    MessageClaimOut,
    MessageContextSnapshot,
    MessageEvidenceSummaryOut,
    MessageOut,
    MessageToolCallOut,
    PageInfo,
)
from nexus.services.contributor_credits import load_contributor_credits_for_media
from nexus.services.conversation_memory import conversation_memory_inspection

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
        memory=conversation_memory_inspection(db, conversation_id=conversation.id),
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
        contributors = load_contributor_credits_for_media(db, [media.id]).get(media.id, [])
        return ConversationScopeOut(
            type="media",
            media_id=media.id,
            title=media.title,
            media_kind=media.kind,
            contributors=contributors,
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
    evidence_summary: MessageEvidenceSummaryOut | None = None,
    claims: list[MessageClaimOut] | None = None,
    claim_evidence: list[MessageClaimEvidenceOut] | None = None,
) -> MessageOut:
    """Convert Message ORM model to MessageOut schema."""
    branch_anchor = {"kind": message.branch_anchor_kind, **(message.branch_anchor or {})}
    return MessageOut(
        id=message.id,
        seq=message.seq,
        role=message.role,
        content=message.content,
        parent_message_id=message.parent_message_id,
        branch_root_message_id=message.branch_root_message_id,
        branch_anchor_kind=cast(BRANCH_ANCHOR_KINDS, message.branch_anchor_kind),
        branch_anchor=branch_anchor,
        contexts=contexts or [],
        tool_calls=tool_calls or [],
        evidence_summary=evidence_summary,
        claims=claims or [],
        claim_evidence=claim_evidence or [],
        status=message.status,
        error_code=message.error_code,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def load_message_context_snapshots_for_message_ids(
    db: Session,
    message_ids: list[UUID],
) -> dict[UUID, list[MessageContextSnapshot]]:
    """Load typed context snapshots for the given messages."""

    if not message_ids:
        return {}

    snapshots_by_message_id: dict[UUID, list[MessageContextSnapshot]] = {
        message_id: [] for message_id in message_ids
    }
    context_rows = db.scalars(
        select(MessageContextItem)
        .where(MessageContextItem.message_id.in_(message_ids))
        .order_by(MessageContextItem.message_id.asc(), MessageContextItem.ordinal.asc())
    ).all()
    for row in context_rows:
        stored = row.context_snapshot_json if isinstance(row.context_snapshot_json, Mapping) else {}
        if row.context_kind == "reader_selection":
            snapshots_by_message_id.setdefault(row.message_id, []).append(
                MessageContextSnapshot(
                    kind="reader_selection",
                    client_context_id=_optional_uuid(
                        stored.get("client_context_id") or stored.get("clientContextId")
                    ),
                    exact=_optional_string(stored.get("exact")),
                    prefix=_optional_string(stored.get("prefix")),
                    suffix=_optional_string(stored.get("suffix")),
                    media_id=_optional_uuid(stored.get("media_id") or stored.get("mediaId"))
                    or row.source_media_id,
                    source_media_id=_optional_uuid(
                        stored.get("source_media_id") or stored.get("sourceMediaId")
                    )
                    or row.source_media_id,
                    media_title=_optional_string(
                        stored.get("media_title") or stored.get("mediaTitle")
                    ),
                    media_kind=_optional_string(
                        stored.get("media_kind") or stored.get("mediaKind")
                    ),
                    locator=_optional_mapping(stored.get("locator")) or row.locator_json,
                    title=_optional_string(stored.get("title")),
                    route=_optional_string(stored.get("route")),
                )
            )
            continue

        snapshots_by_message_id.setdefault(row.message_id, []).append(
            MessageContextSnapshot(
                kind="object_ref",
                type=cast(MESSAGE_CONTEXT_TYPES, row.object_type),
                id=row.object_id,
                evidence_span_ids=_snapshot_evidence_span_ids(stored),
                color=_optional_highlight_color(stored.get("color")),
                preview=_optional_string(stored.get("preview") or stored.get("snippet")),
                exact=_optional_string(stored.get("exact")),
                prefix=_optional_string(stored.get("prefix")),
                suffix=_optional_string(stored.get("suffix")),
                media_id=_optional_uuid(stored.get("media_id") or stored.get("mediaId")),
                media_title=_optional_string(stored.get("media_title") or stored.get("mediaTitle")),
                media_kind=_optional_string(stored.get("media_kind") or stored.get("mediaKind")),
                title=_optional_string(stored.get("title") or stored.get("label")),
                route=_optional_string(stored.get("route")),
            )
        )

    return snapshots_by_message_id


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _optional_uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _optional_mapping(value: object) -> dict[str, object] | None:
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _optional_highlight_color(value: object) -> HIGHLIGHT_COLORS | None:
    if value in {"yellow", "green", "blue", "pink", "purple"}:
        return cast(HIGHLIGHT_COLORS, value)
    return None


def _snapshot_evidence_span_ids(snapshot: Mapping[str, object]) -> list[UUID]:
    raw_values = snapshot.get("evidence_span_ids")
    if raw_values is None:
        raw_values = snapshot.get("evidenceSpanIds")
    if raw_values is None:
        raw_values = snapshot.get("evidence_span_id")
    if raw_values is None:
        raw_values = snapshot.get("evidenceSpanId")
    if isinstance(raw_values, str):
        values = [raw_values]
    elif isinstance(raw_values, Sequence) and not isinstance(raw_values, (str, bytes)):
        values = list(raw_values)
    else:
        values = []

    evidence_span_ids: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        evidence_span_id = _optional_uuid(value)
        if evidence_span_id is None or evidence_span_id in seen:
            continue
        seen.add(evidence_span_id)
        evidence_span_ids.append(evidence_span_id)
    return evidence_span_ids


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


def load_message_evidence_for_message_ids(
    db: Session,
    message_ids: list[UUID],
) -> tuple[
    dict[UUID, MessageEvidenceSummaryOut],
    dict[UUID, list[MessageClaimOut]],
    dict[UUID, list[MessageClaimEvidenceOut]],
]:
    """Load persisted claim/evidence citation rows for messages."""

    if not message_ids:
        return {}, {}, {}

    summary_rows = db.scalars(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id.in_(message_ids)
        )
    ).all()
    summaries = {
        row.message_id: MessageEvidenceSummaryOut.model_validate(row, from_attributes=True)
        for row in summary_rows
    }

    claim_rows = (
        db.scalars(
            select(AssistantMessageClaim)
            .options(joinedload(AssistantMessageClaim.evidence))
            .where(AssistantMessageClaim.message_id.in_(message_ids))
            .order_by(AssistantMessageClaim.message_id.asc(), AssistantMessageClaim.ordinal.asc())
        )
        .unique()
        .all()
    )
    claims: dict[UUID, list[MessageClaimOut]] = {message_id: [] for message_id in message_ids}
    evidence: dict[UUID, list[MessageClaimEvidenceOut]] = {
        message_id: [] for message_id in message_ids
    }
    for claim in claim_rows:
        claims.setdefault(claim.message_id, []).append(
            MessageClaimOut.model_validate(claim, from_attributes=True)
        )
        evidence.setdefault(claim.message_id, []).extend(
            MessageClaimEvidenceOut.model_validate(row, from_attributes=True)
            for row in claim.evidence
        )
    return summaries, claims, evidence


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

    Cleans conversation-owned context memory, then deletes the conversation.

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
    contexts_by_message_id = load_message_context_snapshots_for_message_ids(db, message_ids)
    tool_calls_by_message_id = load_message_tool_calls_for_message_ids(db, message_ids)
    (
        evidence_summary_by_message_id,
        claims_by_message_id,
        claim_evidence_by_message_id,
    ) = load_message_evidence_for_message_ids(db, message_ids)
    messages = [
        MessageOut(
            id=row[0],
            seq=row[1],
            role=row[2],
            content=row[3],
            parent_message_id=row[8],
            branch_root_message_id=row[9],
            branch_anchor_kind=row[10],
            branch_anchor={"kind": row[10], **(row[11] or {})},
            contexts=contexts_by_message_id.get(row[0], []),
            tool_calls=tool_calls_by_message_id.get(row[0], []),
            evidence_summary=evidence_summary_by_message_id.get(row[0]),
            claims=claims_by_message_id.get(row[0], []),
            claim_evidence=claim_evidence_by_message_id.get(row[0], []),
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
                       m.branch_root_message_id, m.branch_anchor_kind, m.branch_anchor
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

    memory_item_ids = _conversation_memory_item_ids(db, conversation_id)
    if memory_item_ids:
        db.execute(
            text("""
                DELETE FROM conversation_memory_item_sources
                WHERE memory_item_id = ANY(:memory_item_ids)
            """),
            {"memory_item_ids": memory_item_ids},
        )
    db.execute(
        text("DELETE FROM conversation_memory_items WHERE conversation_id = :conversation_id"),
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
                WHERE chat_run_id = ANY(:chat_run_ids)
            """),
            {"chat_run_ids": chat_run_ids},
        )

    db.execute(
        text("""
            DELETE FROM chat_prompt_assemblies
            WHERE assistant_message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )

    claim_ids = _assistant_claim_ids_for_messages(db, message_ids)
    if claim_ids:
        db.execute(
            text("""
                DELETE FROM assistant_message_claim_evidence
                WHERE claim_id = ANY(:claim_ids)
            """),
            {"claim_ids": claim_ids},
        )
    db.execute(
        text("""
            DELETE FROM assistant_message_claims
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )
    db.execute(
        text("""
            DELETE FROM assistant_message_evidence_summaries
            WHERE message_id = ANY(:message_ids)
        """),
        {"message_ids": list(message_ids)},
    )

    tool_call_ids = _message_tool_call_ids_for_messages(db, message_ids)
    if tool_call_ids:
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
        text("DELETE FROM message_context_items WHERE message_id = ANY(:message_ids)"),
        {"message_ids": list(message_ids)},
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
    db.execute(
        text("""
            UPDATE conversation_memory_items
            SET created_by_message_id = NULL
            WHERE created_by_message_id = ANY(:message_ids)
        """),
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


def _message_subtree_ids(db: Session, conversation_id: UUID, message_id: UUID) -> list[UUID]:
    rows = db.execute(
        text(
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
            """
        ),
        {"conversation_id": conversation_id, "message_id": message_id},
    )
    return [row[0] for row in rows]


def _conversation_memory_item_ids(db: Session, conversation_id: UUID) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM conversation_memory_items
            WHERE conversation_id = :conversation_id
            ORDER BY created_at ASC, id ASC
        """),
        {"conversation_id": conversation_id},
    )
    return [row[0] for row in rows]


def _chat_run_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM chat_runs
            WHERE user_message_id = ANY(:message_ids)
               OR assistant_message_id = ANY(:message_ids)
            ORDER BY created_at ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]


def _assistant_claim_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM assistant_message_claims
            WHERE message_id = ANY(:message_ids)
            ORDER BY ordinal ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]


def _message_tool_call_ids_for_messages(db: Session, message_ids: Sequence[UUID]) -> list[UUID]:
    rows = db.execute(
        text("""
            SELECT id
            FROM message_tool_calls
            WHERE user_message_id = ANY(:message_ids)
               OR assistant_message_id = ANY(:message_ids)
            ORDER BY tool_call_index ASC, id ASC
        """),
        {"message_ids": list(message_ids)},
    )
    return [row[0] for row in rows]
