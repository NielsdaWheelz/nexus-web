"""Resource-graph routes: parse refs at the boundary, call the service, envelope."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    CreateLinkRequest,
    PutLinkNoteRequest,
    PutStanceRequest,
    connection_out,
)
from nexus.services.resource_graph import connections as connections_service
from nexus.services.resource_graph import user_relations as user_relations_service
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery

ViewerDep = Annotated[Viewer, Depends(get_viewer)]
DbDep = Annotated[Session, Depends(get_db)]

router = APIRouter(prefix="/resource-graph", tags=["resource-graph"])


def _parse_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    return parsed


@router.post("/connections/query")
def query_connections(body: ConnectionQueryRequest, viewer: ViewerDep, db: DbDep) -> dict:
    filters = body.filters
    page = connections_service.query_connections(
        db=db,
        viewer_id=viewer.user_id,
        query=ConnectionQuery(
            refs=tuple(_parse_ref(raw) for raw in body.refs),
            direction=body.direction,
            rollup=body.rollup,
            filters=ConnectionFilters(
                origins=tuple(filters.origins) if filters.origins is not None else None,
                kinds=tuple(filters.kinds) if filters.kinds is not None else None,
                source_schemes=(
                    tuple(filters.source_schemes) if filters.source_schemes is not None else None
                ),
                target_schemes=(
                    tuple(filters.target_schemes) if filters.target_schemes is not None else None
                ),
            ),
            limit=body.limit,
            cursor=body.cursor,
        ),
    )
    return ok(
        ConnectionPageOut(
            items=[connection_out(item) for item in page.items], next_cursor=page.next_cursor
        )
    )


@router.post("/links", status_code=201)
def create_link(body: CreateLinkRequest, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(user_relations_service.create_link(db, viewer_id=viewer.user_id, request=body))


@router.delete("/links/{link_id}", status_code=204)
def delete_link(link_id: UUID, viewer: ViewerDep, db: DbDep) -> Response:
    user_relations_service.delete_link(db, viewer_id=viewer.user_id, link_id=link_id)
    return Response(status_code=204)


@router.put("/links/{link_id}/note")
def put_link_note(link_id: UUID, body: PutLinkNoteRequest, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(
        user_relations_service.put_link_note(
            db, viewer_id=viewer.user_id, link_id=link_id, request=body
        )
    )


@router.delete("/links/{link_id}/note", status_code=204)
def delete_link_note(
    link_id: UUID,
    viewer: ViewerDep,
    db: DbDep,
    note_block_id: Annotated[UUID, Query()],
    client_mutation_id: Annotated[str, Query(min_length=1, max_length=120)],
) -> Response:
    user_relations_service.detach_link_note(
        db,
        viewer_id=viewer.user_id,
        link_id=link_id,
        note_block_id=note_block_id,
        client_mutation_id=client_mutation_id,
    )
    return Response(status_code=204)


@router.put("/stances")
def put_stance(body: PutStanceRequest, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(user_relations_service.put_stance(db, viewer_id=viewer.user_id, request=body))


@router.delete("/stances/{stance_id}", status_code=204)
def delete_stance(stance_id: UUID, viewer: ViewerDep, db: DbDep) -> Response:
    user_relations_service.delete_stance(db, viewer_id=viewer.user_id, stance_id=stance_id)
    return Response(status_code=204)
