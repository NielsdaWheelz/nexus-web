"""Resource provenance graph routes (spec §10.2/§10.3).

- POST   /resource-graph/connections/query hydrated connection reads
- POST   /resource-graph/edges      user links and user stance edges
- DELETE /resource-graph/edges/{id} user-origin rows only
- POST   /resource-graph/resolve    batch ref hydration for UI display

Routes parse ref strings and the kind/origin vocabulary at the boundary, call
graph services, and return envelopes. Graph semantics (dedup, permission
checks, hydration) live in ``nexus.services.resource_graph``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.responses import ok
from nexus.schemas.resource_graph import (
    ConnectionCitationOut,
    ConnectionEndpointOut,
    ConnectionFiltersRequest,
    ConnectionOut,
    ConnectionPageOut,
    ConnectionQueryRequest,
    ConnectionReaderTargetOut,
    CreateEdgeRequest,
    EdgeOut,
    ResolvedResourceOut,
    ResolveRefsRequest,
)
from nexus.services.resource_graph import connections as connections_service
from nexus.services.resource_graph import edges as edges_service
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph import resolve as resolve_service
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    Connection,
    ConnectionEndpoint,
    ConnectionFilters,
    ConnectionQuery,
    snapshot_to_jsonb,
)

router = APIRouter(prefix="/resource-graph", tags=["resource-graph"])


def _parse_ref_or_400(raw: str) -> ResourceRef:
    parsed = refs_service.parse_resource_ref(raw)
    if isinstance(parsed, refs_service.ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    return parsed


def _edge_outs(db: Session, viewer_id: UUID, edge_rows: list) -> list[EdgeOut]:
    """Map service edges to wire schemas, batch-hydrating endpoint display."""
    endpoint_refs: list[ResourceRef] = []
    for edge in edge_rows:
        endpoint_refs.append(edge.source)
        endpoint_refs.append(edge.target)
    resolved = resolve_service.resolve_refs(db, viewer_id=viewer_id, refs=endpoint_refs)
    outs: list[EdgeOut] = []
    for index, edge in enumerate(edge_rows):
        source_resolved = resolved[2 * index]
        target_resolved = resolved[2 * index + 1]
        outs.append(
            EdgeOut(
                id=edge.id,
                kind=edge.kind,
                origin=edge.origin,
                source_ref=edge.source.uri,
                target_ref=edge.target.uri,
                source_order_key=edge.source_order_key,
                target_order_key=edge.target_order_key,
                ordinal=edge.ordinal,
                snapshot=snapshot_to_jsonb(edge.snapshot) if edge.snapshot else None,
                source_label=source_resolved.label,
                source_missing=source_resolved.missing,
                target_label=target_resolved.label,
                target_missing=target_resolved.missing,
                created_at=edge.created_at,
            )
        )
    return outs


@router.post("/connections/query")
def query_connections(
    body: ConnectionQueryRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    parsed = tuple(_parse_ref_or_400(raw) for raw in body.refs)
    page = connections_service.query_connections(
        db=db,
        viewer_id=viewer.user_id,
        query=ConnectionQuery(
            refs=parsed,
            direction=body.direction,
            rollup=body.rollup,
            filters=_connection_filters(body.filters),
            limit=body.limit,
            cursor=body.cursor,
        ),
    )
    return ok(
        ConnectionPageOut(
            items=[_connection_out(item) for item in page.items], next_cursor=page.next_cursor
        )
    )


@router.post("/edges", status_code=201)
def create_edge(
    body: CreateEdgeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a user link or user stance edge. ``origin`` is forced to ``user``.

    Errors:
        E_INVALID_REQUEST (400): malformed ref, or duplicate pair.
        E_NOT_FOUND (404): an endpoint resource does not exist or is not visible.
    """
    source = _parse_ref_or_400(body.source_ref)
    target = _parse_ref_or_400(body.target_ref)
    edge = edges_service.create_edge(
        db,
        viewer_id=viewer.user_id,
        input=edges_service.EdgeCreate(
            source=source,
            target=target,
            kind=body.kind,
            origin="user",
        ),
    )
    db.commit()
    return ok(_edge_outs(db, viewer.user_id, [edge])[0])


@router.delete("/edges/{edge_id}", status_code=204)
def delete_edge(
    edge_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a user-origin edge.

    The origin gate is route policy (spec §10.2): only ``origin = 'user'`` rows
    are deletable here, while ``edges.delete_edge`` stays origin-agnostic for
    the writers that own the other origins. The gate reads the row through the
    ``get_owned_edge`` accessor (no route imports a graph ORM model, AC15).

    Errors:
        E_NOT_FOUND (404): edge does not exist or is not the viewer's.
        E_FORBIDDEN (403): edge exists but was not created by the user.
    """
    edge = edges_service.get_owned_edge(db, viewer_id=viewer.user_id, edge_id=edge_id)
    if edge is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Edge not found")
    if edge.origin != "user":
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN, "Only user-created edges can be deleted here"
        )
    edges_service.delete_edge(db, viewer_id=viewer.user_id, edge_id=edge_id)
    db.commit()
    return Response(status_code=204)


@router.post("/resolve")
def resolve_refs(
    body: ResolveRefsRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Batch-hydrate refs for UI display. Unknown/forbidden refs resolve missing.

    Errors:
        E_INVALID_REQUEST (400): a ref is malformed.
    """
    parsed = [_parse_ref_or_400(raw) for raw in body.refs]
    resolved = resolve_service.resolve_refs(db, viewer_id=viewer.user_id, refs=parsed)
    return ok(
        [
            ResolvedResourceOut(
                ref=ref.uri,
                label=item.label,
                summary=item.summary,
                missing=item.missing,
            )
            for ref, item in zip(parsed, resolved, strict=True)
        ]
    )


def _connection_filters(body: ConnectionFiltersRequest) -> ConnectionFilters:
    return ConnectionFilters(
        origins=tuple(body.origins) if body.origins is not None else None,
        kinds=tuple(body.kinds) if body.kinds is not None else None,
        source_schemes=tuple(body.source_schemes) if body.source_schemes is not None else None,
        target_schemes=tuple(body.target_schemes) if body.target_schemes is not None else None,
    )


def _endpoint_out(endpoint: ConnectionEndpoint) -> ConnectionEndpointOut:
    return ConnectionEndpointOut(
        ref=endpoint.ref.uri,
        scheme=endpoint.ref.scheme,
        id=endpoint.ref.id,
        label=endpoint.label,
        description=endpoint.description,
        href=endpoint.href,
        missing=endpoint.missing,
    )


def _connection_out(item: Connection) -> ConnectionOut:
    citation = None
    if item.citation is not None:
        target_reader = None
        if item.citation.target_media_id is not None or item.citation.target_locator is not None:
            target_reader = ConnectionReaderTargetOut(
                media_id=item.citation.target_media_id,
                locator=item.citation.target_locator,
            )
        citation = ConnectionCitationOut(
            ordinal=item.citation.ordinal,
            role=item.citation.role,
            snapshot=snapshot_to_jsonb(item.citation.snapshot),
            target_reader=target_reader,
            target_status=item.citation.target_status,
        )
    return ConnectionOut(
        edge_id=item.edge_id,
        direction=item.direction,
        kind=item.kind,
        origin=item.origin,
        snapshot=snapshot_to_jsonb(item.snapshot) if item.snapshot is not None else None,
        source_order_key=item.source_order_key,
        target_order_key=item.target_order_key,
        ordinal=item.ordinal,
        source_ref=item.source_ref.uri,
        target_ref=item.target_ref.uri,
        source=_endpoint_out(item.source),
        target=_endpoint_out(item.target),
        other=_endpoint_out(item.other),
        citation=citation,
        created_at=item.created_at,
    )
