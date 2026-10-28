"""Endpoint-owned display order for every live incident fact, independent of graph meaning.

An authored link's rank at an endpoint is the projection of its fractional position
register: keys compare bytewise, then link id breaks equal keys. Unranked machine
facts follow in creation/id order. Semantic traversal and conversation admission
never consume this order, and nothing here writes it.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import case, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge, ResourceViewState
from nexus.services.resource_graph.liveness import edge_live_sql
from nexus.services.resource_graph.refs import ResourceRef


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
            text(edge_live_sql("resource_edges")),
        )
        .order_by(
            ResourceViewState.order_key.collate("C").asc().nulls_last(),
            case((ResourceViewState.order_key.is_(None), ResourceEdge.created_at)),
            ResourceEdge.id,
        )
    )


def ordered(db: Session, viewer_id: UUID, endpoint: ResourceRef):
    return list(db.execute(statement(viewer_id, endpoint)).tuples())
