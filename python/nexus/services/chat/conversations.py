"""Conversations: create, the chats index, tree writes, deletes, and facts others read.

A chat is its owner's only. Create takes the client's id: a retry answers the viewer's
chat as it stands; another owner's id is a conflict. A fork rename names the title it
replaces: a retry that already landed finds current = desired. Branch writes compare an
observed revision under the conversation lock. Deletion retries treat absent/foreign
targets alike without changing the revision.
Surviving subtree deletion repairs the stored leaf and advances the revision once.
Edges and web snapshots are cleaned here; tool calls retain the write history.
Deletion locks generation owners, generation rows, runs and jobs before retained
media, matching the tool effect fence while its conversation lock prevents admission.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import ChatRun, Conversation, Message
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.jobs.queue import revoke_jobs_by_dedupe_keys
from nexus.schemas.collection_index import CollectionIndex, parse_index_query
from nexus.schemas.conversation import (
    ConversationListItemOut,
    ConversationOut,
    ForkTitleOut,
    MessageDeleteOut,
)
from nexus.schemas.resource_graph import LinkPassageEndpoint, LinkResourceEndpoint
from nexus.services.chat import quotes
from nexus.services.collection_keyset import (
    UPDATED_TITLE_PLANS,
    KeysetValueKind,
    SortKey,
    decode_keyset_cursor,
    encode_keyset_cursor,
    order_by_sql,
)
from nexus.services.generation.ledger import lock_generation_owner
from nexus.services.media_read_map import READ_DOCUMENT_MAX_CHARS
from nexus.services.resource_graph import cleanup
from nexus.services.resource_graph.context import context_facts_sql
from nexus.services.resource_graph.edges import create_link
from nexus.services.resource_graph.links import materialize_link_endpoint
from nexus.services.resource_graph.owners import owner_rows_sql
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items.capabilities import capability
from nexus.services.search import projection

DEFAULT_TITLE = "Chat"
_ID, _TEXT, _INT = KeysetValueKind.Uuid, KeysetValueKind.Text, KeysetValueKind.Int


def create(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, initial_context_refs: Sequence[str]
) -> ConversationOut:
    """An empty chat with its initial context links under the client's id; any failure
    leaves nothing. A resend answers the viewer's chat as it is; another owner's is 409."""

    def attempt() -> ConversationOut:
        created = db.scalar(
            text(
                """
                INSERT INTO conversations (id, owner_user_id, title, next_seq)
                VALUES (:id, :viewer, :title, 1) ON CONFLICT (id) DO NOTHING RETURNING id
                """
            ),
            {"id": conversation_id, "viewer": viewer_id, "title": DEFAULT_TITLE},
        )
        conversation = db.get_one(Conversation, conversation_id)
        if conversation.owner_user_id != viewer_id:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Conversation id belongs to another viewer"
            )
        for uri in initial_context_refs if created else ():
            ref = parse_resource_ref(uri)
            if isinstance(ref, ResourceRefParseFailure):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    f"Invalid resource_uri: {uri!r}. Expected '<scheme>:<uuid>'.",
                )
            endpoint = (
                LinkPassageEndpoint(candidate_ref=ref.uri, passage_target=None)
                if capability(ref.scheme).link_mode == "materialize_passage"
                else LinkResourceEndpoint(ref=ref.uri)
            )
            create_link(
                db,
                viewer_id=viewer_id,
                source=ResourceRef("conversation", conversation.id),
                target=materialize_link_endpoint(db, viewer_id=viewer_id, endpoint=endpoint),
            )
        if created:
            projection.refresh(db, "conversation", [conversation_id])
        return ConversationOut(
            id=conversation.id,
            title=conversation.title,
            branch_revision=conversation.branch_revision,
        )

    return retry_serializable(db, "create_conversation", attempt)


def conversation_index_rows_sql() -> str:
    """Complete owned chat summaries and canonical updated/title order facts."""
    return """
                SELECT c.id, c.title, c.updated_at, c.title AS presented_title,
                    lower(c.title) AS title_key,
                    (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)
                        AS message_count
                FROM conversations c
                WHERE c.owner_user_id = :viewer_id
    """


def _source_context_filter(db: Session, viewer_id: UUID, media_id: UUID | None) -> str:
    """Current readable direct context, shared by the index and latest lookup."""
    if media_id is None:
        return ""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media_owners = owner_rows_sql(f"""
        SELECT target_scheme AS scheme, target_id AS id
        FROM ({context_facts_sql("c.id")}) context
    """)
    return f"""AND EXISTS (
        SELECT 1 FROM ({media_owners}) owners
        WHERE owners.owner_scheme = 'media' AND owners.owner_id = :media_id
    )"""


def index(
    db: Session, *, viewer_id: UUID, items: Sequence[tuple[str, str]]
) -> CollectionIndex[ConversationListItemOut]:
    """All owned chats in one ordered snapshot; title search is a literal substring.

    Readable media scope matches current direct context through one-hop endpoint
    ownership, never historical citations or paths through other resources.
    """
    query = parse_index_query(items, domain_keys={"sort", "direction", "title_search", "media_id"})
    search = query.get("title_search", "").strip()
    plan = UPDATED_TITLE_PLANS.get((query.get("sort"), query.get("direction")))
    if plan is None or len(search) > 200:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Unsupported chat index view, or a title_search over 200 characters",
        )
    raw_media_id = query.get("media_id")
    try:
        media_id = UUID(raw_media_id) if raw_media_id is not None else None
    except ValueError as exc:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid media_id") from exc
    media_filter = _source_context_filter(db, viewer_id, media_id)
    order = order_by_sql(plan, alias="c")
    rows = db.execute(
        text(f"""
            SELECT c.* FROM ({conversation_index_rows_sql()}) c
            WHERE (:search = '' OR strpos(lower(c.title), lower(:search)) > 0)
              {media_filter}
            ORDER BY {order}
        """),
        {"viewer_id": viewer_id, "search": search, "media_id": media_id},
    ).mappings()
    return CollectionIndex[ConversationListItemOut](
        items=[
            ConversationListItemOut(
                **{key: row[key] for key in ConversationListItemOut.model_fields}
            )
            for row in rows
        ],
    )


def latest(db: Session, *, viewer_id: UUID, media_id: UUID) -> ConversationListItemOut | None:
    """The newest visible source-context chat, or null; SQL admits at most one row."""
    media_filter = _source_context_filter(db, viewer_id, media_id)
    order = order_by_sql(UPDATED_TITLE_PLANS[(None, None)], alias="c")
    row = (
        db.execute(
            text(f"""
            SELECT c.* FROM ({conversation_index_rows_sql()}) c
            WHERE TRUE {media_filter} ORDER BY {order} LIMIT 1
        """),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    return (
        None
        if row is None
        else ConversationListItemOut(
            **{key: row[key] for key in ConversationListItemOut.model_fields}
        )
    )


def rename_fork(
    db: Session, *, viewer_id: UUID, message_id: UUID, title: str | None, expected: str | None
) -> ForkTitleOut:
    """Name (or unname) the fork a user turn starts. Already so named: success; named other
    than ``expected``: 409 with ``current_title``. The rename moves ``updated_at``."""

    def attempt() -> ForkTitleOut:
        message = db.scalar(
            select(Message)
            .join(Conversation, Conversation.id == Message.conversation_id)
            .where(
                Message.id == message_id,
                Message.role == "user",
                Conversation.owner_user_id == viewer_id,
            )
            .with_for_update(of=Message)
        )
        if message is None:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        if message.fork_title not in (title, expected):
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "The fork was renamed meanwhile",
                details={"current_title": message.fork_title},
            )
        if message.fork_title != title:
            message.fork_title = title
            message.updated_at = db.scalar(text("SELECT now()"))
        return ForkTitleOut(fork_title=message.fork_title, updated_at=message.updated_at)

    return retry_serializable(db, "rename_fork", attempt)


def delete_conversation(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, expected_revision: int
) -> None:
    def attempt() -> None:
        conversation = _lock_owned(db, viewer_id, conversation_id)
        if conversation is not None:
            require_branch_revision(conversation, expected_revision)
            _delete(db, conversation, None)

    retry_serializable(db, "delete_conversation", attempt)


def delete_message(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    message_id: UUID,
    expected_revision: int,
) -> MessageDeleteOut:
    """The message and its subtree; the chat too when nothing remains."""

    def attempt() -> MessageDeleteOut:
        conversation = _lock_owned(db, viewer_id, conversation_id)
        if conversation is None:
            return MessageDeleteOut(conversation_id=conversation_id, conversation_deleted=True)
        message = db.scalar(
            select(Message.id).where(
                Message.id == message_id, Message.conversation_id == conversation_id
            )
        )
        if message is None:
            return MessageDeleteOut(conversation_id=conversation_id, conversation_deleted=False)
        require_branch_revision(conversation, expected_revision)
        deleted = _delete(db, conversation, message_id)
        return MessageDeleteOut(conversation_id=conversation_id, conversation_deleted=deleted)

    return retry_serializable(db, "delete_message", attempt)


def _delete(db: Session, conversation: Conversation, root_id: UUID | None) -> bool:
    """Delete one subtree (every root's when ``root_id`` is None), then the chat when
    nothing remains, under the caller's conversation lock. Returns whether it went."""

    conversation_id = conversation.id
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
                WHERE m.conversation_id = :chat
            )
            SELECT id FROM subtree
            """
            ),
            {"chat": conversation_id, "root": root_id},
        )
        .scalars()
        .all()
    )
    from nexus.services.library_entries import lock_media_rows_in_order
    from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked

    runs = db.scalars(
        text("SELECT id FROM chat_runs WHERE assistant_message_id = ANY(:ids) ORDER BY id"),
        {"ids": ids},
    ).all()
    for run_id in runs:
        lock_generation_owner(db, kind="chat_run", id=run_id)
    db.execute(
        text("""SELECT id FROM llm_calls WHERE owner_kind = 'chat_run'
                AND owner_id = ANY(:runs) ORDER BY id FOR UPDATE"""),
        {"runs": runs},
    ).all()
    db.execute(
        text("SELECT id FROM chat_runs WHERE id = ANY(:runs) ORDER BY id FOR UPDATE"),
        {"runs": runs},
    ).all()
    revoke_jobs_by_dedupe_keys(db, kind="chat_run", dedupe_keys=[f"chat_run:{id_}" for id_ in runs])
    retained_media = lock_media_rows_in_order(
        db,
        list(
            db.scalars(
                text("""
        SELECT xp.media_id FROM x_post_sources xp WHERE
            xp.media_id IN (SELECT media_id FROM message_retrievals
                WHERE assistant_message_id = ANY(:ids))
            OR EXISTS (SELECT 1 FROM messages msg WHERE msg.id = ANY(:ids)
                AND msg.reader_selection_snapshot #>> '{evidence,target,owner_ref}'
                    = 'media:' || xp.media_id::text)
            OR EXISTS (SELECT 1 FROM resource_edges re WHERE re.source_scheme = 'message'
                AND re.source_id = ANY(:ids) AND re.origin = 'citation'
                AND re.ordinal IS NOT NULL AND re.snapshot #>> '{evidence,target,owner_ref}'
                    = 'media:' || xp.media_id::text)
    """),
                {"ids": ids},
            )
        ),
    )
    # Every web hit captured a snapshot: collect them all, not only the cited ones.
    snapshots = (
        db.execute(
            text(
                """
            SELECT CAST(source_id AS uuid) FROM message_retrievals
            WHERE assistant_message_id = ANY(:ids) AND result_type = 'web_result'
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
    # The cascades take runs, events and retrievals; tool calls outlive their answer
    # (link set null) as the account's write history; ``llm_calls`` has no
    # FK and outlives the chat as the operational ledger.
    db.execute(text("DELETE FROM messages WHERE id = ANY(:ids)"), {"ids": ids})
    for media_id in retained_media:
        claim_document_teardown_if_unreferenced_locked(db, media_id)
    cleanup.delete_orphaned_external_snapshots(db, snapshot_ids=snapshots)
    projection.refresh(db, "message", ids)
    if retained_media:
        projection.refresh_viewer_contributors(db, [conversation.owner_user_id])
    leaf = conversation.active_leaf_message_id
    if leaf is None or leaf in ids:
        leaf = db.scalar(
            text(
                """
                SELECT m.id FROM messages m WHERE m.conversation_id = :chat
                  AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.parent_message_id = m.id)
                ORDER BY m.seq DESC, m.id DESC LIMIT 1
                """
            ),
            {"chat": conversation_id},
        )
    if leaf is not None:
        db.execute(
            text(
                """
                UPDATE conversations SET active_leaf_message_id = :leaf,
                  branch_revision = branch_revision + 1 WHERE id = :chat
                """
            ),
            {"chat": conversation_id, "leaf": leaf},
        )
        return False
    chat = ResourceRef("conversation", conversation_id)
    cleanup.delete_edges_for_deleted_resource(db, ref=chat)
    db.execute(text("DELETE FROM conversations WHERE id = :chat"), {"chat": conversation_id})
    projection.refresh(db, "conversation", [conversation_id])
    return True


def require_branch_revision(conversation: Conversation, expected_revision: int) -> None:
    if conversation.branch_revision != expected_revision:
        raise ApiError(
            ApiErrorCode.E_CONVERSATION_CHANGED, "Conversation changed; refresh to review it"
        )


def _lock_owned(db: Session, viewer_id: UUID, conversation_id: UUID) -> Conversation | None:
    return db.scalar(
        select(Conversation)
        .where(Conversation.id == conversation_id, Conversation.owner_user_id == viewer_id)
        .with_for_update()
    )


@dataclass(frozen=True, slots=True)
class MessageActionFacts:
    """Closed facts needed to plan one visible message's resource actions."""

    fork_applicable: bool
    rerun_applicable: bool
    regenerate_applicable: bool


def message_action_facts(
    db: Session, *, viewer_id: UUID, message_ids: list[UUID]
) -> dict[UUID, MessageActionFacts]:
    """The viewer's settled messages' action facts, in a bounded number of queries."""

    from nexus.services.chat import reads

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
    facts: dict[UUID, MessageActionFacts] = {}
    for row in rows:
        answer = row.role == "assistant" and row.status == "complete"
        run = runs.get(row.id)
        facts[row.id] = MessageActionFacts(
            fork_applicable=answer,
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


# The read tool's cursor schema: the metadata revision, the (seq, id) position, the offset.
_MESSAGE_CURSOR = (
    SortKey("revision", "asc", _TEXT),
    SortKey("seq", "asc", _INT),
    SortKey("id", "asc", _ID),
    SortKey("offset", "asc", _INT),
)


def read_message_page(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, cursor: str | None
) -> ConversationReadPage | ConversationReadRefusal:
    """Bounded completed-message text for the agent's read tool, in one statement snapshot.

    A cursor binds the metadata revision: completing, editing or deleting a message,
    or a late branch, makes it stale.
    """

    binding = {"list": "CompletedMessages", "viewer": viewer_id, "uri": ref.uri}
    revision, after_seq, after_id, offset = None, -1, UUID(int=0), 0
    if cursor is not None:
        try:
            values = decode_keyset_cursor(cursor, binding, _MESSAGE_CURSOR)
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
                binding,
                _MESSAGE_CURSOR,
                {
                    "revision": record["revision"],
                    "seq": message["seq"],
                    "id": message["id"],
                    "offset": end if end < total else 0,
                },
            )
        if end < total:
            break
    return ConversationReadPage(body="\n\n".join(segments), next_cursor=next_cursor)
