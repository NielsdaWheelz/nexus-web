"""Read-only structure queries for graph-backed note documents."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, NoteViewState, ResourceEdge
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme


@dataclass(frozen=True, slots=True)
class BlockOccurrence:
    block: NoteBlock
    page_id: UUID
    parent: ResourceRef
    source_order_key: str
    collapsed: bool


def find_block_occurrence(db: Session, *, user_id: UUID, block_id: UUID) -> BlockOccurrence:
    block = db.scalar(select(NoteBlock).where(NoteBlock.id == block_id, NoteBlock.user_id == user_id))
    if block is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    edge = db.scalar(
        select(ResourceEdge)
        .where(
            ResourceEdge.user_id == user_id,
            ResourceEdge.origin == "note_containment",
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == block_id,
        )
        .order_by(
            ResourceEdge.source_scheme.asc(),
            ResourceEdge.created_at.asc(),
            ResourceEdge.id.asc(),
        )
    )
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block occurrence not found")

    parent = ResourceRef(scheme=cast(ResourceScheme, edge.source_scheme), id=edge.source_id)
    page_id = page_id_for_parent(db, user_id=user_id, parent=parent, seen={block_id})
    collapsed = collapsed_for_occurrence(db, user_id=user_id, parent=parent, block_id=block_id)
    return BlockOccurrence(
        block=block,
        page_id=page_id,
        parent=parent,
        source_order_key=edge.source_order_key or "",
        collapsed=collapsed,
    )


def page_id_for_parent(
    db: Session, *, user_id: UUID, parent: ResourceRef, seen: set[UUID]
) -> UUID:
    if parent.scheme == "page":
        return parent.id
    if parent.id in seen:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Note containment cycle detected")
    edge = db.scalar(
        select(ResourceEdge)
        .where(
            ResourceEdge.user_id == user_id,
            ResourceEdge.origin == "note_containment",
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == parent.id,
        )
        .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
    )
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block occurrence not found")
    return page_id_for_parent(
        db,
        user_id=user_id,
        parent=ResourceRef(scheme=cast(ResourceScheme, edge.source_scheme), id=edge.source_id),
        seen={*seen, parent.id},
    )


def collapsed_for_occurrence(
    db: Session, *, user_id: UUID, parent: ResourceRef, block_id: UUID
) -> bool:
    row = db.scalar(
        select(NoteViewState).where(
            NoteViewState.user_id == user_id,
            NoteViewState.context_source_scheme == parent.scheme,
            NoteViewState.context_source_id == parent.id,
            NoteViewState.target_block_id == block_id,
        )
    )
    return bool(row.collapsed) if row is not None else False
