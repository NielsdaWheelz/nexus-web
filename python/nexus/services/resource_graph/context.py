"""Conversation context: thin views over edges with ``source_scheme='conversation'`` (§9.4).

Admission and search-scope semantics live here, in code, not in schema:

- the context surface lists/removes ``kind=context`` edges (§5.1);
- admission (``is_context_ref``) and the reverse lookup accept conversation
  context edges; search-scope discovery narrows to bare context refs;
- ``app_search`` may scope only to ``media:``/``library:`` targets.

Mutators are flush-only (§9.0); committing wrappers belong to the routes.
Pagination mirrors ``nexus.services.conversations`` cursor shape, kept local so
this module does not depend on conversation list internals.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import Conversation, ResourceEdge
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.schemas.conversation import ConversationOut, PageInfo
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import (
    SEARCH_SCOPE_SCHEMES,
    ResourceRef,
    ResourceScheme,
)
from nexus.services.resource_graph.resolve import ResolvedResource, resolve_ref, resolve_refs
from nexus.services.resource_graph.schemas import EdgeCreate, EdgeOrigin

_DEFAULT_LIMIT = 50
_MIN_LIMIT = 1
_MAX_LIMIT = 100


@dataclass(frozen=True, slots=True)
class ContextRefOut:
    """One context edge plus its hydrated target, for API and SSE payloads."""

    edge_id: UUID
    conversation_id: UUID
    target: ResourceRef
    origin: EdgeOrigin
    resolved: ResolvedResource
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
            .where(
                ResourceEdge.source_scheme == "conversation",
                ResourceEdge.source_id == conversation_id,
                ResourceEdge.kind == "context",
            )
            .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
        )
        .scalars()
        .all()
    )
    targets = [_edge_target(row) for row in rows]
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=targets)
    return [
        _context_ref_out(row, target, res)
        for row, target, res in zip(rows, targets, resolved, strict=True)
    ]


def add_context_ref_without_commit(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    target: ResourceRef,
    origin: EdgeOrigin,
) -> ContextRefOut:
    """Add a context edge inside the caller's transaction (conversation create composes).

    Idempotent: an existing bare edge for the pair is returned as-is, so
    citation write-through and repeated attaches never double-insert.
    """
    _require_owner(db, viewer_id, conversation_id)
    resolved = resolve_ref(db, viewer_id=viewer_id, ref=target)
    if resolved.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    existing = db.execute(
        select(ResourceEdge).where(
            ResourceEdge.source_scheme == "conversation",
            ResourceEdge.source_id == conversation_id,
            ResourceEdge.target_scheme == target.scheme,
            ResourceEdge.target_id == target.id,
            ResourceEdge.ordinal.is_(None),
        )
    ).scalar_one_or_none()
    if existing is not None:
        return _context_ref_out(existing, target, resolved)

    created = create_edge(
        db,
        viewer_id=viewer_id,
        input=EdgeCreate(
            source=ResourceRef(scheme="conversation", id=conversation_id),
            target=target,
            kind="context",
            origin=origin,
        ),
    )
    return ContextRefOut(
        edge_id=created.id,
        conversation_id=conversation_id,
        target=target,
        origin=origin,
        resolved=resolved,
        created_at=created.created_at,
    )


def remove_context_ref(
    db: Session, *, viewer_id: UUID, conversation_id: UUID, edge_id: UUID
) -> None:
    _require_owner(db, viewer_id, conversation_id)
    row = db.execute(
        select(ResourceEdge).where(
            ResourceEdge.id == edge_id,
            ResourceEdge.source_scheme == "conversation",
            ResourceEdge.source_id == conversation_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context ref not found")
    db.delete(row)
    db.flush()


def is_context_ref(db: Session, *, conversation_id: UUID, target: ResourceRef) -> bool:
    """ANY edge from the conversation to the target admits (any kind, any origin).

    No owner check: callers are chat tools already authorized for the
    conversation upstream.
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


def list_conversations_with_context_ref(
    db: Session,
    *,
    viewer_id: UUID,
    target: ResourceRef,
    limit: int = _DEFAULT_LIMIT,
    cursor: str | None = None,
) -> ConversationPage:
    """Conversations owned by the viewer with any edge to ``target`` (reverse lookup).

    Single-user system: only viewer-owned conversations are returned. Cursor and
    ordering mirror ``nexus.services.conversations.list_conversations``.
    """
    limit = min(max(limit, _MIN_LIMIT), _MAX_LIMIT)
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "target_scheme": target.scheme,
        "target_id": target.id,
        "limit": limit + 1,
    }
    cursor_clause, cursor_params = _decode_cursor_clause(cursor)
    params.update(cursor_params)

    rows = db.execute(
        text(f"""
            SELECT c.id, c.owner_user_id, c.title, c.sharing, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)
                       AS message_count
            FROM conversations c
            WHERE c.owner_user_id = :viewer_id
              AND EXISTS (
                  SELECT 1
                  FROM resource_edges e
                  WHERE e.source_scheme = 'conversation'
                    AND e.source_id = c.id
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
    if has_more:
        rows = rows[:limit]

    conversations = [
        ConversationOut(
            id=row[0],
            owner_user_id=row[1],
            title=row[2],
            is_owner=True,
            sharing=row[3],
            message_count=row[6],
            created_at=row[4],
            updated_at=row[5],
        )
        for row in rows
    ]

    next_cursor = None
    if has_more and conversations:
        last = conversations[-1]
        next_cursor = _encode_cursor(last.updated_at, last.id)

    return ConversationPage(conversations=conversations, page=PageInfo(next_cursor=next_cursor))


def batch_conversations_with_context_ref(
    db: Session, *, viewer_id: UUID, targets: list[UUID], target_scheme: ResourceScheme
) -> dict[UUID, list[Conversation]]:
    """Reverse lookup batched over many targets of one scheme (the §9.4 owner of
    ``highlights._batch_linked_conversations``).

    Same admission as ``list_conversations_with_context_ref`` — any edge from a
    viewer-owned conversation to the target counts — but keyed by target id and
    joined to the conversation row so callers project their own ref shape. Kept
    here, not on the generic connection query, because it needs the conversation join
    and the per-target batching.
    """
    if not targets:
        return {}
    rows = db.execute(
        select(ResourceEdge.target_id, Conversation)
        .join(Conversation, Conversation.id == ResourceEdge.source_id)
        .where(
            ResourceEdge.source_scheme == "conversation",
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


def search_scope_refs_for_conversation(
    db: Session, *, viewer_id: UUID, conversation_id: UUID
) -> list[ResourceRef]:
    """The conversation's ``media:``/``library:`` edge targets, first-attached order."""
    rows = db.execute(
        select(ResourceEdge.target_scheme, ResourceEdge.target_id)
        .join(Conversation, Conversation.id == ResourceEdge.source_id)
        .where(
            ResourceEdge.source_scheme == "conversation",
            ResourceEdge.source_id == conversation_id,
            ResourceEdge.target_scheme.in_(SEARCH_SCOPE_SCHEMES),
            ResourceEdge.kind == "context",
            ResourceEdge.origin.in_(("user", "citation", "system")),
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.ordinal.is_(None),
            Conversation.owner_user_id == viewer_id,
        )
        .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
    ).all()
    out: list[ResourceRef] = []
    seen: set[tuple[str, UUID]] = set()
    for scheme, resource_id in rows:
        if (scheme, resource_id) in seen:
            continue
        seen.add((scheme, resource_id))
        out.append(ResourceRef(scheme=cast("ResourceScheme", scheme), id=resource_id))
    return out


# ---------- internals ---------------------------------------------------------


def _require_owner(db: Session, viewer_id: UUID, conversation_id: UUID) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or not can_read_conversation(db, viewer_id, conversation_id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if conversation.owner_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Owner required")
    return conversation


def _edge_target(row: ResourceEdge) -> ResourceRef:
    return ResourceRef(scheme=cast("ResourceScheme", row.target_scheme), id=row.target_id)


def _context_ref_out(
    row: ResourceEdge, target: ResourceRef, resolved: ResolvedResource
) -> ContextRefOut:
    return ContextRefOut(
        edge_id=row.id,
        conversation_id=row.source_id,
        target=target,
        origin=cast("EdgeOrigin", row.origin),
        resolved=resolved,
        created_at=row.created_at,
    )


def _decode_cursor_clause(cursor: str | None) -> tuple[str, dict[str, object]]:
    """Decode a conversation cursor into a SQL fragment + bound params."""
    if not cursor:
        return "", {}
    try:
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(cursor).decode("utf-8"))
        updated_at = datetime.fromisoformat(payload["updated_at"])
        conversation_id = UUID(payload["id"])
    except (ValueError, KeyError, TypeError):
        # justify-ignore-error: expected malformed-cursor failures from the
        # base64url/JSON decode and primitive parsing path. Other exceptions
        # propagate.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None
    return (
        "AND (c.updated_at, c.id) < (:cursor_updated_at, :cursor_id)",
        {"cursor_updated_at": updated_at, "cursor_id": conversation_id},
    )


def _encode_cursor(updated_at: datetime, conversation_id: UUID) -> str:
    payload = json.dumps({"updated_at": updated_at.isoformat(), "id": str(conversation_id)})
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")
