"""Direct conversation context: neutral user links plus citation/system attachments.

This projection owns prompt, admission, search and reverse-lookup membership.
It never traverses another conversation's connections. Mutations only flush.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import Conversation, ResourceEdge
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.schemas.conversation import ConversationOut, PageInfo
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.keyset_cursor import (
    KeysetValue,
    KeysetValueKind,
    decode_keyset_cursor,
    encode_keyset_cursor,
)
from nexus.services.resource_graph.edges import (
    conversation_link_order_key,
    create_edge,
    delete_edge,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import ResolvedResource, resolve_ref, resolve_refs
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_items.capabilities import (
    resource_can_attach,
)
from nexus.services.resource_items.routing import resource_activation_for_ref


@dataclass(frozen=True, slots=True)
class ContextRefOut:
    """One context edge plus its hydrated target, for the API and SSE payloads."""

    edge_id: UUID
    conversation_id: UUID
    target: ResourceRef
    resolved: ResolvedResource
    activation: ResourceActivationOut
    created_at: datetime


@dataclass(frozen=True, slots=True)
class ConversationPage:
    conversations: list[ConversationOut]
    page: PageInfo


def context_facts_sql(conversation_id_sql: str = ":conversation_id") -> str:
    """Direct facts, with canonical user pairs projected from either endpoint.

    ``conversation_id_sql`` is a caller-owned SQL expression, never input text.
    ``viewer_id`` is bound by every caller. This is also the search membership law.
    """
    return f"""
        SELECT e.id AS edge_id, e.created_at,
               CASE WHEN e.source_scheme = 'conversation' AND e.source_id = {conversation_id_sql}
                    THEN e.target_scheme ELSE e.source_scheme END AS target_scheme,
               CASE WHEN e.source_scheme = 'conversation' AND e.source_id = {conversation_id_sql}
                    THEN e.target_id ELSE e.source_id END AS target_id,
               v.order_key
        FROM resource_edges e
        LEFT JOIN resource_view_states v
          ON v.edge_id = e.id AND v.user_id = e.user_id
         AND v.surface_scheme = 'conversation' AND v.surface_id = {conversation_id_sql}
        WHERE e.user_id = :viewer_id AND e.origin = 'user' AND e.kind = 'context'
          AND e.ordinal IS NULL AND e.snapshot IS NULL AND e.source_order_key IS NULL
          AND ((e.source_scheme = 'conversation' AND e.source_id = {conversation_id_sql})
            OR (e.target_scheme = 'conversation' AND e.target_id = {conversation_id_sql}))
        UNION ALL
        SELECT e.id AS edge_id, e.created_at, e.target_scheme, e.target_id, e.source_order_key AS order_key
        FROM resource_edges e
        WHERE e.user_id = :viewer_id AND e.origin IN ('citation', 'system')
          AND e.source_scheme = 'conversation' AND e.source_id = {conversation_id_sql}
          AND e.kind = 'context' AND e.ordinal IS NULL AND e.snapshot IS NULL
    """


def list_context_refs(
    db: Session, *, viewer_id: UUID, conversation_id: UUID
) -> list[ContextRefOut]:
    """One target per direct attachment, in its stable first-attached position."""
    _require_owner(db, viewer_id, conversation_id)
    rows = (
        db.execute(
            text(f"""
        SELECT * FROM (
            SELECT DISTINCT ON (target_scheme, target_id) *
            FROM ({context_facts_sql()}) facts
            ORDER BY target_scheme, target_id, order_key ASC NULLS LAST, created_at, edge_id
        ) targets
        ORDER BY order_key ASC NULLS LAST, created_at, edge_id
    """),
            {"viewer_id": viewer_id, "conversation_id": conversation_id},
        )
        .mappings()
        .all()
    )
    targets = [
        ResourceRef(scheme=cast(ResourceScheme, row["target_scheme"]), id=row["target_id"])
        for row in rows
    ]
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=targets)
    return [
        ContextRefOut(
            edge_id=row["edge_id"],
            conversation_id=conversation_id,
            target=target,
            resolved=item,
            activation=resource_activation_for_ref(
                db, viewer_id=viewer_id, ref=target, missing=item.missing
            ),
            created_at=row["created_at"],
        )
        for row, target, item in zip(rows, targets, resolved, strict=True)
    ]


def add_context_ref_without_commit(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    target: ResourceRef,
    origin: Literal["citation", "system"],
) -> ContextRefOut:
    """Add one context edge inside the caller's transaction, idempotent per target."""
    _require_owner(db, viewer_id, conversation_id)
    if not resource_can_attach(target):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be attached to conversation context"
        )
    resolved = resolve_ref(db, viewer_id=viewer_id, ref=target)
    if resolved.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    if origin not in ("citation", "system"):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Only automatic context facts use this command"
        )
    order_key = conversation_link_order_key(
        db, viewer_id=viewer_id, conversation_id=conversation_id, target=target
    )
    existing = next(
        (
            item
            for item in list_context_refs(db, viewer_id=viewer_id, conversation_id=conversation_id)
            if item.target == target
        ),
        None,
    )
    if existing is not None:
        return existing

    created = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(
            source=ResourceRef(scheme="conversation", id=conversation_id),
            target=target,
            kind="context",
            origin=origin,
            source_order_key=order_key,
        ),
    )
    return ContextRefOut(
        edge_id=created.id,
        conversation_id=conversation_id,
        target=target,
        resolved=resolved,
        activation=resource_activation_for_ref(
            db, viewer_id=viewer_id, ref=target, missing=resolved.missing
        ),
        created_at=created.created_at,
    )


def remove_context_ref(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, edge_id: UUID
) -> None:
    _require_owner(db, viewer_id, conversation_id)
    row = db.execute(
        select(ResourceEdge).where(
            ResourceEdge.id == edge_id,
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.source_scheme == "conversation",
            ResourceEdge.source_id == conversation_id,
            ResourceEdge.kind == "context",
            ResourceEdge.origin.in_(("citation", "system")),
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context ref not found")
    delete_edge(db, viewer_id=viewer_id, edge_id=row.id)


def admits_resource_for_conversation_read(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, target: ResourceRef
) -> bool:
    """Membership only; callers separately authorize the conversation and resource."""
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


def list_conversations_with_any_edge_to_ref(
    db: Session,
    *,
    viewer_id: UUID,
    target: ResourceRef,
    limit: int = 50,
    cursor: str | None = None,
) -> ConversationPage:
    """The viewer's conversations with any edge to ``target``, newest activity first."""
    limit = min(max(limit, 1), 100)
    cursor_query = {
        "viewerId": str(viewer_id),
        "targetScheme": target.scheme,
        "targetId": str(target.id),
    }
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "target_scheme": target.scheme,
        "target_id": target.id,
        "limit": limit + 1,
    }
    cursor_clause = ""
    if cursor:
        updated_at, conversation_id = decode_keyset_cursor(
            cursor,
            family="ConversationContext",
            query=cursor_query,
            expected_kinds=(KeysetValueKind.DateTime, KeysetValueKind.Uuid),
        )
        cursor_clause = "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)"
        params |= {"cursor_updated_at": updated_at, "cursor_id": conversation_id}

    rows = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
                       AS message_count
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
              AND EXISTS (
                  SELECT 1 FROM ({context_facts_sql("c.id")}) facts
                  WHERE facts.target_scheme = :target_scheme AND facts.target_id = :target_id
              )
              {cursor_clause}
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT :limit
        """),
        params,
    ).fetchall()

    has_more = len(rows) > limit
    conversations = [
        ConversationOut(
            id=row[0],
            owner_user_id=row[1],
            title=row[2],
            is_owner=True,
            message_count=row[5],
            created_at=row[3],
            updated_at=row[4],
        )
        for row in rows[:limit]
    ]
    next_cursor = None
    if has_more and conversations:
        next_cursor = encode_keyset_cursor(
            family="ConversationContext",
            query=cursor_query,
            after=(
                KeysetValue(KeysetValueKind.DateTime, conversations[-1].updated_at),
                KeysetValue(KeysetValueKind.Uuid, conversations[-1].id),
            ),
        )
    return ConversationPage(conversations=conversations, page=PageInfo(next_cursor=next_cursor))


def batch_conversations_with_any_edge_to_ref(
    db: Session, *, viewer_id: UUID, targets: list[UUID], target_scheme: ResourceScheme
) -> dict[UUID, list[Conversation]]:
    """The same reverse lookup keyed by target id, joined to the conversation row."""
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
    conversations = {
        row.id: row
        for row in db.scalars(
            select(Conversation).where(Conversation.id.in_({row[1] for row in rows}))
        )
    }
    result: dict[UUID, list[Conversation]] = {}
    for target_id, conversation_id in rows:
        result.setdefault(target_id, []).append(conversations[conversation_id])
    return result


def _require_owner(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if conversation.owner_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Owner required")
