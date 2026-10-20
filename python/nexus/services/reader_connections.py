"""Exact reader graph facts in the media endpoint's authored order.

The caller's coherent snapshot covers both the complete mixed order and its links
version. No descendant or owner rollup participates in this inventory. Hydration
preserves all facts; reader_evidence groups them without inventing relationships.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.resource_graph import ConnectionOut
from nexus.services.resource_graph import order
from nexus.services.resource_graph.connections import hydrate_connections
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items import versions


@dataclass(frozen=True, slots=True)
class ReaderConnections:
    items: list[ConnectionOut]
    links_version: int


def list_reader_connections(db: Session, *, viewer_id: UUID, media_id: UUID) -> ReaderConnections:
    """Read every exact incident fact and source-version fence in one snapshot."""
    endpoint = ResourceRef("media", media_id)
    return ReaderConnections(
        items=hydrate_connections(
            db,
            viewer_id,
            [edge for edge, _ in order.ordered(db, viewer_id, endpoint)],
            {(endpoint.scheme, endpoint.id)},
            "both",
        ),
        links_version=versions.versions_for_ref(db, viewer_id=viewer_id, ref=endpoint).get(
            "links", 1
        ),
    )
