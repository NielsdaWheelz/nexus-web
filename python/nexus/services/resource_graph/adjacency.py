"""Incident neutral links, independently ordered at each writing endpoint."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import cast
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge, ResourceViewState
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.resource_graph import edges as graph_edges
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.resolve import assert_ref_visible
from nexus.services.resource_items import versions
from nexus.services.resource_items.capabilities import resource_can_own_ordered_adjacency


@dataclass(slots=True)
class SurfaceNote:
    block: NoteBlock
    order_key: str
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
        return list(dict.fromkeys(out))


def incident_predicates(user_id: UUID, source: ResourceRef):
    return (
        ResourceEdge.user_id == user_id,
        ResourceEdge.origin == "user",
        ResourceEdge.kind == "context",
        ResourceEdge.ordinal.is_(None),
        ResourceEdge.snapshot.is_(None),
        ResourceEdge.source_order_key.is_(None),
        or_(graph_edges.source_is(source), graph_edges.target_is(source)),
    )


def other_endpoint(edge: ResourceEdge, endpoint: ResourceRef) -> ResourceRef:
    if (edge.source_scheme, edge.source_id) == (endpoint.scheme, endpoint.id):
        return ResourceRef(scheme=cast(ResourceScheme, edge.target_scheme), id=edge.target_id)
    if (edge.target_scheme, edge.target_id) == (endpoint.scheme, endpoint.id):
        return ResourceRef(scheme=cast(ResourceScheme, edge.source_scheme), id=edge.source_id)
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Link is not incident to the endpoint")


def ordered_edges(db: Session, *, user_id: UUID, source: ResourceRef) -> list[ResourceEdge]:
    return list(
        db.scalars(
            select(ResourceEdge)
            .outerjoin(
                ResourceViewState,
                and_(
                    ResourceViewState.edge_id == ResourceEdge.id,
                    ResourceViewState.user_id == user_id,
                    ResourceViewState.surface_scheme == source.scheme,
                    ResourceViewState.surface_id == source.id,
                ),
            )
            .where(*incident_predicates(user_id, source))
            .order_by(
                ResourceViewState.order_key.asc().nulls_last(),
                ResourceEdge.created_at,
                ResourceEdge.id,
            )
        ).all()
    )


def incident_link(
    db: Session, *, user_id: UUID, source: ResourceRef, link_id: UUID
) -> ResourceEdge:
    edge = db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.id == link_id, *incident_predicates(user_id, source)
        )
    )
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Surface link not found")
    return edge


def link_state(
    db: Session, *, user_id: UUID, source: ResourceRef, link_id: UUID
) -> ResourceViewState | None:
    return db.scalar(
        select(ResourceViewState).where(
            ResourceViewState.user_id == user_id,
            ResourceViewState.surface_scheme == source.scheme,
            ResourceViewState.surface_id == source.id,
            ResourceViewState.edge_id == link_id,
        )
    )


def insert_link(
    db: Session, *, user_id: UUID, source: ResourceRef, target: ResourceRef
) -> graph_edges.EdgeWrite:
    assert_ref_visible(db, viewer_id=user_id, ref=source)
    if not resource_can_own_ordered_adjacency(source):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot own a surface")
    return graph_edges.create_link(db, viewer_id=user_id, source=source, target=target)


def reorder_links(
    db: Session, *, user_id: UUID, source: ResourceRef, link_ids: Sequence[UUID]
) -> None:
    current = ordered_edges(db, user_id=user_id, source=source)
    if len(set(link_ids)) != len(link_ids) or {edge.id for edge in current} != set(link_ids):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Ordered links must match the endpoint")
    if [edge.id for edge in current] == list(link_ids):
        return
    rows: dict[UUID, ResourceViewState] = {}
    for edge in current:
        row = link_state(db, user_id=user_id, source=source, link_id=edge.id)
        if row is None:
            other = other_endpoint(edge, source)
            row = ResourceViewState(
                user_id=user_id,
                surface_scheme=source.scheme,
                surface_id=source.id,
                edge_id=edge.id,
                target_scheme=other.scheme,
                target_id=other.id,
                state={},
            )
            db.add(row)
        row.order_key = f"reordering:{edge.id}"
        rows[edge.id] = row
    db.flush()
    for index, link_id in enumerate(link_ids, start=1):
        rows[link_id].order_key = f"{index:010d}"
    db.flush()
    versions.bump_version(db, viewer_id=user_id, ref=source, lane="links")


def restore_endpoint_order(
    db: Session,
    *,
    user_id: UUID,
    source: ResourceRef,
    entries: Sequence[tuple[UUID, str | None, dict[str, object]]],
) -> None:
    """Restore receipt-owned ranks and saved collapse values after pair restoration."""
    current = ordered_edges(db, user_id=user_id, source=source)
    if {edge.id for edge in current} != {entry[0] for entry in entries}:
        raise ApiError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Restored order no longer matches the endpoint"
        )
    states: dict[UUID, ResourceViewState] = {}
    for edge in current:
        row = link_state(db, user_id=user_id, source=source, link_id=edge.id)
        if row is None:
            other = other_endpoint(edge, source)
            row = ResourceViewState(
                user_id=user_id,
                surface_scheme=source.scheme,
                surface_id=source.id,
                edge_id=edge.id,
                target_scheme=other.scheme,
                target_id=other.id,
                state={},
            )
            db.add(row)
        row.order_key = f"restoring:{edge.id}"
        states[edge.id] = row
    db.flush()
    for link_id, order_key, state in entries:
        states[link_id].order_key = order_key
        states[link_id].state = state
    db.flush()
    versions.bump_version(db, viewer_id=user_id, ref=source, lane="links")


def load_page_surface(db: Session, *, user_id: UUID, page_id: UUID) -> PageSurface:
    """A deterministic, canonical-note-once export, never an ownership tree."""
    page = db.scalar(select(Page).where(Page.id == page_id, Page.user_id == user_id))
    if page is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    seen: set[UUID] = set()

    def children(parent: ResourceRef) -> list[SurfaceNote]:
        out: list[SurfaceNote] = []
        for edge in ordered_edges(db, user_id=user_id, source=parent):
            other = other_endpoint(edge, parent)
            if other.scheme != "note_block" or other.id in seen:
                continue
            block = db.scalar(
                select(NoteBlock).where(NoteBlock.id == other.id, NoteBlock.user_id == user_id)
            )
            if block is None:
                continue
            seen.add(block.id)
            state = link_state(db, user_id=user_id, source=parent, link_id=edge.id)
            out.append(
                SurfaceNote(
                    block=block,
                    order_key=state.order_key
                    if state is not None and state.order_key is not None
                    else "",
                    children=children(other),
                )
            )
        return out

    return PageSurface(page=page, roots=children(ResourceRef(scheme="page", id=page.id)))
