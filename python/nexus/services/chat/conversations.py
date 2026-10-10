"""Conversations: create, the chats index, tree writes, deletes, and facts others read.

A chat is its owner's only; foreign ids mask as not found. Deletion locks the
conversation, as admission does, deletes messages and lets the FK cascades take runs,
events, tool calls and retrievals; edges and web snapshots are cleaned here.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Conversation
from nexus.db.retries import retry_read_committed
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.jobs.queue import revoke_jobs_by_dedupe_keys
from nexus.schemas.collection_page import (
    CollectionPage,
    CollectionRevisionOut,
    parse_collection_query,
)
from nexus.schemas.conversation import ConversationListItemOut, ConversationOut, MessageDeleteOut
from nexus.schemas.presence import absent, present
from nexus.schemas.resource_graph import LinkPassageEndpoint, LinkResourceEndpoint
from nexus.services.chat import quotes, reads
from nexus.services.collection_keyset import (
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
    bump_collection_revision,
    read_collection_revision,
    require_collection_revision,
)
from nexus.services.dossier import engine as dossier_engine
from nexus.services.keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_keyset_cursor,
    encode_keyset_cursor,
)
from nexus.services.media_read_map import READ_DOCUMENT_MAX_CHARS
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.citations import citation_counts_for_sources
from nexus.services.resource_graph.edges import create_link
from nexus.services.resource_graph.links import materialize_link_endpoint
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items.capabilities import resource_link_mode

DEFAULT_TITLE = "Chat"
_INDEX = CollectionFamily.ConversationIndex
# Versioned: a cursor minted under the unordered index carried no plan or revision.
_INDEX_CURSOR = f"{_INDEX.value}:v2"
_DATE, _ID, _TEXT, _INT = (
    KeysetValueKind.DateTime,
    KeysetValueKind.Uuid,
    KeysetValueKind.Text,
    KeysetValueKind.Int,
)
# Each view's total order (``sort``, ``direction``): the canonical newest-first view
# has no keys, so it keeps one URL; equal titles read newest first in both directions.
_VIEWS: dict[tuple[str | None, str | None], list[SortKey]] = {
    (None, None): [SortKey("updated_at", "desc", _DATE), SortKey("id", "desc", _ID)],
    ("updated", "asc"): [SortKey("updated_at", "asc", _DATE), SortKey("id", "asc", _ID)],
    **{
        ("title", direction): [
            SortKey("title_key", direction, _TEXT),
            SortKey("presented_title", direction, _TEXT),
            SortKey("updated_at", "desc", _DATE),
            SortKey("id", "desc", _ID),
        ]
        for direction in ("asc", "desc")
    },
}


def create(
    db: Session, *, viewer_id: UUID, initial_context_refs: Sequence[str] | None
) -> ConversationOut:
    """An empty chat with its initial context links; any failure leaves nothing."""

    conversation = Conversation(owner_user_id=viewer_id, title=DEFAULT_TITLE, next_seq=1)
    db.add(conversation)
    db.flush()
    for uri in initial_context_refs or ():
        ref = parse_resource_ref(uri)
        if isinstance(ref, ResourceRefParseFailure):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"Invalid resource_uri: {uri!r}. Expected '<scheme>:<uuid>'.",
            )
        endpoint = (
            LinkPassageEndpoint(candidate_ref=ref.uri)
            if resource_link_mode(ref) == "materialize_passage"
            else LinkResourceEndpoint(ref=ref.uri)
        )
        create_link(
            db,
            viewer_id=viewer_id,
            source=ResourceRef("conversation", conversation.id),
            target=materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=endpoint),
        )
    bump_collection_revision(db, viewer_id=viewer_id, family=_INDEX)
    db.commit()
    return ConversationOut(id=conversation.id, title=conversation.title)


def index(
    db: Session, *, viewer_id: UUID, items: Sequence[tuple[str, str]]
) -> CollectionPage[ConversationListItemOut]:
    """One revision-consistent page; its cursor binds viewer, plan, revision and search.

    Title search is a trimmed literal substring of at most 200 characters.
    """

    query = parse_collection_query(items, domain_keys={"sort", "direction", "title_search"})
    search = query.parameters.get("title_search", "").strip()
    plan = _VIEWS.get((query.parameters.get("sort"), query.parameters.get("direction")))
    if plan is None or len(search) > 200:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsupported chat index view, or a title_search over 200 characters",
        )
    revision = (
        read_collection_revision(db, viewer_id=viewer_id, family=_INDEX)
        if query.collection_revision is None
        else require_collection_revision(
            db, viewer_id=viewer_id, family=_INDEX, expected=query.collection_revision
        )
    )
    binding: dict[str, object] = {
        "family": _INDEX_CURSOR,
        "plan": plan_json(plan),
        "revision": revision,
        "viewerId": str(viewer_id),
    }
    if search:
        binding["titleSearch"] = search
    params: dict[str, object] = {"viewer": viewer_id, "limit": query.limit + 1, "search": search}
    keyset = ""
    if query.cursor is not None:
        keyset = keyset_clause(plan, alias="facts")
        after = decode_keyset_cursor(
            query.cursor, family=_INDEX_CURSOR, query=binding, expected_kinds=expected_kinds(plan)
        )
        params |= keyset_params(plan, after)
    # The DB CHECK keeps titles nonblank, so the presented title is the title itself.
    rows = (
        db.execute(
            text(
                f"""
                WITH facts AS (
                    SELECT c.id, c.title, c.updated_at, c.title AS presented_title,
                        lower(c.title) AS title_key,
                        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)
                            AS message_count
                    FROM conversations c
                    WHERE c.owner_user_id = :viewer
                      AND (:search = '' OR strpos(lower(c.title), lower(:search)) > 0)
                )
                SELECT * FROM facts WHERE true {keyset}
                ORDER BY {order_by_sql(plan, alias="facts")}
                LIMIT :limit
                """
            ),
            params,
        )
        .mappings()
        .all()
    )
    page = rows[: query.limit]
    cursor = None
    if len(rows) > query.limit and page:
        after_page = after_values(plan, page[-1])
        cursor = encode_keyset_cursor(family=_INDEX_CURSOR, query=binding, after=after_page)
    return CollectionPage[ConversationListItemOut](
        items=[
            ConversationListItemOut(
                id=row["id"],
                title=row["title"],
                message_count=row["message_count"],
                updated_at=row["updated_at"],
            )
            for row in page
        ],
        collectionRevision=revision,
        nextCursor=present(cursor) if cursor is not None else absent(),
    )


def select_leaf(db: Session, *, viewer_id: UUID, conversation_id: UUID, leaf_id: UUID) -> None:
    """The owner's chosen leaf: a message of this chat with no children.

    The conversation lock orders the choice against admissions, which move the leaf.
    """

    _lock_owned(db, viewer_id, conversation_id)
    moved = db.execute(
        text(
            """
            UPDATE conversations SET active_leaf_message_id = :leaf
            WHERE id = :id AND EXISTS (
                SELECT 1 FROM messages m WHERE m.id = :leaf AND m.conversation_id = :id
                  AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.parent_message_id = m.id)
            )
            RETURNING id
            """
        ),
        {"leaf": leaf_id, "id": conversation_id},
    ).first()
    if moved is None:
        raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "active_leaf_message_id must be a leaf")
    db.commit()


def rename_fork(db: Session, *, viewer_id: UUID, message_id: UUID, title: str | None) -> None:
    """Name (or unname) the fork a user turn starts."""

    renamed = db.execute(
        text(
            """
            UPDATE messages m SET fork_title = :title FROM conversations c
            WHERE m.id = :id AND m.role = 'user' AND c.id = m.conversation_id
              AND c.owner_user_id = :viewer
            RETURNING m.id
            """
        ),
        {"title": title, "id": message_id, "viewer": viewer_id},
    ).first()
    if renamed is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    db.commit()


def delete_conversation(
    db: Session, *, viewer_id: UUID, conversation_id: UUID
) -> CollectionRevisionOut:
    def attempt() -> CollectionRevisionOut:
        _lock_owned(db, viewer_id, conversation_id)
        _delete(db, conversation_id, None)
        revision = bump_collection_revision(db, viewer_id=viewer_id, family=_INDEX)
        db.commit()
        return CollectionRevisionOut(collectionRevision=revision)

    return retry_read_committed(db, "delete_conversation", attempt)


def delete_message(db: Session, *, viewer_id: UUID, message_id: UUID) -> MessageDeleteOut:
    """The message and its subtree; the chat too when nothing remains."""

    def attempt() -> MessageDeleteOut:
        conversation_id = db.execute(
            text(
                """
                SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
                WHERE m.id = :message AND c.owner_user_id = :viewer
                FOR UPDATE OF c
                """
            ),
            {"message": message_id, "viewer": viewer_id},
        ).scalar_one_or_none()
        if conversation_id is None:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        deleted = _delete(db, conversation_id, message_id)
        revision = bump_collection_revision(db, viewer_id=viewer_id, family=_INDEX)
        db.commit()
        return MessageDeleteOut(
            conversationId=conversation_id,
            conversationDeleted=deleted,
            collectionRevision=revision,
        )

    return retry_read_committed(db, "delete_message", attempt)


def _delete(db: Session, conversation_id: UUID, root_id: UUID | None) -> bool:
    """Delete one subtree (every root's when ``root_id`` is None), then the chat when
    nothing remains, under the caller's conversation lock. Returns whether it went."""

    ids = (
        db.execute(
            text(
                """
            WITH RECURSIVE subtree AS (
                SELECT id FROM messages
                WHERE conversation_id = :chat
                  AND (id = :root OR (CAST(:root AS uuid) IS NULL AND parent_message_id IS NULL))
                UNION ALL
                SELECT m.id FROM messages m JOIN subtree s ON m.parent_message_id = s.id
            )
            SELECT id FROM subtree
            """
            ),
            {"chat": conversation_id, "root": root_id},
        )
        .scalars()
        .all()
    )
    runs = db.execute(
        text("SELECT id FROM chat_runs WHERE assistant_message_id = ANY(:ids)"), {"ids": ids}
    ).scalars()
    revoke_jobs_by_dedupe_keys(db, kind="chat_run", dedupe_keys=[f"chat_run:{id_}" for id_ in runs])
    # Every web hit captured a snapshot: collect them all, not only the cited ones.
    snapshots = (
        db.execute(
            text(
                """
            SELECT CAST(r.source_id AS uuid) FROM message_retrievals r
            JOIN message_tool_calls c ON c.id = r.tool_call_id
            WHERE c.assistant_message_id = ANY(:ids) AND r.result_type = 'web_result'
            """
            ),
            {"ids": ids},
        )
        .scalars()
        .all()
    )
    cleanup.delete_edges_for_deleted_resources(
        db, refs=[ResourceRef("message", id_) for id_ in ids]
    )
    # The cascades take runs, events, tool calls and retrievals; ``llm_calls`` has no
    # FK and outlives the chat as the operational ledger.
    db.execute(text("DELETE FROM messages WHERE id = ANY(:ids)"), {"ids": ids})
    cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=snapshots)
    remaining = db.execute(
        text("SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = :chat)"),
        {"chat": conversation_id},
    ).scalar_one()
    if remaining:
        return False
    chat = ResourceRef("conversation", conversation_id)
    cleanup.delete_edges_for_deleted_resource(db, ref=chat)
    dossier_engine.on_subject_deleted(db, chat)  # a FK-less subject
    db.execute(text("DELETE FROM conversations WHERE id = :chat"), {"chat": conversation_id})
    return True


def _lock_owned(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    owner = db.scalar(
        select(Conversation.owner_user_id)
        .where(Conversation.id == conversation_id)
        .with_for_update()
    )
    if owner != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")


def owned_conversation_ids(
    db: Session, *, viewer_id: UUID, conversation_ids: list[UUID]
) -> set[UUID]:
    """The ids the viewer owns: chats are owner-only, so this is also visibility."""

    return set(
        db.scalars(
            select(Conversation.id).where(
                Conversation.owner_user_id == viewer_id, Conversation.id.in_(conversation_ids)
            )
        )
    )


@dataclass(frozen=True, slots=True)
class MessageActionFacts:
    """Closed facts needed to plan one visible message's resource actions."""

    is_owner: bool
    fork_applicable: bool
    walk_sources_applicable: bool
    rerun_applicable: bool
    regenerate_applicable: bool


def message_action_facts(
    db: Session, *, viewer_id: UUID, message_ids: list[UUID]
) -> dict[UUID, MessageActionFacts]:
    """The viewer's settled messages' action facts, in a bounded number of queries."""

    rows = db.execute(
        text(
            """
            SELECT m.id, m.role, m.status FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.id = ANY(:ids) AND m.status != 'pending' AND c.owner_user_id = :viewer
            """
        ),
        {"ids": message_ids, "viewer": viewer_id},
    ).all()
    runs = {
        run.assistant_message_id: run
        for run in db.scalars(select(ChatRun).where(ChatRun.assistant_message_id.in_(message_ids)))
    }
    counts = citation_counts_for_sources(
        db, source_scheme="message", source_ids=[row.id for row in rows]
    )
    facts: dict[UUID, MessageActionFacts] = {}
    for row in rows:
        answer = row.role == "assistant" and row.status == "complete"
        run = runs.get(row.id)
        facts[row.id] = MessageActionFacts(
            is_owner=True,
            fork_applicable=answer,
            walk_sources_applicable=answer and counts.get(row.id, 0) >= 2,
            rerun_applicable=run is not None and reads.can_rerun(run),
            regenerate_applicable=run is not None and run.status == "complete",
        )
    return facts


@dataclass(frozen=True, slots=True)
class ConversationReadPage:
    body: str
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class ConversationReadRefusal:
    code: Literal["missing", "invalid_cursor", "stale_cursor"]


def read_message_page(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, cursor: str | None
) -> ConversationReadPage | ConversationReadRefusal:
    """Bounded completed-message text for the agent's read tool, in one statement snapshot.

    A cursor binds the metadata revision: completing, editing or deleting a message,
    or a late branch, makes it stale.
    """

    binding = {"viewer_id": str(viewer_id), "uri": ref.uri}
    revision, after_seq, after_id, offset = None, -1, UUID(int=0), 0
    if cursor is not None:
        try:
            values = decode_keyset_cursor(
                cursor,
                family="CompletedMessages",
                query=binding,
                expected_kinds=(_TEXT, _INT, _ID, _INT),
            )
        except InvalidRequestError:
            return ConversationReadRefusal("invalid_cursor")
        revision, after_seq, after_id, offset = cast(tuple[str, int, UUID, int], values)
        if after_seq < 1 or offset < 0:
            return ConversationReadRefusal("invalid_cursor")
    record = (
        db.execute(
            text("""
        WITH visible AS (
            SELECT c.id FROM conversations c WHERE c.owner_user_id = :viewer_id
              AND c.id = CASE WHEN :scheme = 'conversation' THEN CAST(:id AS uuid)
                  ELSE (SELECT conversation_id FROM messages WHERE id = :id) END
        ), complete AS MATERIALIZED (
            SELECT m.id, m.seq, m.parent_message_id, m.role, m.updated_at
            FROM messages m JOIN visible v ON v.id = m.conversation_id
            WHERE (:scheme = 'conversation' AND m.status = 'complete')
               OR (:scheme = 'message' AND m.id = :id AND m.status != 'pending')
        ), metadata AS (
            SELECT encode(sha256(convert_to(COALESCE(string_agg(
                jsonb_build_array(id, seq, parent_message_id, role, extract(epoch FROM updated_at))::text,
                ',' ORDER BY seq, id), ''), 'UTF8')), 'hex') AS revision,
                count(*) AS total,
                count(*) FILTER (WHERE NOT :continuation
                    OR (seq, id) > (:after_seq, CAST(:after_id AS uuid))
                    OR ((seq, id) = (:after_seq, CAST(:after_id AS uuid)) AND :offset > 0))
                    AS remaining,
                bool_or(seq = :after_seq AND id = :after_id) AS cursor_exists
            FROM complete
        ), chosen AS (
            SELECT m.id, m.seq, m.parent_message_id, m.role, m.content, m.reader_selection_snapshot
            FROM complete c JOIN messages m ON m.id = c.id
            WHERE NOT :continuation OR (m.seq, m.id) > (:after_seq, CAST(:after_id AS uuid))
                OR ((m.seq, m.id) = (:after_seq, CAST(:after_id AS uuid)) AND :offset > 0)
            ORDER BY m.seq, m.id LIMIT 20
        )
        SELECT EXISTS (SELECT 1 FROM visible) AS visible, metadata.*,
            COALESCE((SELECT jsonb_agg(to_jsonb(chosen) ORDER BY seq, id) FROM chosen),
                '[]'::jsonb) AS messages
        FROM metadata
    """),
            {
                "viewer_id": viewer_id,
                "scheme": ref.scheme,
                "id": ref.id,
                "continuation": cursor is not None,
                "after_seq": after_seq,
                "after_id": after_id,
                "offset": offset,
            },
        )
        .mappings()
        .one()
    )
    if not record["visible"] or (ref.scheme == "message" and not record["total"]):
        return ConversationReadRefusal("missing")
    if revision is not None and revision != record["revision"]:
        return ConversationReadRefusal("stale_cursor")
    if cursor is not None and not record["cursor_exists"]:
        return ConversationReadRefusal("invalid_cursor")
    if not record["messages"]:
        return ConversationReadPage(body="no completed messages.", next_cursor=None)
    segments: list[str] = []
    used = 0
    next_cursor = None
    for position, message in enumerate(record["messages"]):
        body = message["content"]
        if message["reader_selection_snapshot"] is not None:
            snapshot = quotes.decode(message["reader_selection_snapshot"])
            body = f"{quotes.snapshot_block(snapshot, 'historical_reader_selection')}\n{body}"
        start = offset if message["id"] == str(after_id) else 0
        total = len(body)
        if start > total or (start > 0 and start == total):
            return ConversationReadRefusal("invalid_cursor")
        parent = message["parent_message_id"]
        label = f"message:{message['id']} parent={f'message:{parent}' if parent else 'root'}"
        label = f"{label} role={message['role']}"
        header = f"{label} [{start},{total})/{total}\n"
        available = READ_DOCUMENT_MAX_CHARS - used - (2 if segments else 0) - len(header)
        if available < 0 or (available == 0 and total > start):
            break
        end = min(total, start + available)
        segment = f"{label} [{start},{end})/{total}\n{body[start:end]}"
        used += len(segment) + (2 if segments else 0)
        segments.append(segment)
        next_cursor = None
        if end < total or position + 1 < record["remaining"]:
            next_cursor = encode_keyset_cursor(
                family="CompletedMessages",
                query=binding,
                after=(
                    KeysetValue(_TEXT, record["revision"]),
                    KeysetValue(_INT, message["seq"]),
                    KeysetValue(_ID, UUID(message["id"])),
                    KeysetValue(_INT, end if end < total else 0),
                ),
            )
        if end < total:
            break
    return ConversationReadPage(body="\n\n".join(segments), next_cursor=next_cursor)
