"""Ordered resource adjacency over resource_edges."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceViewState
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.capabilities import (
    resource_can_be_ordered_adjacency_target,
    resource_can_own_ordered_adjacency,
)


@dataclass(frozen=True, slots=True)
class OrderedTarget:
    target: ResourceRef
    source_order_key: str


@dataclass(slots=True)
class SurfaceNote:
    block: NoteBlock
    parent: ResourceRef
    source_order_key: str
    collapsed: bool
    children: list[SurfaceNote] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class PageSurface:
    page: Page
    roots: list[SurfaceNote]

    @property
    def block_ids(self) -> list[UUID]:
        out: list[UUID] = []

        def walk(node: SurfaceNote) -> None:
            out.append(node.block.id)
            for child in node.children:
                walk(child)

        for root in self.roots:
            walk(root)
        return out


def load_page_surface(db: Session, *, user_id: UUID, page_id: UUID) -> PageSurface:
    page = db.scalar(select(Page).where(Page.id == page_id, Page.user_id == user_id))
    if page is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    return PageSurface(
        page=page,
        roots=_note_children(
            db, user_id=user_id, parent=ResourceRef(scheme="page", id=page.id), path=set()
        ),
    )


def list_page_note_block_ids(db: Session, *, user_id: UUID, page_id: UUID) -> list[UUID]:
    return load_page_surface(db, user_id=user_id, page_id=page_id).block_ids


def replace_ordered_targets(
    db: Session,
    *,
    user_id: UUID,
    source: ResourceRef,
    targets: Sequence[OrderedTarget],
) -> list[UUID]:
    _assert_source_visible(db, user_id=user_id, source=source)
    if not resource_can_own_ordered_adjacency(source):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own ordered adjacency")
    seen_order: set[str] = set()
    seen_targets: set[tuple[str, UUID]] = set()
    for target in targets:
        if target.source_order_key in seen_order:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Adjacent items need unique order keys")
        seen_order.add(target.source_order_key)
        # The broad ordinal-null pair index is gone (it collided ordered edges
        # with neutral Links); a repeated target ref in one set is now rejected
        # in application validation so outline semantics do not weaken.
        target_key = (target.target.scheme, target.target.id)
        if target_key in seen_targets:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Adjacent items must be distinct")
        seen_targets.add(target_key)
        _assert_target_visible(db, user_id=user_id, target=target.target)
        if not resource_can_be_ordered_adjacency_target(target.target):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be an ordered target")

    existing = ordered_edges(db, user_id=user_id, source=source)
    by_target = {(edge.target_scheme, edge.target_id): edge for edge in existing}
    requested = {(target.target.scheme, target.target.id) for target in targets}
    removed = [edge for edge in existing if (edge.target_scheme, edge.target_id) not in requested]
    if removed:
        db.execute(
            delete(ResourceViewState).where(
                ResourceViewState.edge_id.in_([edge.id for edge in removed])
            )
        )
        for edge in removed:
            db.delete(edge)
        db.flush()

    ordered: list[ResourceEdge] = []
    for target in targets:
        edge = by_target.get((target.target.scheme, target.target.id))
        if edge is None:
            edge = ResourceEdge(
                user_id=user_id,
                kind="context",
                origin="user",
                source_scheme=source.scheme,
                source_id=source.id,
                target_scheme=target.target.scheme,
                target_id=target.target.id,
                source_order_key=f"pending:{target.target.id}",
            )
            db.add(edge)
            db.flush()
        ordered.append(edge)
    reorder_ordered_edges(db, user_id=user_id, source=source, edges=ordered)
    return [edge.id for edge in ordered]


def ordered_edges(db: Session, *, user_id: UUID, source: ResourceRef) -> list[ResourceEdge]:
    return list(
        db.scalars(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "user",
                ResourceEdge.kind == "context",
                ResourceEdge.source_scheme == source.scheme,
                ResourceEdge.source_id == source.id,
                ResourceEdge.source_order_key.is_not(None),
                ResourceEdge.ordinal.is_(None),
                ResourceEdge.snapshot.is_(None),
            )
            .order_by(ResourceEdge.source_order_key.asc(), ResourceEdge.id.asc())
        ).all()
    )


def insert_ordered_target(
    db: Session,
    *,
    user_id: UUID,
    source: ResourceRef,
    target: ResourceRef,
) -> ResourceEdge:
    _assert_source_visible(db, user_id=user_id, source=source)
    if not resource_can_own_ordered_adjacency(source):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own ordered adjacency")
    _assert_target_visible(db, user_id=user_id, target=target)
    if not resource_can_be_ordered_adjacency_target(target):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be an ordered target")
    if source == target:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "A resource cannot be adjacent to itself")
    if any(
        edge.target_scheme == target.scheme and edge.target_id == target.id
        for edge in ordered_edges(db, user_id=user_id, source=source)
    ):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Adjacent items must be distinct")
    edge = ResourceEdge(
        user_id=user_id,
        kind="context",
        origin="user",
        source_scheme=source.scheme,
        source_id=source.id,
        target_scheme=target.scheme,
        target_id=target.id,
        source_order_key=f"pending:{target.id}",
    )
    db.add(edge)
    db.flush()
    return edge


def remove_ordered_edge(
    db: Session,
    *,
    user_id: UUID,
    source: ResourceRef,
    occurrence_id: UUID,
) -> ResourceEdge:
    edge = ordered_edge_for_occurrence(
        db, user_id=user_id, source=source, occurrence_id=occurrence_id
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id == edge.id))
    db.delete(edge)
    db.flush()
    return edge


def ordered_edge_for_occurrence(
    db: Session,
    *,
    user_id: UUID,
    source: ResourceRef,
    occurrence_id: UUID,
) -> ResourceEdge:
    edge = db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.id == occurrence_id,
            ResourceEdge.user_id == user_id,
            ResourceEdge.origin == "user",
            ResourceEdge.kind == "context",
            ResourceEdge.source_scheme == source.scheme,
            ResourceEdge.source_id == source.id,
            ResourceEdge.source_order_key.is_not(None),
            ResourceEdge.ordinal.is_(None),
            ResourceEdge.snapshot.is_(None),
        )
    )
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Surface occurrence not found")
    return edge


def reorder_ordered_edges(
    db: Session,
    *,
    user_id: UUID,
    source: ResourceRef,
    edges: Sequence[ResourceEdge],
) -> None:
    current = ordered_edges(db, user_id=user_id, source=source)
    if {edge.id for edge in current} != {edge.id for edge in edges} or len(current) != len(edges):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Ordered occurrences must match the surface")
    if len({edge.id for edge in edges}) != len(edges):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Ordered occurrences must be unique")
    # The database enforces unique source keys. Temporary keys let every surviving
    # occurrence keep its identity (and attached view state) while moving.
    for edge in current:
        edge.source_order_key = f"reordering:{edge.id}"
    db.flush()
    for index, edge in enumerate(edges, start=1):
        edge.source_order_key = f"{index:010d}"
    db.flush()


def set_collapsed(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    block_id: UUID,
    collapsed: bool,
) -> None:
    edge = _edge_for_child(db, user_id=user_id, parent=parent, block_id=block_id)
    row = db.scalar(
        select(ResourceViewState).where(
            ResourceViewState.user_id == user_id,
            ResourceViewState.surface_scheme == parent.scheme,
            ResourceViewState.surface_id == parent.id,
            ResourceViewState.edge_id == edge.id,
            ResourceViewState.target_scheme == "note_block",
            ResourceViewState.target_id == block_id,
        )
    )
    state: dict[str, object] = {"collapsed": collapsed}
    if row is None:
        db.add(
            ResourceViewState(
                user_id=user_id,
                surface_scheme=parent.scheme,
                surface_id=parent.id,
                edge_id=edge.id,
                target_scheme="note_block",
                target_id=block_id,
                state=state,
            )
        )
        db.flush()
        return
    row.state = state
    db.flush()


def _note_children(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    path: set[UUID],
) -> list[SurfaceNote]:
    out: list[SurfaceNote] = []
    for edge, block in _ordered_note_rows(db, user_id=user_id, parent=parent):
        collapsed = _collapsed_for_edge(db, user_id=user_id, edge=edge)
        children: list[SurfaceNote] = []
        if block.id not in path:
            children = _note_children(
                db,
                user_id=user_id,
                parent=ResourceRef(scheme="note_block", id=block.id),
                path={*path, block.id},
            )
        out.append(
            SurfaceNote(
                block=block,
                parent=parent,
                source_order_key=edge.source_order_key or "",
                collapsed=collapsed,
                children=children,
            )
        )
    return out


def _ordered_note_rows(
    db: Session, *, user_id: UUID, parent: ResourceRef
) -> list[tuple[ResourceEdge, NoteBlock]]:
    return list(
        db.execute(
            select(ResourceEdge, NoteBlock)
            .join(
                NoteBlock,
                (ResourceEdge.target_scheme == "note_block")
                & (ResourceEdge.target_id == NoteBlock.id),
            )
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "user",
                ResourceEdge.source_scheme == parent.scheme,
                ResourceEdge.source_id == parent.id,
                ResourceEdge.source_order_key.is_not(None),
                NoteBlock.user_id == user_id,
            )
            .order_by(ResourceEdge.source_order_key.asc(), ResourceEdge.id.asc())
        )
        .tuples()
        .all()
    )


def _edge_for_child(
    db: Session, *, user_id: UUID, parent: ResourceRef, block_id: UUID
) -> ResourceEdge:
    edge = db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.user_id == user_id,
            ResourceEdge.origin == "user",
            ResourceEdge.source_scheme == parent.scheme,
            ResourceEdge.source_id == parent.id,
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == block_id,
            ResourceEdge.source_order_key.is_not(None),
        )
    )
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Adjacent note not found")
    return edge


def _collapsed_for_edge(db: Session, *, user_id: UUID, edge: ResourceEdge) -> bool:
    row = db.scalar(
        select(ResourceViewState).where(
            ResourceViewState.user_id == user_id,
            ResourceViewState.edge_id == edge.id,
        )
    )
    if row is None:
        return False
    return bool(row.state.get("collapsed"))


def _assert_source_visible(db: Session, *, user_id: UUID, source: ResourceRef) -> None:
    from nexus.services.resource_graph.resolve import assert_ref_visible

    assert_ref_visible(db, viewer_id=user_id, ref=source)


def _assert_target_visible(db: Session, *, user_id: UUID, target: ResourceRef) -> None:
    from nexus.services.resource_graph.resolve import assert_ref_visible

    assert_ref_visible(db, viewer_id=user_id, ref=target)
