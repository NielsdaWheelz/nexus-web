"""A chat's context: its incident user links plus its automatic citation/system facts,
ranked by first attachment. ``context_facts_sql`` is the single membership law, shared
with search scope; membership is direct and never traverses another chat. Mutations
only flush.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, ResourceEdge
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.edges import (
    EdgeCreate,
    conversation_rank,
    create_edge,
    delete_edge,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, assert_resource_ref
from nexus.services.resource_graph.resolve import ResolvedResource, resolve_refs
from nexus.services.resource_items.capabilities import resource_can_attach
from nexus.services.resource_items.routing import resource_activations_for_refs


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
               v.order_key
        FROM resource_edges e
        LEFT JOIN resource_view_states v
          ON v.edge_id = e.id AND v.user_id = e.user_id
         AND v.surface_scheme = 'conversation' AND v.surface_id = {conversation_id_sql}
        WHERE e.user_id = :viewer_id AND e.origin = 'user'
          AND (({chat})
            OR (e.target_scheme = 'conversation' AND e.target_id = {conversation_id_sql}))
        UNION ALL
        SELECT e.id AS edge_id, e.created_at, e.target_scheme, e.target_id,
               e.source_order_key AS order_key
        FROM resource_edges e
        WHERE e.user_id = :viewer_id AND e.origin IN ('citation', 'system')
          AND e.ordinal IS NULL AND {chat}
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
) -> ContextRefOut | None:
    """Attach ``target`` automatically at the next rank, under the chat's lock; ``None``
    when it is already a member."""
    _owned_chat(db, viewer_id, conversation_id)
    if not resource_can_attach(target):
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
    return _context_refs(db, viewer_id, conversation_id, [(edge.id, edge.created_at, target)])[0]


def remove_context_ref(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, edge_id: UUID
) -> None:
    """Detach one automatic fact of the chat; a user link is removed as a link."""
    _owned_chat(db, viewer_id, conversation_id)
    edge = db.get(ResourceEdge, edge_id)
    if (
        edge is None
        or edge.user_id != viewer_id
        or edge.origin not in ("citation", "system")
        or edge.ordinal is not None
        or (edge.source_scheme, edge.source_id) != ("conversation", conversation_id)
    ):
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context ref not found")
    delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)


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
