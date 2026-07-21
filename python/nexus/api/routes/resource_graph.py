"""Resource provenance graph routes (spec §10.2/§10.3, § Mutation APIs).

- POST   /resource-graph/connections/query hydrated connection reads
- POST   /resource-graph/connections/summary batch per-ref aggregates
- POST   /resource-graph/links       create-or-reuse one neutral Link
- DELETE /resource-graph/links/{id}   Remove Link (idempotent)
- PUT    /resource-graph/links/{id}/note   add/edit the Link's one note
- DELETE /resource-graph/links/{id}/note   delete the Link's note
- PUT    /resource-graph/stances      replace the one directed stance on a pair
- DELETE /resource-graph/stances/{id} remove a stance (idempotent)
- POST   /resource-graph/resolve      batch ref hydration for UI display

Routes parse ref strings and the kind/origin vocabulary at the boundary, call
graph services, and return envelopes. Graph semantics (dedup, permission checks,
hydration, replay) live in ``nexus.services.resource_graph``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.resource_graph import (
    ConnectionEndpointOut,
    ConnectionFiltersRequest,
    ConnectionPageOut,
    ConnectionQueryRequest,
    ConnectionSummaryOut,
    ConnectionSummaryPageOut,
    ConnectionSummaryRequest,
    CreateLinkRequest,
    PutLinkNoteRequest,
    PutStanceRequest,
    ResolvedResourceOut,
    ResolveRefsRequest,
    connection_out,
)
from nexus.services.resource_graph import connection_summaries as connection_summaries_service
from nexus.services.resource_graph import connections as connections_service
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph import resolve as resolve_service
from nexus.services.resource_graph import user_relations as user_relations_service
from nexus.services.resource_graph.connection_summaries import ConnectionSummary
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    ConnectionEndpoint,
    ConnectionFilters,
    ConnectionQuery,
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
            items=[connection_out(item) for item in page.items], next_cursor=page.next_cursor
        )
    )


@router.post("/connections/summary")
def summarize_connections(
    body: ConnectionSummaryRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Batch per-ref connection counts + top peers for the collection surface.

    ``origins`` defaults to ``LIST_CONNECTION_ORIGINS`` (AI-free: ``synapse`` and
    ``system`` excluded). Deleted/forbidden peers come back ``missing``.

    Errors:
        E_INVALID_REQUEST (400): a malformed ref, or more than 200 refs.
    """
    parsed = tuple(_parse_ref_or_400(raw) for raw in body.refs)
    allowed_origins = set(connection_summaries_service.LIST_CONNECTION_ORIGINS)
    if body.origins is None:
        origins = connection_summaries_service.LIST_CONNECTION_ORIGINS
    else:
        requested_origins = tuple(body.origins)
        disallowed = sorted(set(requested_origins) - allowed_origins)
        if disallowed:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Connection summaries only support list-surface origins: "
                + ", ".join(connection_summaries_service.LIST_CONNECTION_ORIGINS),
            )
        origins = requested_origins
    summaries = connection_summaries_service.summarize_connections(
        db,
        viewer_id=viewer.user_id,
        refs=parsed,
        origins=origins,
    )
    return ok(
        ConnectionSummaryPageOut(
            summaries=[_connection_summary_out(summary) for summary in summaries]
        )
    )


@router.post("/links", status_code=201)
def create_link(
    body: CreateLinkRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create-or-reuse one neutral Link (§ Mutation APIs).

    Errors:
        E_INVALID_REQUEST (400): malformed ref or non-passage candidate target.
        E_NOT_FOUND (404): a masked missing/hidden endpoint or owner.
        E_LINK_SELF / E_LINK_CAPABILITY / E_LINK_TARGET_AMBIGUOUS (422).
        E_LINK_TARGET_STALE / E_HIGHLIGHT_CONFLICT /
        E_IDEMPOTENCY_KEY_REPLAY_MISMATCH (409).
    """
    result = user_relations_service.create_link(db, viewer_id=viewer.user_id, request=body)
    return ok(result)


@router.delete("/links/{link_id}", status_code=204)
def delete_link(
    link_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a Link (idempotent); detaches attachment motifs, preserves note prose.

    Errors:
        E_FORBIDDEN (403): the edge exists but is not user-authored.
        E_NOT_FOUND (404): the id is the viewer's but is not a neutral Link.
    """
    user_relations_service.delete_link(db, viewer_id=viewer.user_id, link_id=link_id)
    return Response(status_code=204)


@router.put("/links/{link_id}/note")
def put_link_note(
    link_id: UUID,
    body: PutLinkNoteRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Add/Edit the Link's single ordinary note (§ Mutation APIs).

    Errors:
        E_NOT_FOUND (404): no such Link for the viewer.
        E_NOTE_CONFLICT (409): the Link already has a different note.
    """
    result = user_relations_service.put_link_note(
        db, viewer_id=viewer.user_id, link_id=link_id, request=body
    )
    return ok(result)


@router.delete("/links/{link_id}/note", status_code=204)
def delete_link_note(
    link_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete the Link's note and its attachments; the Link is preserved.

    Errors:
        E_NOT_FOUND (404): no such Link for the viewer.
    """
    user_relations_service.delete_link_note(db, viewer_id=viewer.user_id, link_id=link_id)
    return Response(status_code=204)


@router.put("/stances")
def put_stance(
    body: PutStanceRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Replace the one directed stance on an unordered pair (§ Stance).

    Errors:
        E_INVALID_REQUEST (400): a malformed ref.
        E_NOT_FOUND (404): a masked missing/hidden endpoint.
        E_LINK_SELF / E_LINK_CAPABILITY (422).
    """
    result = user_relations_service.put_stance(db, viewer_id=viewer.user_id, request=body)
    return ok(result)


@router.delete("/stances/{stance_id}", status_code=204)
def delete_stance(
    stance_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a stance (idempotent).

    Errors:
        E_FORBIDDEN (403): the edge exists but is not user-authored.
        E_NOT_FOUND (404): the id is the viewer's but is not a stance.
    """
    user_relations_service.delete_stance(db, viewer_id=viewer.user_id, stance_id=stance_id)
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
        activation=endpoint.activation,
        href=endpoint.href,
        missing=endpoint.missing,
    )


def _connection_summary_out(summary: ConnectionSummary) -> ConnectionSummaryOut:
    return ConnectionSummaryOut(
        ref=summary.ref.uri,
        total=summary.total,
        by_kind={str(kind): count for kind, count in summary.by_kind.items()},
        last_connected_at=summary.last_connected_at,
        dominant_kind=summary.dominant_kind,
        top_peers=[_endpoint_out(peer) for peer in summary.top_peers],
    )
