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
from typing import Any, cast
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, visible_conversation_ids_cte_sql
from nexus.db.models import (
    ChatRun,
    Conversation,
    Message,
)
from nexus.errors import (
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import revoke_jobs_by_dedupe_keys
from nexus.logging import get_logger
from nexus.schemas.chat_reader_selection import ReaderSelectionOut
from nexus.schemas.citation import CitationOut
from nexus.schemas.collection_page import (
    CollectionCursor,
    CollectionPage,
    CollectionRevision,
    CollectionRevisionOut,
)
from nexus.schemas.conversation import (
    BRANCH_ANCHOR_KINDS,
    AssistantTrustTrailOut,
    ConversationListItemOut,
    ConversationOut,
    MessageDocument,
    MessageOut,
    MessagePageInfo,
    PageInfo,
)
from nexus.schemas.presence import Presence, absent, present
from nexus.services.chat_failure import (
    compute_has_write_tool_attempt,
    profile_selection_active,
    rerun_eligibility,
)
from nexus.services.chat_reader_selection import (
    decode_reader_selection_snapshot,
    reader_selection_out,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
    bump_collection_revision,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.message_trust_trails import build_assistant_trust_trails
from nexus.services.resource_graph import cleanup as graph_cleanup
from nexus.services.resource_graph import context as context_service
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.signed_keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_signed_keyset_cursor,
    encode_signed_keyset_cursor,
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
# Defensive upper bound on the destination-picker title-search query.
MAX_CONVERSATION_SEARCH_QUERY = 200


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


def encode_message_cursor(seq: int, id: UUID) -> str:
    return _encode_cursor({"seq": seq, "id": str(id)})


def decode_message_cursor(cursor: str) -> tuple[int, UUID]:
    return _decode_cursor(cursor, lambda p: (int(p["seq"]), UUID(p["id"])))


# =============================================================================
# Helper Functions
# =============================================================================


def clamp_limit(limit: int) -> int:
    """Clamp limit to valid range [MIN_LIMIT, MAX_LIMIT]."""
    return min(max(limit, MIN_LIMIT), MAX_LIMIT)


def _escape_title_search(value: str) -> str:
    """Escape LIKE metacharacters so ``q`` matches as a literal substring under
    Postgres' default backslash escape. Backslash is escaped first so the escapes
    added for ``%``/``_`` are not themselves re-escaped."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


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
    db: Session,
    message: Message,
    *,
    viewer_id: UUID,
    can_rerun: bool = False,
    can_regenerate: bool = False,
    citations: list[CitationOut] | None = None,
    trust_trail: AssistantTrustTrailOut | None = None,
) -> MessageOut:
    """Convert Message ORM model to MessageOut schema.

    The one run/history/tree ``MessageOut`` projector. ``citations`` (the
    server-built ``[N]`` read-model for assistant messages) is computed by the
    caller and threaded through here. ``reader_selection`` projects the immutable
    per-message reader-quote snapshot (Present only on a quoted user message,
    Absent otherwise); activation is recomputed from ``viewer_id``'s current
    source visibility.
    """
    branch_anchor = {"kind": message.branch_anchor_kind, **(message.branch_anchor or {})}
    reader_selection: Presence[ReaderSelectionOut]
    if message.reader_selection_snapshot is not None:
        reader_selection = present(
            reader_selection_out(
                db,
                viewer_id=viewer_id,
                snapshot=decode_reader_selection_snapshot(message.reader_selection_snapshot),
            )
        )
    else:
        reader_selection = absent()
    return MessageOut(
        id=message.id,
        seq=message.seq,
        role=message.role,
        message_document=MessageDocument.model_validate(message.message_document),
        citations=citations or [],
        trust_trail=trust_trail,
        parent_message_id=message.parent_message_id,
        branch_root_message_id=message.branch_root_message_id,
        branch_anchor_kind=cast(BRANCH_ANCHOR_KINDS, message.branch_anchor_kind),
        branch_anchor=branch_anchor,
        status=message.status,
        can_rerun=can_rerun,
        can_regenerate=can_regenerate,
        reader_selection=reader_selection,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def rerunnable_assistant_message_ids(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
) -> set[UUID]:
    """The subset of ``assistant_message_ids`` whose latest chat run is
    terminal-failed/cancelled and eligible for rerun (`chat_failure.
    rerun_eligibility`, the one policy owner). One read per message: each
    message's *latest* run only — an earlier failed run superseded by a
    completed rerun is not itself rerunnable."""
    if not assistant_message_ids:
        return set()

    runs = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id.in_(assistant_message_ids),
                ChatRun.status.in_(("error", "cancelled")),
            )
            .order_by(ChatRun.created_at.desc(), ChatRun.id.desc())
        )
        .scalars()
        .all()
    )
    latest_by_message_id: dict[UUID, ChatRun] = {}
    for run in runs:
        latest_by_message_id.setdefault(run.assistant_message_id, run)

    rerunnable: set[UUID] = set()
    for message_id, run in latest_by_message_id.items():
        error_code = "cancelled" if run.status == "cancelled" else run.error_code
        if error_code is None:
            continue
        profile_active = run.profile_id is not None and lookup_profile(run.profile_id) is not None
        has_write_tool_attempt = compute_has_write_tool_attempt(db, run)
        if rerun_eligibility(
            error_code=error_code,
            run_status=run.status,
            profile_active=profile_active,
            has_write_tool_attempt=has_write_tool_attempt,
        ):
            rerunnable.add(message_id)
    return rerunnable


def regeneratable_assistant_message_ids(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_ids: Sequence[UUID],
) -> set[UUID]:
    """The subset of ``assistant_message_ids`` that are currently regeneratable:
    a completed assistant answer whose single owning `ChatRun` is complete, whose
    profile/reasoning selection still resolves to its historical target, and that
    attempted no assistant-write tool (spec §8). Exactly one complete run is
    expected per assistant message — this never orders-by-latest. Non-assistant
    ids simply match no owning run and are excluded.

    This is the advisory read projection; the regenerate mutation re-evaluates
    the same facts transactionally and is the sole authority (Law 9)."""
    if not assistant_message_ids:
        return set()

    runs = (
        db.execute(
            select(ChatRun).where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id.in_(assistant_message_ids),
                ChatRun.status == "complete",
            )
        )
        .scalars()
        .all()
    )
    run_by_message_id: dict[UUID, ChatRun] = {run.assistant_message_id: run for run in runs}

    regeneratable: set[UUID] = set()
    for message_id, run in run_by_message_id.items():
        if profile_selection_active(run) and not compute_has_write_tool_attempt(db, run):
            regeneratable.add(message_id)
    return regeneratable


# =============================================================================
# Service Functions
# =============================================================================


def create_conversation(
    db: Session,
    viewer_id: UUID,
    initial_context_refs: Sequence[str] | None = None,
) -> ConversationOut:
    """Create a new empty private conversation.

    Initial context refs are validated and inserted in the same transaction as the
    conversation row. Any validation or visibility failure leaves no partial
    conversation behind.

    Args:
        db: Database session.
        viewer_id: The ID of the user creating the conversation.
        initial_context_refs: Optional resource URIs to attach immediately.

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

    result = conversation_to_out(db, conversation, message_count=0, viewer_id=viewer_id)

    if initial_context_refs:
        for index, resource_uri in enumerate(initial_context_refs):
            ref = parse_resource_ref(resource_uri)
            if isinstance(ref, ResourceRefParseFailure):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    f"Invalid resource_uri: {resource_uri!r}. Expected '<scheme>:<uuid>'.",
                )
            context_service.add_context_ref_without_commit(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation.id,
                target=ref,
                origin="user",
                source_order_key=f"{index + 1:010d}",
            )

    bump_collection_revision(
        db,
        viewer_id=viewer_id,
        family=CollectionFamily.ConversationIndex,
    )
    db.commit()
    return result


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


def list_conversation_index(
    db: Session,
    *,
    viewer_id: UUID,
    limit: int,
    cursor: CollectionCursor | None,
    collection_revision: CollectionRevision | None,
    scope: str | None,
) -> CollectionPage[ConversationListItemOut]:
    """One revision-consistent page of the finite primary conversation index."""
    effective_scope = scope if scope is not None else "mine"
    if effective_scope not in VALID_SCOPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid scope: {effective_scope}. Must be one of: mine, all, shared",
        )

    current_revision = (
        read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.ConversationIndex,
        )
        if collection_revision is None
        else require_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.ConversationIndex,
            expected=collection_revision,
        )
    )
    cursor_family = f"{CollectionFamily.ConversationIndex.value}:{effective_scope}"
    cursor_query = {
        "scope": effective_scope,
        "viewerId": str(viewer_id),
    }
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "limit_plus_one": limit + 1,
    }
    keyset_clause = ""
    if cursor is not None:
        after_updated_at, after_id = decode_signed_keyset_cursor(
            cursor,
            family=cursor_family,
            query=cursor_query,
            expected_kinds=(
                KeysetValueKind.DateTime,
                KeysetValueKind.Uuid,
            ),
        )
        params.update(
            {
                "after_updated_at": after_updated_at,
                "after_id": after_id,
            }
        )
        keyset_clause = """
          AND (
            c.updated_at < :after_updated_at
            OR (c.updated_at = :after_updated_at AND c.id < :after_id)
          )
        """

    if effective_scope == "mine":
        relation = """
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
        """
    else:
        scope_filter = "AND c.owner_user_id != :viewer_id" if effective_scope == "shared" else ""
        relation = f"""
            FROM conversations c
            JOIN visible_conversations vc ON vc.id = c.id
            WHERE true
              {scope_filter}
        """

    cte = "" if effective_scope == "mine" else f"WITH {_build_visibility_cte(viewer_id)}"
    rows = db.execute(
        text(
            f"""
            {cte}
            SELECT
                c.id,
                c.title,
                c.updated_at,
                (
                    SELECT COUNT(*)
                    FROM messages m
                    WHERE m.conversation_id = c.id
                ) AS message_count
            {relation}
            {keyset_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit_plus_one
            """
        ),
        params,
    ).all()

    page_rows = rows[:limit]
    next_cursor: CollectionCursor | None = None
    if len(rows) > limit and page_rows:
        last = page_rows[-1]
        next_cursor = encode_signed_keyset_cursor(
            family=cursor_family,
            query=cursor_query,
            after=(
                KeysetValue(KeysetValueKind.DateTime, last.updated_at),
                KeysetValue(KeysetValueKind.Uuid, last.id),
            ),
        )

    return CollectionPage[ConversationListItemOut](
        items=[
            ConversationListItemOut(
                id=row.id,
                title=row.title,
                message_count=row.message_count,
                updated_at=row.updated_at,
            )
            for row in page_rows
        ],
        collectionRevision=current_revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
    )


def list_retained_conversations(
    db: Session,
    viewer_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
    scope: str | None = None,
    has_context_ref: str | None = None,
    q: str | None = None,
) -> tuple[list[ConversationOut], PageInfo]:
    """List conversations for one retained manual-paging route mode.

    When ``q`` is supplied (the destination-picker title search), the scope is
    forced to owned and the query composes only with ``cursor``/``limit``; any
    ``scope`` or ``has_context_ref`` filter is rejected. ``q`` is trimmed and
    length-bounded; a blank query applies no title filter. Ordering stays
    ``(updated_at DESC, id DESC)`` so a cursor stays stable while ``q`` is fixed
    (changing ``q`` clears the cursor caller-side).

    When ``has_context_ref`` is supplied, returns conversations with any edge to
    that resource URI (single-user: viewer-owned only); ``scope`` is meaningless
    there and is neither validated nor applied (pinned bypass). Unmarked primary
    index reads are owned exclusively by ``list_conversation_index``.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque pagination cursor.
        scope: One of 'mine' (default), 'all', 'shared'.
        has_context_ref: Resource URI to filter conversations by context edge.
        q: Owned-scope title search (destination picker); composes only with
            cursor/limit.

    Returns:
        Tuple of (conversations, page_info).

    Raises:
        InvalidRequestError(E_INVALID_REQUEST): If scope is invalid, the
            has_context_ref URI is malformed, or ``q`` is combined with another
            scope/context filter or exceeds its length bound.
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    if q is not None:
        if scope is not None or has_context_ref is not None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "q composes only with cursor and limit",
            )
        normalized_q = q.strip()
        if len(normalized_q) > MAX_CONVERSATION_SEARCH_QUERY:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"q must be at most {MAX_CONVERSATION_SEARCH_QUERY} characters",
            )
        return _list_conversations_mine(
            db,
            viewer_id,
            clamp_limit(limit),
            cursor,
            normalized_q=normalized_q,
        )

    if has_context_ref is not None:
        ref = parse_resource_ref(has_context_ref)
        if isinstance(ref, ResourceRefParseFailure):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"Invalid has_context_ref: {has_context_ref!r}. Expected '<scheme>:<uuid>'.",
            )
        page = context_service.list_conversations_with_any_edge_to_ref(
            db, viewer_id=viewer_id, target=ref, limit=limit, cursor=cursor
        )
        return page.conversations, page.page

    raise ValueError("Retained conversation listing requires q or has_context_ref")


def _list_conversations_mine(
    db: Session,
    viewer_id: UUID,
    limit: int,
    cursor: str | None,
    normalized_q: str,
) -> tuple[list[ConversationOut], PageInfo]:
    """List only conversations owned by viewer (scope=mine).

    When ``title_search`` is set, applies a case-insensitive literal-substring
    title match alongside the same cursor/order so pagination stays stable.
    """
    params: dict[str, object] = {"viewer_id": viewer_id, "limit": limit + 1}
    cursor_clause = ""
    cursor_query = {
        "viewerId": str(viewer_id),
        "q": normalized_q,
    }
    if cursor is not None:
        updated_at, conversation_id = decode_signed_keyset_cursor(
            cursor,
            family="ConversationDestination",
            query=cursor_query,
            expected_kinds=(
                KeysetValueKind.DateTime,
                KeysetValueKind.Uuid,
            ),
        )
        params.update(
            cursor_updated_at=updated_at,
            cursor_id=conversation_id,
        )
        cursor_clause = """
          AND (
            c.updated_at < :cursor_updated_at
            OR (c.updated_at = :cursor_updated_at AND c.id < :cursor_id)
          )
        """

    title_clause = ""
    if normalized_q:
        title_clause = "AND c.title ILIKE :title_search"
        params["title_search"] = f"%{_escape_title_search(normalized_q)}%"

    result = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
              {title_clause}
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    )

    return _build_conversation_page(
        result.fetchall(),
        limit,
        viewer_id,
        cursor_query=cursor_query,
    )


def _build_conversation_page(
    rows: Sequence,
    limit: int,
    viewer_id: UUID,
    *,
    cursor_query: dict[str, object],
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
        next_cursor = encode_signed_keyset_cursor(
            family="ConversationDestination",
            query=cursor_query,
            after=(
                KeysetValue(KeysetValueKind.DateTime, last.updated_at),
                KeysetValue(KeysetValueKind.Uuid, last.id),
            ),
        )

    return conversations, PageInfo(next_cursor=next_cursor)


def owned_conversation_ids(
    db: Session, *, viewer_id: UUID, conversation_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied conversation ids the viewer owns, in one set query.

    Ownership is the delete authority :func:`delete_conversation` enforces (write is
    owner-only). The action-snapshot aggregator uses this set-based read to gate the
    ``DeleteConversation`` capability without a per-ref ownership check."""
    ordered = list(dict.fromkeys(conversation_ids))
    if not ordered:
        return set()
    rows = db.execute(
        select(Conversation.id).where(
            Conversation.owner_user_id == viewer_id,
            Conversation.id.in_(ordered),
        )
    ).all()
    return {row[0] for row in rows}


def visible_conversation_ids(
    db: Session, *, viewer_id: UUID, conversation_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied conversation ids the viewer can read, in one set query.

    The set-based twin of :func:`nexus.auth.permissions.can_read_conversation`: it
    reuses the shared :func:`visible_conversation_ids_cte_sql` visibility rule
    (owner OR public OR library-shared with dual membership), so the batched read
    and the per-ref predicate cannot drift. The action-snapshot aggregator uses this
    instead of looping ``can_read_conversation`` per ref (AC9)."""
    ordered = list(dict.fromkeys(conversation_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT v.conversation_id
            FROM ({visible_conversation_ids_cte_sql()}) v
            WHERE v.conversation_id = ANY(:conversation_ids)
            """
        ),
        {"viewer_id": viewer_id, "conversation_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


def visible_message_ids(db: Session, *, viewer_id: UUID, message_ids: list[UUID]) -> set[UUID]:
    """The subset of the supplied message ids the viewer can read, in one set query.

    A message is readable when its parent conversation is visible (the shared
    :func:`visible_conversation_ids_cte_sql` rule) and the message is not a pending
    placeholder — matching the per-ref ``status != 'pending'`` + ``can_read_conversation``
    gate the resolve loader applies. The action-snapshot aggregator uses this instead
    of a per-ref conversation-readability check (AC9)."""
    ordered = list(dict.fromkeys(message_ids))
    if not ordered:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT m.id
            FROM messages m
            WHERE m.id = ANY(:message_ids)
              AND m.status != 'pending'
              AND m.conversation_id IN ({visible_conversation_ids_cte_sql()})
            """
        ),
        {"viewer_id": viewer_id, "message_ids": ordered},
    ).all()
    return {UUID(str(row[0])) for row in rows}


def delete_conversation(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
) -> CollectionRevisionOut:
    """Delete a conversation and its owned rows.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation to delete.

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
    """
    # Verify ownership (write = owner-only) and hold the parent row lock while
    # deleting child rows. Branch path writes insert FK-backed rows concurrently
    # during active chat panes; the lock prevents a new child from appearing
    # between explicit child cleanup and the parent delete.
    conversation = db.scalar(
        select(Conversation).where(Conversation.id == conversation_id).with_for_update()
    )
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    delete_conversation_rows_without_commit(db, conversation_id)
    bump_all_collection_revisions(
        db,
        family=CollectionFamily.ConversationIndex,
    )
    revision = read_collection_revision(
        db,
        viewer_id=viewer_id,
        family=CollectionFamily.ConversationIndex,
    )
    db.commit()
    return CollectionRevisionOut(collectionRevision=revision)


def list_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
    before_cursor: str | None = None,
    window: str | None = None,
) -> tuple[list[MessageOut], MessagePageInfo]:
    """List messages in a conversation.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        conversation_id: The ID of the conversation.
        limit: Maximum number of results (clamped to 1-100).
        cursor: Opaque forward pagination cursor.
        before_cursor: Opaque older-history pagination cursor.
        window: "start" (default) for the oldest page, or "latest" for the
            newest window.

    Returns:
        Tuple of (messages, page_info).

    Raises:
        NotFoundError(E_CONVERSATION_NOT_FOUND): If conversation doesn't exist
            or viewer is not the owner.
        InvalidRequestError(E_INVALID_REQUEST): If pagination mode args conflict.
        InvalidRequestError(E_INVALID_CURSOR): If cursor is malformed.
    """
    if cursor is not None and before_cursor is not None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "cursor and before_cursor cannot be used together",
        )
    window = window if window is not None else "start"
    if window not in ("start", "latest"):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "window must be one of: start, latest",
        )
    if cursor is not None and window == "latest":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "window=latest cannot be used with cursor",
        )

    # Verify read visibility (shared readers can list messages too)
    get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)

    limit = clamp_limit(limit)

    rows = _selected_path_message_rows(db, viewer_id, conversation_id)
    if cursor:
        cursor_seq, cursor_id = decode_message_cursor(cursor)
        rows = [row for row in rows if (row[1], row[0]) > (cursor_seq, cursor_id)]

    next_cursor = None
    before_cursor_out = None
    has_older = False
    if before_cursor:
        cursor_seq, cursor_id = decode_message_cursor(before_cursor)
        rows = [row for row in rows if (row[1], row[0]) < (cursor_seq, cursor_id)]
        has_older = len(rows) > limit
        if has_older:
            rows = rows[-limit:]
    elif window == "latest":
        has_older = len(rows) > limit
        if has_older:
            rows = rows[-limit:]
    else:
        # Existing forward-pagination mode for callers that page oldest → newest.
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]
        if has_more and rows:
            last = rows[-1]
            next_cursor = encode_message_cursor(last[1], last[0])

    message_ids = [row[0] for row in rows]
    assistant_message_ids = [row[0] for row in rows if row[2] == "assistant"]
    trust_trails = build_assistant_trust_trails(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=assistant_message_ids,
    )
    rerunnable_message_ids = rerunnable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=message_ids,
    )
    regeneratable_message_ids = regeneratable_assistant_message_ids(
        db,
        viewer_id=viewer_id,
        assistant_message_ids=message_ids,
    )
    # Project through the single message projector: load the ORM rows for this
    # already-paginated/ordered window (which carry the reader_selection_snapshot
    # the raw row tuple omits) and preserve the row order.
    messages_by_id = {
        message.id: message
        for message in db.execute(select(Message).where(Message.id.in_(message_ids))).scalars()
    }
    messages: list[MessageOut] = []
    for message_id in message_ids:
        message = messages_by_id[message_id]
        trust_trail = trust_trails[message_id] if message.role == "assistant" else None
        messages.append(
            message_to_out(
                db,
                message,
                viewer_id=viewer_id,
                can_rerun=message_id in rerunnable_message_ids,
                can_regenerate=message_id in regeneratable_message_ids,
                trust_trail=trust_trail,
                citations=(
                    [trust_citation.citation for trust_citation in trust_trail.citations]
                    if trust_trail is not None
                    else []
                ),
            )
        )

    if before_cursor or window == "latest":
        if has_older and messages:
            first = messages[0]
            before_cursor_out = encode_message_cursor(first.seq, first.id)

    return messages, MessagePageInfo(
        next_cursor=next_cursor,
        before_cursor=before_cursor_out,
    )


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
                SELECT m.id, m.seq, m.role, m.content, m.status,
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

    bump_all_collection_revisions(
        db,
        family=CollectionFamily.ConversationIndex,
    )
    db.commit()


def delete_conversation_rows_without_commit(db: Session, conversation_id: UUID) -> None:
    message_ids = _message_ids_for_conversation(db, conversation_id)
    delete_message_rows_without_commit(db, message_ids)

    graph_cleanup.delete_edges_for_deleted_resource(
        db, ref=ResourceRef(scheme="conversation", id=conversation_id)
    )

    # FK-less artifact subject cleanup: drop this conversation's Dossier head +
    # revisions + events + citation edges (D-10; no cascade, D-2).
    from nexus.services.artifacts import engine as artifact_engine

    artifact_engine.on_subject_deleted(db, ResourceRef(scheme="conversation", id=conversation_id))

    db.execute(
        text("DELETE FROM conversation_active_paths WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_branches WHERE conversation_id = :conversation_id"),
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
        revoke_jobs_by_dedupe_keys(
            db,
            kind="chat_run",
            dedupe_keys=[f"chat_run:{run_id}" for run_id in chat_run_ids],
        )
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

    for message_id in message_ids:
        graph_cleanup.delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="message", id=message_id)
        )
    # NOTE: the polymorphic per-provider-call ledger ``llm_calls`` (migration
    # 0145, which retired the chat-only per-message usage table) is keyed on the
    # run parent (owner_kind='chat_run', owner_id=chat_runs.id), not on
    # message_id, and carries no FK. The generation-run harness deliberately
    # does not clean it up on conversation/message delete — it is an operational
    # ledger with its own lifecycle — so there is no replacement DELETE here.
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
