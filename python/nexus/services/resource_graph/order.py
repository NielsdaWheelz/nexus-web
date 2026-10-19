"""Endpoint-owned display order for every incident fact, independent of graph meaning.

Ranks precede unranked facts; creation/id breaks ties. Placement rewrites dense ranks
inside the caller's transaction. Missing anchors conflict; an already achieved move
is a no-op. Semantic traversal and conversation admission never consume this order.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge, ResourceViewState
from nexus.errors import ApiErrorCode, ConflictError
from nexus.services.resource_graph import retention
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items import versions


def statement(viewer_id: UUID, endpoint: ResourceRef):
    return (
        select(ResourceEdge, ResourceViewState.order_key)
        .outerjoin(
            ResourceViewState,
            (ResourceViewState.edge_id == ResourceEdge.id)
            & (ResourceViewState.user_id == viewer_id)
            & (ResourceViewState.surface_scheme == endpoint.scheme)
            & (ResourceViewState.surface_id == endpoint.id),
        )
        .where(
            ResourceEdge.user_id == viewer_id,
            or_(
                (ResourceEdge.source_scheme == endpoint.scheme)
                & (ResourceEdge.source_id == endpoint.id),
                (ResourceEdge.target_scheme == endpoint.scheme)
                & (ResourceEdge.target_id == endpoint.id),
            ),
        )
        .order_by(
            ResourceViewState.order_key.asc().nulls_last(), ResourceEdge.created_at, ResourceEdge.id
        )
    )


def ordered(db: Session, viewer_id: UUID, endpoint: ResourceRef):
    return list(db.execute(statement(viewer_id, endpoint)).tuples())


def desired(
    db: Session, viewer_id: UUID, endpoint: ResourceRef, edge_id: UUID, after: UUID | None
) -> tuple[list[ResourceEdge], list[UUID]]:
    current = [edge for edge, _ in ordered(db, viewer_id, endpoint)]
    ids = [edge.id for edge in current if edge.id != edge_id]
    if edge_id not in [edge.id for edge in current] or (after is not None and after not in ids):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Position is not in this outline")
    ids.insert(0 if after is None else ids.index(after) + 1, edge_id)
    return current, ids


def place(
    db: Session, viewer_id: UUID, endpoint: ResourceRef, edge_id: UUID, after: UUID | None
) -> None:
    retention.pin_owners(db, [endpoint])
    current, ids = desired(db, viewer_id, endpoint, edge_id, after)
    if [edge.id for edge in current] == ids:
        return
    _rank(db, viewer_id, endpoint, current, ids)


def _rank(
    db: Session,
    viewer_id: UUID,
    endpoint: ResourceRef,
    current: list[ResourceEdge],
    ids: list[UUID],
) -> None:
    states = {
        state.edge_id: state
        for state in db.scalars(
            select(ResourceViewState).where(
                ResourceViewState.user_id == viewer_id,
                ResourceViewState.surface_scheme == endpoint.scheme,
                ResourceViewState.surface_id == endpoint.id,
                ResourceViewState.edge_id.in_(ids),
            )
        )
    }
    for edge in current:
        if edge.id not in states:
            source = (edge.source_scheme, edge.source_id) == (endpoint.scheme, endpoint.id)
            state = ResourceViewState(
                user_id=viewer_id,
                surface_scheme=endpoint.scheme,
                surface_id=endpoint.id,
                edge_id=edge.id,
                target_scheme=edge.target_scheme if source else edge.source_scheme,
                target_id=edge.target_id if source else edge.source_id,
                state={},
            )
            states[edge.id] = state
            db.add(state)
        states[edge.id].order_key = f"moving:{edge.id}"
    db.flush()
    for index, id_ in enumerate(ids, 1):
        states[id_].order_key = f"{index:010d}"
    db.flush()
    versions.bump_version(db, viewer_id=viewer_id, ref=endpoint, lane="links")
    retention.touch_owners(db, [endpoint])


def append(db: Session, viewer_id: UUID, endpoint: ResourceRef, edge_id: UUID) -> None:
    """Append after the full mixed sequence, including its unranked tail."""
    retention.pin_owners(db, [endpoint])
    current = [edge for edge, _ in ordered(db, viewer_id, endpoint)]
    ids = [edge.id for edge in current if edge.id != edge_id]
    ids.append(edge_id)
    _rank(db, viewer_id, endpoint, current, ids)
