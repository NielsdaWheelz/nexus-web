"""Conversation context: the edges whose source is a conversation.

The context surface lists, adds and removes bare ``kind=context`` edges under one
attached-context slot per target (user, citation and system origins share it). Read
admission and the reverse lookups accept any conversation edge to the target. Mutators
are flush-only; the routes commit.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast
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
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import ResolvedResource, resolve_ref, resolve_refs
from nexus.services.resource_graph.schemas import EdgeCreate, EdgeOrigin
from nexus.services.resource_items.capabilities import (
    CONVERSATION_CONTEXT_EDGE_ORIGINS,
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


def list_context_refs(
    db: Session, *, viewer_id: UUID, conversation_id: UUID
) -> list[ContextRefOut]:
    _require_owner(db, viewer_id, conversation_id)
    rows = (
        db.execute(
            select(ResourceEdge)
            .where(*_context_edge_predicates(viewer_id, conversation_id))
            .order_by(
                ResourceEdge.source_order_key.asc().nulls_last(),
                ResourceEdge.created_at.asc(),
                ResourceEdge.id.asc(),
            )
        )
        .scalars()
        .all()
    )
    targets = [
        ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)
        for row in rows
    ]
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=targets)
    return [
        _context_ref_out(db, viewer_id=viewer_id, row=row, target=target, resolved=item)
        for row, target, item in zip(rows, targets, resolved, strict=True)
    ]


def add_context_ref_without_commit(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    target: ResourceRef,
    origin: EdgeOrigin,
    source_order_key: str | None = None,
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

    existing = db.execute(
        select(ResourceEdge).where(
            *_context_edge_predicates(viewer_id, conversation_id),
            ResourceEdge.target_scheme == target.scheme,
            ResourceEdge.target_id == target.id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return _context_ref_out(
            db, viewer_id=viewer_id, row=existing, target=target, resolved=resolved
        )

    created = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(
            source=ResourceRef(scheme="conversation", id=conversation_id),
            target=target,
            kind="context",
            origin=origin,
            source_order_key=source_order_key
            or _next_source_order_key(db, viewer_id=viewer_id, conversation_id=conversation_id),
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
            ResourceEdge.id == edge_id, *_context_edge_predicates(viewer_id, conversation_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context ref not found")
    db.delete(row)
    db.flush()


def admits_resource_for_conversation_read(
    db: Session, *, conversation_id: UUID, target: ResourceRef
) -> bool:
    """ANY edge from the conversation to the target admits it, whatever kind or origin.

    No owner check: the callers are chat tools already authorized for the conversation.
    """
    return (
        db.execute(
            select(ResourceEdge.id)
            .where(
                ResourceEdge.source_scheme == "conversation",
                ResourceEdge.source_id == conversation_id,
                ResourceEdge.target_scheme == target.scheme,
                ResourceEdge.target_id == target.id,
            )
            .limit(1)
        ).scalar_one_or_none()
        is not None
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
                  SELECT 1
                  FROM resource_edges e
                  WHERE e.source_scheme = 'conversation'
                    AND e.source_id = c.id
                    AND e.user_id = :viewer_id
                    AND e.target_scheme = :target_scheme
                    AND e.target_id = :target_id
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
        select(ResourceEdge.target_id, Conversation)
        .join(Conversation, Conversation.id == ResourceEdge.source_id)
        .where(
            ResourceEdge.source_scheme == "conversation",
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.target_scheme == target_scheme,
            ResourceEdge.target_id.in_(targets),
            Conversation.owner_user_id == viewer_id,
        )
        .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
    ).all()
    result: dict[UUID, list[Conversation]] = {}
    for target_id, conversation in rows:
        result.setdefault(target_id, []).append(conversation)
    return result


def _context_edge_predicates(viewer_id: UUID, conversation_id: UUID) -> tuple[Any, ...]:
    return (
        ResourceEdge.user_id == viewer_id,
        ResourceEdge.source_scheme == "conversation",
        ResourceEdge.source_id == conversation_id,
        ResourceEdge.kind == "context",
        ResourceEdge.origin.in_(CONVERSATION_CONTEXT_EDGE_ORIGINS),
        ResourceEdge.ordinal.is_(None),
    )


def _require_owner(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if conversation.owner_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Owner required")


def _context_ref_out(
    db: Session,
    *,
    viewer_id: UUID,
    row: ResourceEdge,
    target: ResourceRef,
    resolved: ResolvedResource,
) -> ContextRefOut:
    return ContextRefOut(
        edge_id=row.id,
        conversation_id=row.source_id,
        target=target,
        resolved=resolved,
        activation=resource_activation_for_ref(
            db, viewer_id=viewer_id, ref=target, missing=resolved.missing
        ),
        created_at=row.created_at,
    )


def _next_source_order_key(db: Session, *, viewer_id: UUID, conversation_id: UUID) -> str:
    existing = db.execute(
        select(ResourceEdge.source_order_key)
        .where(
            *_context_edge_predicates(viewer_id, conversation_id),
            ResourceEdge.source_order_key.is_not(None),
        )
        .order_by(ResourceEdge.source_order_key.desc())
        .limit(1)
    ).scalar_one_or_none()
    return "0000000001" if existing is None else f"{int(existing) + 1:010d}"
