"""Collect every exact graph fact incident to the reader's media.

This read owns paging only. Resource admission, presentation and placement belong
to reader_evidence; no descendant or owner rollup participates in this inventory.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.resource_graph import ConnectionOut, ConnectionQueryRequest
from nexus.services.resource_graph.connections import query_connections


def list_reader_connections(db: Session, *, viewer_id: UUID, media_id: UUID) -> list[ConnectionOut]:
    """Drain exact adjacency across all origins without interpreting endpoint content."""
    connections: list[ConnectionOut] = []
    cursor: str | None = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQueryRequest(
                refs=[f"media:{media_id}"],
                direction="both",
                rollup="exact",
                cursor=cursor,
            ),
        )
        connections.extend(page.items)
        if page.next_cursor is None:
            return connections
        cursor = page.next_cursor
