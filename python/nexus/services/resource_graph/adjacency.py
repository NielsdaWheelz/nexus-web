"""Ordered resource adjacency over resource_edges."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceViewState
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
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


def find_surface_note(surface: PageSurface, block_id: UUID) -> SurfaceNote | None:
    def walk(node: SurfaceNote) -> SurfaceNote | None:
        if node.block.id == block_id:
            return node
        for child in node.children:
            found = walk(child)
            if found is not None:
                return found
        return None

    for root in surface.roots:
        found = walk(root)
        if found is not None:
            return found
    return None


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

    old_edges = select(ResourceEdge.id).where(
        ResourceEdge.user_id == user_id,
        ResourceEdge.origin == "user",
        ResourceEdge.source_scheme == source.scheme,
        ResourceEdge.source_id == source.id,
        ResourceEdge.source_order_key.is_not(None),
    )
    db.execute(delete(ResourceViewState).where(ResourceViewState.edge_id.in_(old_edges)))
    db.execute(
        delete(ResourceEdge).where(
            ResourceEdge.user_id == user_id,
            ResourceEdge.origin == "user",
            ResourceEdge.source_scheme == source.scheme,
            ResourceEdge.source_id == source.id,
            ResourceEdge.source_order_key.is_not(None),
        )
    )

    out: list[UUID] = []
    for target in targets:
        # A neutral Link on this same pair is NOT deleted: an ordered occurrence
        # (source_order_key set) and a neutral Link (order keys null) now live
        # under separate unique indexes and coexist (§ Graph Shapes). Deleting it
        # here was a live data-loss bug.
        edge = ResourceEdge(
            user_id=user_id,
            kind="context",
            origin="user",
            source_scheme=source.scheme,
            source_id=source.id,
            target_scheme=target.target.scheme,
            target_id=target.target.id,
            source_order_key=target.source_order_key,
        )
        db.add(edge)
        db.flush()
        out.append(edge.id)
    return out


def apply_note_surface(
    db: Session,
    *,
    user_id: UUID,
    previous_sources: Iterable[ResourceRef],
    children_by_source: Mapping[ResourceRef, Sequence[OrderedTarget]],
    collapsed_by_block_id: dict[UUID, bool],
    deleted_block_ids: set[UUID],
) -> list[UUID]:
    for source in sorted(previous_sources, key=lambda item: (item.scheme, str(item.id))):
        replace_ordered_targets(db, user_id=user_id, source=source, targets=[])

    changed_edge_ids: list[UUID] = []
    parent_by_block_id: dict[UUID, ResourceRef] = {}
    for source, targets in sorted(
        children_by_source.items(), key=lambda item: (item[0].scheme, str(item[0].id))
    ):
        changed_edge_ids.extend(
            replace_ordered_targets(db, user_id=user_id, source=source, targets=targets)
        )
        for target in targets:
            if target.target.scheme == "note_block":
                parent_by_block_id[target.target.id] = source

    for block_id, collapsed in collapsed_by_block_id.items():
        parent = parent_by_block_id.get(block_id)
        if parent is None:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST, "Collapsed state target must be adjacent"
            )
        set_collapsed(db, user_id=user_id, parent=parent, block_id=block_id, collapsed=collapsed)

    delete_view_state_for_blocks(db, user_id=user_id, block_ids=deleted_block_ids)
    return changed_edge_ids


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


def delete_view_state_for_blocks(db: Session, *, user_id: UUID, block_ids: set[UUID]) -> None:
    if not block_ids:
        return
    db.execute(
        delete(ResourceViewState).where(
            ResourceViewState.user_id == user_id,
            (
                (ResourceViewState.surface_scheme == "note_block")
                & (ResourceViewState.surface_id.in_(block_ids))
            )
            | (
                (ResourceViewState.target_scheme == "note_block")
                & (ResourceViewState.target_id.in_(block_ids))
            ),
        )
    )


def delete_block_subtree(
    db: Session,
    *,
    user_id: UUID,
    root_block_id: UUID,
    parent_context: ResourceRef | None,
) -> list[UUID]:
    if parent_context is not None:
        children = [
            child
            for child in _ordered_note_targets(db, user_id=user_id, parent=parent_context)
            if child.target.id != root_block_id
        ]
        replace_ordered_targets(db, user_id=user_id, source=parent_context, targets=children)
    deleted = _subtree_ids(db, user_id=user_id, block_id=root_block_id, seen=set())
    delete_edges_for_deleted_resources(
        db,
        refs=[ResourceRef(scheme="note_block", id=block_id) for block_id in deleted],
    )
    delete_view_state_for_blocks(db, user_id=user_id, block_ids=set(deleted))
    return deleted


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


def _ordered_note_targets(
    db: Session, *, user_id: UUID, parent: ResourceRef
) -> list[OrderedTarget]:
    return [
        OrderedTarget(
            target=ResourceRef(scheme="note_block", id=block.id),
            source_order_key=edge.source_order_key or "",
        )
        for edge, block in _ordered_note_rows(db, user_id=user_id, parent=parent)
    ]


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


def _subtree_ids(db: Session, *, user_id: UUID, block_id: UUID, seen: set[UUID]) -> list[UUID]:
    if block_id in seen:
        return []
    out = [block_id]
    for child in _ordered_note_targets(
        db,
        user_id=user_id,
        parent=ResourceRef(scheme="note_block", id=block_id),
    ):
        out.extend(
            _subtree_ids(db, user_id=user_id, block_id=child.target.id, seen={*seen, block_id})
        )
    return out


def _assert_source_visible(db: Session, *, user_id: UUID, source: ResourceRef) -> None:
    from nexus.services.resource_graph.resolve import assert_ref_visible

    assert_ref_visible(db, viewer_id=user_id, ref=source)


def _assert_target_visible(db: Session, *, user_id: UUID, target: ResourceRef) -> None:
    from nexus.services.resource_graph.resolve import assert_ref_visible

    assert_ref_visible(db, viewer_id=user_id, ref=target)


def _assert_note_visible(db: Session, *, user_id: UUID, block_id: UUID) -> None:
    if db.scalar(
        select(NoteBlock.id).where(NoteBlock.id == block_id, NoteBlock.user_id == user_id)
    ):
        return
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
