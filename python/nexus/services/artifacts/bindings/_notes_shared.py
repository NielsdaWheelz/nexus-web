"""Shared one-hop Connection collection for Page and Note Dossiers."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.services.artifacts.bindings._shared import Candidate
from nexus.services.artifacts.bindings.base import DossierInputTooLarge
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.refs import (
    RESOURCE_SCHEMES,
    ResourceRef,
    ResourceScheme,
)
from nexus.services.resource_graph.schemas import (
    ConnectionFilters,
    ConnectionQuery,
)

# The exclusion is explicit in both filter dimensions (Rev 3 §Subject inputs).
CONNECTION_SCHEMES: tuple[ResourceScheme, ...] = tuple(
    cast("ResourceScheme", scheme)
    for scheme in RESOURCE_SCHEMES
    if scheme not in {"artifact", "artifact_revision"}
)
_MAX_CONNECTIONS = 500


def one_hop_connection_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    subject: ResourceRef,
    start_index: int,
) -> tuple[list[Candidate], list[str]]:
    candidates: list[Candidate] = []
    refs: list[str] = []
    cursor: str | None = None
    seen = 0
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQuery(
                refs=(subject,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(
                    source_schemes=CONNECTION_SCHEMES,
                    target_schemes=CONNECTION_SCHEMES,
                ),
                cursor=cursor,
                limit=100,
            ),
        )
        seen += len(page.items)
        for connection in page.items:
            # Ordered Page/Note containment is Contents, not a Connection candidate.
            if connection.source_order_key is not None:
                continue
            endpoint = connection.other
            if endpoint.missing or endpoint.ref == subject:
                continue
            body = endpoint.description or endpoint.label or endpoint.ref.uri
            refs.append(endpoint.ref.uri)
            candidates.append(
                Candidate(
                    index=start_index + len(candidates),
                    target=endpoint.ref,
                    text=(
                        f"Connection ({connection.kind}, {connection.direction}) — "
                        f"{endpoint.label or endpoint.ref.uri}:\n{body}"
                    ),
                    snapshot=_connection_snapshot(
                        endpoint.ref,
                        endpoint.label,
                        body,
                        endpoint.href,
                    ),
                )
            )
        if page.next_cursor is None:
            break
        if seen >= _MAX_CONNECTIONS:
            raise DossierInputTooLarge
        cursor = page.next_cursor
    return candidates, list(dict.fromkeys(refs))


def _connection_snapshot(
    ref: ResourceRef,
    label: str | None,
    body: str,
    href: str | None,
):
    from nexus.services.resource_graph.schemas import CitationSnapshot

    return CitationSnapshot(
        title=label,
        excerpt=body[:600],
        result_type=ref.scheme,
        deep_link=href,
    )
