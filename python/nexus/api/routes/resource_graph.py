"""Resource-graph routes: connection reads, links and their note, and the detach of a
chat's automatic context fact."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    CreateLinkOut,
    CreateLinkRequest,
    LinkNoteOut,
    PutLinkNoteRequest,
)
from nexus.services.resource_graph import connections, context, links

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(tags=["resource-graph"])


@router.post("/resource-graph/connections/query")
def query_connections(
    body: ConnectionQueryRequest, viewer: ViewerDep, db: DbSession
) -> Data[ConnectionPageOut]:
    return Data(data=connections.query_connections(db, viewer_id=viewer.user_id, query=body))


@router.post("/resource-graph/links", status_code=201)
def create_link(body: CreateLinkRequest, viewer: ViewerDep, db: DbSession) -> Data[CreateLinkOut]:
    return Data(data=links.create_link(db, viewer_id=viewer.user_id, request=body))


@router.delete("/resource-graph/links/{link_id}", status_code=204)
def delete_link(link_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    links.delete_link(db, viewer_id=viewer.user_id, link_id=link_id)
    return Response(status_code=204)


@router.put("/resource-graph/links/{link_id}/note")
def put_link_note(
    link_id: UUID, body: PutLinkNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[LinkNoteOut]:
    return Data(
        data=links.put_link_note(db, viewer_id=viewer.user_id, link_id=link_id, request=body)
    )


@router.delete("/resource-graph/links/{link_id}/note", status_code=204)
def delete_link_note(
    link_id: UUID,
    viewer: ViewerDep,
    db: DbSession,
    note_block_id: Annotated[UUID, Query()],
    client_mutation_id: Annotated[str, Query(min_length=1, max_length=120)],
) -> Response:
    links.detach_link_note(
        db,
        viewer_id=viewer.user_id,
        link_id=link_id,
        note_block_id=note_block_id,
        client_mutation_id=client_mutation_id,
    )
    return Response(status_code=204)


@router.delete("/conversations/{conversation_id}/context-refs/{edge_id}", status_code=204)
def remove_context_ref(
    conversation_id: UUID, edge_id: UUID, viewer: ViewerDep, db: DbSession
) -> Response:
    context.remove_context_ref(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id, edge_id=edge_id
    )
    db.commit()
    return Response(status_code=204)
