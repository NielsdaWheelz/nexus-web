"""A chat's context: its incident live authored links plus its automatic citation/system
facts, ranked by first attachment. ``context_facts_sql`` is the single membership law,
shared with search scope; membership is direct and never traverses another chat.

An authored link with a chat endpoint changes only through the semantic owner, from a
device upload or a chat command alike; ``project_conversation_links`` applies its rank
and ``context`` version inside that head-locked projection and takes no chat lock.
Chat commands lock the chat before the account head. Mutations only flush.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, ResourceEdge, ResourceViewState
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.resource_graph import ContextItemOut, ContextOut, DetachContextMutation
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services import authored
from nexus.services.resource_graph.edges import (
    EdgeCreate,
    conversation_rank,
    create_edge,
    delete_edge,
    get_owned_edge,
    lock_conversation_endpoints,
    next_context_rank,
)
from nexus.services.resource_graph.liveness import AUTHORED_LINK_ORIGINS, edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import ResolvedResource, resolve_refs
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import capability
from nexus.services.resource_items.items import resource_items_out
from nexus.services.resource_items.routing import resource_activations_for_refs
from nexus.services.suggestion_changes import record_input_change


@dataclass(frozen=True, slots=True)
class ContextRefOut:
    """One context fact and its hydrated target, for prompts, SSE and the API."""

    edge_id: UUID
    conversation_id: UUID
    target: ResourceRef
    resolved: ResolvedResource
    activation: ResourceActivationOut
    created_at: datetime


def context_facts_sql(conversation_id_sql: str = ":conversation_id") -> str:
    """Rows ``(edge_id, created_at, target_scheme, target_id, order_key)``: a user link
    projected from whichever end is the chat, and the chat's bare automatic facts.
    ``conversation_id_sql`` is caller-owned SQL, never input; callers bind ``:viewer_id``."""
    chat = f"e.source_scheme = 'conversation' AND e.source_id = {conversation_id_sql}"
    return f"""
        SELECT e.id AS edge_id, e.created_at,
               CASE WHEN {chat} THEN e.target_scheme ELSE e.source_scheme END AS target_scheme,
               CASE WHEN {chat} THEN e.target_id ELSE e.source_id END AS target_id,
               v.context_order_key AS order_key
        FROM resource_edges e
        LEFT JOIN resource_view_states v
          ON v.edge_id = e.id AND v.user_id = e.user_id
         AND v.surface_scheme = 'conversation' AND v.surface_id = {conversation_id_sql}
        WHERE e.user_id = :viewer_id AND e.origin = 'user' AND {edge_live_sql("e")}
          AND (({chat})
            OR (e.target_scheme = 'conversation' AND e.target_id = {conversation_id_sql}))
        UNION ALL
        SELECT e.id AS edge_id, e.created_at, e.target_scheme, e.target_id,
               e.source_order_key AS order_key
        FROM resource_edges e
        WHERE e.user_id = :viewer_id AND e.origin IN ('citation', 'system')
          AND e.ordinal IS NULL AND {chat} AND {edge_live_sql("e")}
    """


def list_context_refs(
    db: Session, *, viewer_id: UUID, conversation_id: UUID
) -> list[ContextRefOut]:
    """One row per target, at its first-attached rank."""
    _owned_chat(db, viewer_id, conversation_id)
    rows = db.execute(
        text(f"""
        SELECT * FROM (
            SELECT DISTINCT ON (target_scheme, target_id) *
            FROM ({context_facts_sql()}) facts
            ORDER BY target_scheme, target_id, order_key ASC NULLS LAST, created_at, edge_id
        ) targets
        ORDER BY order_key ASC NULLS LAST, created_at, edge_id
        """),
        {"viewer_id": viewer_id, "conversation_id": conversation_id},
    ).all()
    facts = [
        (row.edge_id, row.created_at, assert_resource_ref(f"{row.target_scheme}:{row.target_id}"))
        for row in rows
    ]
    return _context_refs(db, viewer_id, conversation_id, facts)


def add_context_ref_without_commit(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    target: ResourceRef,
    origin: Literal["citation", "system"],
    user_edit: bool = False,
) -> ContextRefOut | None:
    """Attach ``target`` automatically at the next rank, under the chat's lock; ``None``
    when it is already a member."""
    _owned_chat(db, viewer_id, conversation_id)
    if not capability(target.scheme).attachable:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be attached to conversation context"
        )
    rank = conversation_rank(
        db, viewer_id=viewer_id, conversation_id=conversation_id, target=target
    )
    if admits_resource_for_conversation_read(
        db, viewer_id=viewer_id, conversation_id=conversation_id, target=target
    ):
        return None
    chat = ResourceRef("conversation", conversation_id)
    fact = EdgeCreate(chat, target, "context", origin, source_order_key=rank)
    edge = create_edge(db, viewer_id=viewer_id, input=fact)
    if user_edit:
        versions.bump_version(db, viewer_id=viewer_id, ref=chat, lane="context")
    return _context_refs(db, viewer_id, conversation_id, [(edge.id, edge.created_at, target)])[0]


def context_version(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> int:
    return versions.versions_for_ref(
        db, viewer_id=viewer_id, ref=ResourceRef("conversation", conversation_id)
    ).get("context", 1)


def context_out(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> ContextOut:
    _owned_chat(db, viewer_id, conversation_id)
    # One statement pairs the membership and precondition under READ COMMITTED.
    rows = db.execute(
        text(f"""
        SELECT facts.*, COALESCE(v.version,1) AS context_version
        FROM conversations c
        LEFT JOIN resource_versions v ON v.user_id=:viewer_id AND v.resource_scheme='conversation'
          AND v.resource_id=c.id AND v.lane='context'
        LEFT JOIN LATERAL ({context_facts_sql("c.id")}) facts ON TRUE
        WHERE c.id=:conversation_id
        ORDER BY facts.order_key ASC NULLS LAST, facts.created_at, facts.edge_id
    """),
        {"viewer_id": viewer_id, "conversation_id": conversation_id},
    ).all()
    version = rows[0].context_version
    grouped: dict[str, list[UUID]] = {}
    for row in rows:
        if row.edge_id is not None:
            grouped.setdefault(f"{row.target_scheme}:{row.target_id}", []).append(row.edge_id)
    items = resource_items_out(
        db, viewer_id=viewer_id, refs=[assert_resource_ref(ref) for ref in grouped]
    )
    return ContextOut(
        items=[
            ContextItemOut(
                item=item,
                admission_edge_ids=grouped[item.ref],
                mutation=DetachContextMutation(
                    conversation_id=conversation_id,
                    target_ref=item.ref,
                    expected_context_version=version,
                ),
            )
            for item in items
        ],
    )


def detach_context_target(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    target: ResourceRef,
    expected_context_version: int,
) -> None:
    """Remove every current admission fact atomically; absence succeeds before version check.

    A stale retry may not remove a later reattachment. Historical message evidence stays.
    An authored link is unlinked through the semantic owner, observing its current adds;
    its projection hook bumps the version. Machine facts go here and bump it once.
    """
    chat_ref = ResourceRef("conversation", conversation_id)
    lock_conversation_endpoints(db, [chat_ref, target])
    _owned_chat(db, viewer_id, conversation_id)
    ids = list(
        db.scalars(
            text(
                f"SELECT edge_id FROM ({context_facts_sql()}) facts WHERE target_scheme=:scheme AND target_id=:target"
            ),
            {
                "viewer_id": viewer_id,
                "conversation_id": conversation_id,
                "scheme": target.scheme,
                "target": target.id,
            },
        )
    )
    if not ids:
        return
    if (
        context_version(db, viewer_id=viewer_id, conversation_id=conversation_id)
        != expected_context_version
    ):
        raise ConflictError(ApiErrorCode.E_CONTEXT_CHANGED, "Conversation context changed")
    machine = False
    for edge_id in ids:
        edge = get_owned_edge(db, viewer_id=viewer_id, edge_id=edge_id)
        assert edge is not None
        if edge.origin in AUTHORED_LINK_ORIGINS:
            (link,) = authored.read_states(
                db, viewer_id, resource_refs=[], link_ids=[str(edge_id)]
            ).links
            authored.server_command(
                db,
                viewer_id,
                command={"kind": "unlink", "link_id": str(edge_id), "observed_add": link.add_vv},
                resource_refs=[],
                link_ids=[str(edge_id)],
            )
        else:
            machine = True
            delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    if machine:
        versions.bump_version(db, viewer_id=viewer_id, ref=chat_ref, lane="context")
    record_input_change(db, owners=(chat_ref.uri,))


def project_conversation_links(
    db: Session, *, viewer_id: UUID, links: Sequence[tuple[UUID, bool | None, bool]]
) -> None:
    """Apply chat context effects of projected authored links with a chat endpoint.

    ``links`` holds ``(link_id, visible_before, visible_after)``; ``visible_before`` is
    None for a new projection row. Called by the authored projection after its edge and
    view-state upserts, under the account head lock: it takes no chat, run or media lock.
    A newly visible link takes the target's earliest rank in the chat, else the next one;
    every visibility change bumps that chat's ``context`` version once.
    """
    changed: set[UUID] = set()
    for link_id, before, after in links:
        row = db.get(ResourceEdge, link_id)
        if row is None:
            raise AssertionError("projected authored link has no row")
        source = assert_resource_ref(f"{row.source_scheme}:{row.source_id}")
        target = assert_resource_ref(f"{row.target_scheme}:{row.target_id}")
        for chat, other in ((source, target), (target, source)):
            if chat.scheme != "conversation" or bool(before) == after:
                continue
            changed.add(chat.id)
            if not after:
                continue
            rank = next_context_rank(db, viewer_id=viewer_id, conversation_id=chat.id, target=other)
            db.execute(
                insert(ResourceViewState)
                .values(
                    user_id=viewer_id,
                    surface_scheme="conversation",
                    surface_id=chat.id,
                    edge_id=row.id,
                    target_scheme=other.scheme,
                    target_id=other.id,
                    context_order_key=rank,
                )
                .on_conflict_do_update(
                    index_elements=["user_id", "surface_scheme", "surface_id", "edge_id"],
                    index_where=ResourceViewState.edge_id.is_not(None),
                    set_={
                        "target_scheme": other.scheme,
                        "target_id": other.id,
                        "context_order_key": rank,
                    },
                )
            )
    for chat_id in sorted(changed):
        versions.bump_version(
            db, viewer_id=viewer_id, ref=ResourceRef("conversation", chat_id), lane="context"
        )


def admits_resource_for_conversation_read(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef
) -> bool:
    """Membership only; callers authorize the chat and the resource themselves."""
    return bool(
        db.scalar(
            text(f"""
            SELECT EXISTS (
                SELECT 1 FROM ({context_facts_sql()}) facts
                WHERE target_scheme = :target_scheme AND target_id = :target_id
            )
            """),
            {
                "viewer_id": viewer_id,
                "conversation_id": conversation_id,
                "target_scheme": target.scheme,
                "target_id": target.id,
            },
        )
    )


def batch_conversations_with_any_edge_to_ref(
    db: Session, *, viewer_id: UUID, targets: list[UUID], target_scheme: ResourceScheme
) -> dict[UUID, list[Conversation]]:
    """The viewer's chats whose context holds each target, first attachment first."""
    if not targets:
        return {}
    rows = db.execute(
        text(f"""
        SELECT facts.target_id, c.id
        FROM conversations c
        CROSS JOIN LATERAL ({context_facts_sql("c.id")}) facts
        WHERE c.owner_user_id = :viewer_id
          AND facts.target_scheme = :target_scheme AND facts.target_id = ANY(:targets)
        GROUP BY facts.target_id, c.id
        ORDER BY min(facts.created_at), c.id
        """),
        {"viewer_id": viewer_id, "target_scheme": target_scheme, "targets": targets},
    ).all()
    chats = {
        chat.id: chat
        for chat in db.scalars(
            select(Conversation).where(Conversation.id.in_({row[1] for row in rows}))
        )
    }
    out: dict[UUID, list[Conversation]] = {}
    for target_id, conversation_id in rows:
        out.setdefault(target_id, []).append(chats[conversation_id])
    return out


def _context_refs(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    facts: list[tuple[UUID, datetime, ResourceRef]],
) -> list[ContextRefOut]:
    targets = [target for _, _, target in facts]
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=targets)
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=targets,
        missing_ref_uris={item.uri for item in resolved if item.missing},
    )
    return [
        ContextRefOut(edge_id, conversation_id, target, item, activations[target.uri], created_at)
        for (edge_id, created_at, target), item in zip(facts, resolved, strict=True)
    ]


def _owned_chat(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    chat = db.get(Conversation, conversation_id)
    if chat is None or chat.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
