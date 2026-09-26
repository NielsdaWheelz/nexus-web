"""Conversation and message service layer.

Reads go through the canonical visibility predicate (owner, or library-shared
with active dual membership); every write is owner-only. Missing and foreign
identities are masked as E_CONVERSATION_NOT_FOUND / E_MESSAGE_NOT_FOUND so the
API cannot be probed.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import assert_never, cast
from uuid import UUID

from sqlalchemy import RowMapping, delete, func, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, visible_conversation_ids_cte_sql
from nexus.db.models import ChatRun, Conversation, Message
from nexus.db.retries import retry_read_committed
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.jobs.queue import revoke_jobs_by_dedupe_keys
from nexus.schemas.chat_reader_selection import ReaderSelectionOut
from nexus.schemas.citation import CitationOut
from nexus.schemas.collection_page import (
    CollectionCursor,
    CollectionPage,
    CollectionRevision,
    CollectionRevisionOut,
    ParsedCollectionQuery,
    parse_collection_query,
)
from nexus.schemas.conversation import (
    BRANCH_ANCHOR_KINDS,
    AssistantTrustTrailOut,
    ConversationListItemOut,
    ConversationOut,
    MessageDeleteOut,
    MessageDocument,
    MessageOut,
    PageInfo,
)
from nexus.schemas.presence import Presence, absent, present
from nexus.services.chat_failure import rerun_eligibility
from nexus.services.chat_reader_selection import (
    decode_reader_selection_snapshot,
    reader_selection_out,
)
from nexus.services.collection_keyset import (
    Direction,
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
    plan_json,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
    bump_collection_revision,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.keyset_cursor import (
    KeysetValueKind,
    decode_keyset_cursor,
    encode_keyset_cursor,
)
from nexus.services.resource_graph import cleanup as graph_cleanup
from nexus.services.resource_graph import context as context_service
from nexus.services.resource_graph.citations import citation_counts_for_sources
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
DEFAULT_CONVERSATION_TITLE = "Chat"
MAX_CONVERSATION_TITLE_LENGTH = 120
MAX_CONVERSATION_SEARCH_QUERY = 200


def derive_conversation_title(content: str | None) -> str:
    """Derive a conversation title from user content; blank falls back."""

    normalized = " ".join((content or "").split()).strip()
    if not normalized:
        return DEFAULT_CONVERSATION_TITLE
    return normalized[:MAX_CONVERSATION_TITLE_LENGTH].rstrip()


def message_document(role: str, content: str) -> dict[str, object]:
    """The rendered-text document; the only text the reader renders."""

    return {
        "type": "message_document",
        "blocks": []
        if not content.strip()
        else [
            {
                "type": "text",
                "format": "markdown" if role == "assistant" else "plain",
                "text": content,
            }
        ],
    }


def get_conversation_for_visible_read_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def get_conversation_for_owner_write_or_404(
    db: Session, viewer_id: UUID, conversation_id: UUID
) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    return conversation


def get_message_count(db: Session, conversation_id: UUID) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id)
        )
        or 0
    )


def conversation_to_out(
    db: Session,
    conversation: Conversation,
    message_count: int,
    viewer_id: UUID | None = None,
) -> ConversationOut:
    return ConversationOut(
        id=conversation.id,
        title=conversation.title,
        owner_user_id=conversation.owner_user_id,
        is_owner=(viewer_id is not None and conversation.owner_user_id == viewer_id),
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
    citations: list[CitationOut] | None = None,
    trust_trail: AssistantTrustTrailOut | None = None,
) -> MessageOut:
    """The one run/history/tree ``MessageOut`` projector.

    ``reader_selection`` projects the immutable per-message quote snapshot;
    its activation is recomputed from the viewer's current source visibility.
    """

    reader_selection: Presence[ReaderSelectionOut] = absent()
    if message.reader_selection_snapshot is not None:
        reader_selection = present(
            reader_selection_out(
                db,
                viewer_id=viewer_id,
                snapshot=decode_reader_selection_snapshot(message.reader_selection_snapshot),
            )
        )
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
        branch_anchor={"kind": message.branch_anchor_kind, **(message.branch_anchor or {})},
        status=message.status,
        can_rerun=can_rerun,
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
    """Messages whose unique owning run is failed/cancelled and rerunnable."""

    if not assistant_message_ids:
        return set()
    runs = db.scalars(
        select(ChatRun).where(
            ChatRun.owner_user_id == viewer_id,
            ChatRun.assistant_message_id.in_(assistant_message_ids),
            ChatRun.status.in_(("error", "cancelled")),
        )
    ).all()
    rerunnable: set[UUID] = set()
    for run in runs:
        error_code = "cancelled" if run.status == "cancelled" else run.error_code
        if error_code is not None and rerun_eligibility(
            error_code=error_code,
            run_status=run.status,
        ):
            rerunnable.add(run.assistant_message_id)
    return rerunnable


def create_conversation(
    db: Session,
    viewer_id: UUID,
    initial_context_refs: Sequence[str] | None = None,
) -> ConversationOut:
    """Create an empty private conversation with its initial context edges.

    Any validation or visibility failure leaves no partial conversation behind.
    """

    conversation = Conversation(
        owner_user_id=viewer_id,
        title=DEFAULT_CONVERSATION_TITLE,
        next_seq=1,
    )
    db.add(conversation)
    db.flush()
    result = conversation_to_out(db, conversation, message_count=0, viewer_id=viewer_id)

    for index, resource_uri in enumerate(initial_context_refs or ()):
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

    bump_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.ConversationIndex)
    db.commit()
    return result


def get_conversation(db: Session, viewer_id: UUID, conversation_id: UUID) -> ConversationOut:
    conversation = get_conversation_for_visible_read_or_404(db, viewer_id, conversation_id)
    return conversation_to_out(
        db,
        conversation,
        get_message_count(db, conversation_id),
        viewer_id=viewer_id,
    )


# =============================================================================
# The conversation index (one paging machinery)
# =============================================================================


@dataclass(frozen=True, slots=True)
class ChatsUpdatedNewest:
    """Canonical: the most recently updated chat first."""


@dataclass(frozen=True, slots=True)
class ChatsUpdatedOldest:
    """The least recently updated chat first."""


@dataclass(frozen=True, slots=True)
class ChatsTitle:
    direction: Direction


type ConversationIndexView = ChatsUpdatedNewest | ChatsUpdatedOldest | ChatsTitle

_INDEX_QUERY_KEYS = frozenset({"sort", "direction"})
# Versioned family: a cursor minted under the single unordered index carried no
# plan and no revision, so none is decodable against a chosen order.
_INDEX_CURSOR_FAMILY = f"{CollectionFamily.ConversationIndex.value}:v2"
# The retained destination picker pages the same rows without a revision.
_TITLE_SEARCH_CURSOR_FAMILY = "ConversationDestination"
# The presented chat title, matching `conversations/presentation.ts`. Ordering on
# the raw column would sort by a string the reader never sees.
_PRESENTED_TITLE_SQL = "coalesce(nullif(btrim(c.title), ''), 'Untitled chat')"


def parse_conversation_index_query(
    items: Sequence[tuple[str, str]],
) -> tuple[ConversationIndexView, ParsedCollectionQuery]:
    """Strict chat-index view parse over the request's ``multi_items()``.

    Both keys absent is the canonical newest-first view; anything else must name
    one advertised non-default view exactly. ``updated+desc`` is rejected rather
    than normalized so the canonical view keeps exactly one URL.
    """

    query = parse_collection_query(items, domain_keys=_INDEX_QUERY_KEYS)
    sort = query.parameters.get("sort")
    direction = query.parameters.get("direction")
    if sort is None and direction is None:
        return ChatsUpdatedNewest(), query
    if sort == "updated" and direction == "asc":
        return ChatsUpdatedOldest(), query
    if sort == "title" and direction in ("asc", "desc"):
        return ChatsTitle(cast(Direction, direction)), query
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported chat index view")


def _index_plan(view: ConversationIndexView) -> list[SortKey]:
    """The total, stable sort-key plan behind ORDER BY, the keyset, and the
    cursor ``after``. The conversation id is unique, so every plan is total; the
    title orders keep ``updated_at DESC, id DESC`` in both directions so equally
    titled chats always read newest-first."""

    match view:
        case ChatsUpdatedNewest():
            return [
                SortKey("updated_at", "desc", KeysetValueKind.DateTime),
                SortKey("id", "desc", KeysetValueKind.Uuid),
            ]
        case ChatsUpdatedOldest():
            return [
                SortKey("updated_at", "asc", KeysetValueKind.DateTime),
                SortKey("id", "asc", KeysetValueKind.Uuid),
            ]
        case ChatsTitle(direction):
            return [
                SortKey("title_key", direction, KeysetValueKind.Text),
                SortKey("presented_title", direction, KeysetValueKind.Text),
                SortKey("updated_at", "desc", KeysetValueKind.DateTime),
                SortKey("id", "desc", KeysetValueKind.Uuid),
            ]
        case _:
            assert_never(view)


def _conversation_rows(
    db: Session,
    *,
    plan: Sequence[SortKey],
    params: dict[str, object],
    keyset_sql: str,
    title_search: str,
) -> Sequence[RowMapping]:
    """One page of the viewer's conversations in the plan's order.

    ``facts`` projects the derived sort columns once so ORDER BY, the keyset and
    the cursor read identical expressions.
    """

    title_sql = ""
    if title_search:
        title_sql = "AND strpos(lower(c.title), lower(:title_search)) > 0"
        params["title_search"] = title_search
    return (
        db.execute(
            text(
                f"""
                WITH chats AS (
                    SELECT
                        c.id,
                        c.title,
                        c.owner_user_id,
                        c.created_at,
                        c.updated_at,
                        {_PRESENTED_TITLE_SQL} AS presented_title,
                        (
                            SELECT COUNT(*)
                            FROM messages m
                            WHERE m.conversation_id = c.id
                        ) AS message_count
                    FROM conversations c
                    WHERE c.owner_user_id = :viewer_id
                      {title_sql}
                ),
                facts AS (
                    SELECT chats.*, lower(chats.presented_title) AS title_key
                    FROM chats
                )
                SELECT * FROM facts
                WHERE 1 = 1
                  {keyset_sql}
                ORDER BY {order_by_sql(plan, alias="facts")}
                LIMIT :limit_plus_one
                """
            ),
            params,
        )
        .mappings()
        .all()
    )


def list_conversation_index(
    db: Session,
    *,
    viewer_id: UUID,
    limit: int,
    cursor: CollectionCursor | None,
    collection_revision: CollectionRevision | None,
    view: ConversationIndexView,
) -> CollectionPage[ConversationListItemOut]:
    """One revision-consistent page of the finite primary conversation index.

    The returned cursor is bound to this exact viewer, plan, and revision.
    """

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
    plan = _index_plan(view)
    cursor_query = {
        "family": _INDEX_CURSOR_FAMILY,
        "plan": plan_json(plan),
        "revision": current_revision,
        "viewerId": str(viewer_id),
    }
    params: dict[str, object] = {"viewer_id": viewer_id, "limit_plus_one": limit + 1}
    keyset_sql = ""
    if cursor is not None:
        keyset_sql = keyset_clause(plan, alias="facts")
        params.update(
            keyset_params(
                plan,
                decode_keyset_cursor(
                    cursor,
                    family=_INDEX_CURSOR_FAMILY,
                    query=cursor_query,
                    expected_kinds=expected_kinds(plan),
                ),
            )
        )
    rows = _conversation_rows(
        db,
        plan=plan,
        params=params,
        keyset_sql=keyset_sql,
        title_search="",
    )
    page_rows = rows[:limit]
    next_cursor: CollectionCursor | None = None
    if len(rows) > limit and page_rows:
        next_cursor = encode_keyset_cursor(
            family=_INDEX_CURSOR_FAMILY,
            query=cursor_query,
            after=after_values(plan, page_rows[-1]),
        )
    return CollectionPage[ConversationListItemOut](
        items=[
            ConversationListItemOut(
                id=row["id"],
                title=row["title"],
                message_count=row["message_count"],
                updated_at=row["updated_at"],
            )
            for row in page_rows
        ],
        collectionRevision=current_revision,
        nextCursor=present(next_cursor) if next_cursor is not None else absent(),
    )


def list_conversations_matching_title(
    db: Session,
    *,
    viewer_id: UUID,
    limit: int,
    cursor: str | None,
    q: str,
) -> tuple[list[ConversationOut], PageInfo]:
    """The retained destination picker: owner-scoped literal title search.

    Ordering stays ``(updated_at DESC, id DESC)`` so a cursor stays stable while
    ``q`` is fixed; changing ``q`` invalidates the cursor's query digest.
    """

    normalized_q = q.strip()
    if len(normalized_q) > MAX_CONVERSATION_SEARCH_QUERY:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"q must be at most {MAX_CONVERSATION_SEARCH_QUERY} characters",
        )
    plan = _index_plan(ChatsUpdatedNewest())
    cursor_query: dict[str, object] = {"viewerId": str(viewer_id), "q": normalized_q}
    params: dict[str, object] = {"viewer_id": viewer_id, "limit_plus_one": limit + 1}
    keyset_sql = ""
    if cursor is not None:
        keyset_sql = keyset_clause(plan, alias="facts")
        params.update(
            keyset_params(
                plan,
                decode_keyset_cursor(
                    cursor,
                    family=_TITLE_SEARCH_CURSOR_FAMILY,
                    query=cursor_query,
                    expected_kinds=expected_kinds(plan),
                ),
            )
        )
    rows = _conversation_rows(
        db,
        plan=plan,
        params=params,
        keyset_sql=keyset_sql,
        title_search=normalized_q,
    )
    page_rows = rows[:limit]
    next_cursor = None
    if len(rows) > limit and page_rows:
        next_cursor = encode_keyset_cursor(
            family=_TITLE_SEARCH_CURSOR_FAMILY,
            query=cursor_query,
            after=after_values(plan, page_rows[-1]),
        )
    return [
        ConversationOut(
            id=row["id"],
            title=row["title"],
            owner_user_id=row["owner_user_id"],
            is_owner=True,
            message_count=row["message_count"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        for row in page_rows
    ], PageInfo(next_cursor=next_cursor)


def list_conversations_with_context_ref(
    db: Session,
    *,
    viewer_id: UUID,
    has_context_ref: str,
    limit: int,
    cursor: str | None,
) -> tuple[list[ConversationOut], PageInfo]:
    """The retained resource-graph mode: conversations with an edge to a ref."""

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


# =============================================================================
# Batched viewer-scoped facts
# =============================================================================


def owned_conversation_ids(
    db: Session, *, viewer_id: UUID, conversation_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied ids the viewer owns — the delete authority."""

    ordered = list(dict.fromkeys(conversation_ids))
    if not ordered:
        return set()
    return set(
        db.scalars(
            select(Conversation.id).where(
                Conversation.owner_user_id == viewer_id,
                Conversation.id.in_(ordered),
            )
        )
    )


def visible_conversation_ids(
    db: Session, *, viewer_id: UUID, conversation_ids: list[UUID]
) -> set[UUID]:
    """The subset of the supplied ids the viewer can read, in one set query.

    The set-based twin of ``can_read_conversation``: it reuses the shared
    visibility rule, so the batched read and the per-ref predicate cannot drift.
    """

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


@dataclass(frozen=True, slots=True)
class MessageActionFacts:
    """Closed facts needed to plan one visible Message's resource actions."""

    is_owner: bool
    fork_applicable: bool
    walk_sources_applicable: bool
    rerun_applicable: bool
    regenerate_applicable: bool


def message_action_facts(
    db: Session, *, viewer_id: UUID, message_ids: list[UUID]
) -> dict[UUID, MessageActionFacts]:
    """Batch viewer-scoped Message action facts with bounded query count."""

    ordered = list(dict.fromkeys(message_ids))
    if not ordered:
        return {}
    rows = (
        db.execute(
            text(
                f"""
                SELECT m.id, m.role, m.status, conversation.owner_user_id
                FROM messages m
                JOIN conversations conversation ON conversation.id = m.conversation_id
                WHERE m.id = ANY(:message_ids)
                  AND m.status != 'pending'
                  AND m.conversation_id IN ({visible_conversation_ids_cte_sql()})
                """
            ),
            {"viewer_id": viewer_id, "message_ids": ordered},
        )
        .mappings()
        .all()
    )
    assistant_ids = [UUID(str(row["id"])) for row in rows if str(row["role"]) == "assistant"]
    run_by_message = {
        run.assistant_message_id: run
        for run in (
            db.scalars(
                select(ChatRun).where(
                    ChatRun.assistant_message_id.in_(assistant_ids),
                    ChatRun.status.in_(("complete", "error", "cancelled")),
                )
            )
            if assistant_ids
            else []
        )
    }
    citation_counts = citation_counts_for_sources(
        db,
        source_scheme="message",
        source_ids=[UUID(str(row["id"])) for row in rows],
    )
    facts: dict[UUID, MessageActionFacts] = {}
    for row in rows:
        message_id = UUID(str(row["id"]))
        is_assistant = str(row["role"]) == "assistant"
        is_complete = str(row["status"]) == "complete"
        run = run_by_message.get(message_id)
        rerun_applicable = False
        if run is not None and run.status in ("error", "cancelled"):
            error_code = "cancelled" if run.status == "cancelled" else run.error_code
            rerun_applicable = error_code is not None and rerun_eligibility(
                error_code=error_code,
                run_status=run.status,
            )
        facts[message_id] = MessageActionFacts(
            is_owner=UUID(str(row["owner_user_id"])) == viewer_id,
            fork_applicable=is_assistant and is_complete,
            walk_sources_applicable=(
                is_assistant and is_complete and citation_counts.get(message_id, 0) >= 2
            ),
            rerun_applicable=rerun_applicable,
            regenerate_applicable=run is not None and run.status == "complete",
        )
    return facts


# =============================================================================
# Deletion (no FK cascade: every owned table is named here)
# =============================================================================


def delete_conversation(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
) -> CollectionRevisionOut:
    def attempt() -> CollectionRevisionOut:
        # Hold the parent row lock while deleting child rows: branch-path writes
        # insert FK-backed rows concurrently during active chat panes, and the
        # lock prevents a new child appearing between cleanup and the delete.
        conversation = db.scalar(
            select(Conversation).where(Conversation.id == conversation_id).with_for_update()
        )
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
        delete_conversation_rows_without_commit(db, conversation_id)
        bump_all_collection_revisions(db, family=CollectionFamily.ConversationIndex)
        revision = read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.ConversationIndex,
        )
        db.commit()
        return CollectionRevisionOut(collectionRevision=revision)

    return retry_read_committed(db, "delete_conversation", attempt)


def delete_message(db: Session, viewer_id: UUID, message_id: UUID) -> MessageDeleteOut:
    """Delete a message and its subtree; the conversation too when none remain."""

    def attempt() -> MessageDeleteOut:
        # Message creation and every conversation delete linearize on the parent
        # row. Join through the requested Message so missing/foreign identities
        # stay masked, then hold that lock through subtree enumeration, the
        # remaining-count decision, and commit.
        conversation = db.scalar(
            select(Conversation)
            .join(Message, Message.conversation_id == Conversation.id)
            .where(Message.id == message_id)
            .with_for_update(of=Conversation)
        )
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        conversation_id = conversation.id
        if (
            db.scalar(
                select(Message.id).where(
                    Message.id == message_id,
                    Message.conversation_id == conversation_id,
                )
            )
            is None
        ):
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

        delete_message_rows_without_commit(
            db,
            _message_ids(
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
            ),
        )
        db.flush()
        conversation_deleted = not db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id)
        )
        if conversation_deleted:
            delete_conversation_rows_without_commit(db, conversation_id)
            db.flush()
        bump_all_collection_revisions(db, family=CollectionFamily.ConversationIndex)
        collection_revision = read_collection_revision(
            db,
            viewer_id=viewer_id,
            family=CollectionFamily.ConversationIndex,
        )
        db.commit()
        return MessageDeleteOut(
            conversationId=conversation_id,
            conversationDeleted=conversation_deleted,
            collectionRevision=collection_revision,
        )

    return retry_read_committed(db, "delete_message", attempt)


def delete_conversation_rows_without_commit(db: Session, conversation_id: UUID) -> None:
    delete_message_rows_without_commit(
        db,
        _message_ids(
            db,
            """
            SELECT id FROM messages
            WHERE conversation_id = :conversation_id
            ORDER BY seq ASC, id ASC
            """,
            {"conversation_id": conversation_id},
        ),
    )
    conversation_ref = ResourceRef(scheme="conversation", id=conversation_id)
    graph_cleanup.delete_edges_for_deleted_resource(db, ref=conversation_ref)

    # FK-less artifact subject cleanup: this conversation's Dossier head,
    # revisions, events and citation edges.
    from nexus.services.artifacts import engine as artifact_engine

    artifact_engine.on_subject_deleted(db, conversation_ref)

    db.execute(
        text("DELETE FROM conversation_active_paths WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(
        text("DELETE FROM conversation_branches WHERE conversation_id = :conversation_id"),
        {"conversation_id": conversation_id},
    )
    db.execute(delete(Conversation).where(Conversation.id == conversation_id))
    db.flush()


def delete_message_rows_without_commit(db: Session, message_ids: Sequence[UUID]) -> None:
    if not message_ids:
        return
    ids = list(message_ids)
    db.execute(
        text(
            "DELETE FROM conversation_active_paths WHERE active_leaf_message_id = ANY(:message_ids)"
        ),
        {"message_ids": ids},
    )
    db.execute(
        text("DELETE FROM conversation_branches WHERE branch_user_message_id = ANY(:message_ids)"),
        {"message_ids": ids},
    )

    chat_run_ids = _message_ids(
        db,
        """
        SELECT id FROM chat_runs
        WHERE user_message_id = ANY(:message_ids)
           OR assistant_message_id = ANY(:message_ids)
        ORDER BY created_at ASC, id ASC
        """,
        {"message_ids": ids},
    )
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
        text("DELETE FROM chat_prompt_assemblies WHERE assistant_message_id = ANY(:message_ids)"),
        {"message_ids": ids},
    )

    tool_call_ids = _message_ids(
        db,
        """
        SELECT id FROM message_tool_calls
        WHERE user_message_id = ANY(:message_ids)
           OR assistant_message_id = ANY(:message_ids)
        ORDER BY tool_call_index ASC, id ASC
        """,
        {"message_ids": ids},
    )
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
    for message_id in ids:
        graph_cleanup.delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="message", id=message_id)
        )
    # The generation ledger ``llm_calls`` is keyed on the run parent, carries no
    # FK, and deliberately survives message deletion as an operational ledger.
    db.execute(delete(Message).where(Message.id.in_(ids)))
    db.flush()


def _message_ids(db: Session, sql: str, params: dict[str, object]) -> list[UUID]:
    return [row[0] for row in db.execute(text(sql), params)]
