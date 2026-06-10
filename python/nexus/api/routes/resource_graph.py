"""Resource provenance graph routes (spec §10.2/§10.3).

- GET    /resource-graph/edges      the one connections read (backlinks, cited-by)
- POST   /resource-graph/edges      user links and user stance edges
- DELETE /resource-graph/edges/{id} user-origin rows only
- POST   /resource-graph/resolve    batch ref hydration for UI display

Routes parse ref strings and the kind/origin vocabulary at the boundary, call
graph services, and return envelopes. Graph semantics (dedup, permission
checks, hydration) live in ``nexus.services.resource_graph``.
"""

from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError, NotFoundError
from nexus.responses import ok
from nexus.schemas.resource_graph import (
    EDGE_KIND_VALUES,
    EDGE_ORIGIN_VALUES,
    CreateEdgeRequest,
    EdgeKind,
    EdgeOrigin,
    EdgeOut,
    ResolvedResourceOut,
    ResolveRefsRequest,
)
from nexus.services.resource_graph import edges as edges_service
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph import resolve as resolve_service
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import snapshot_to_jsonb

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


@router.get("/edges")
def list_edges(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    ref: Annotated[str, Query(description="Resource ref matched against either endpoint")],
    kind: Annotated[str | None, Query()] = None,
    origin: Annotated[str | None, Query()] = None,
) -> dict:
    """List edges touching ``ref`` on either endpoint, newest-last.

    Errors:
        E_INVALID_REQUEST (400): malformed ref, or unknown kind/origin value.
    """
    parsed = _parse_ref_or_400(ref)
    if kind is not None and kind not in EDGE_KIND_VALUES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid kind: {kind!r}. Expected one of {', '.join(EDGE_KIND_VALUES)}.",
        )
    if origin is not None and origin not in EDGE_ORIGIN_VALUES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid origin: {origin!r}. Expected one of {', '.join(EDGE_ORIGIN_VALUES)}.",
        )
    edge_rows = edges_service.list_edges_for_ref(
        db,
        viewer_id=viewer.user_id,
        ref=parsed,
        kind=cast("EdgeKind | None", kind),
        origin=cast("EdgeOrigin | None", origin),
    )
    return ok(_edge_outs(db, viewer.user_id, list(edge_rows)))


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
