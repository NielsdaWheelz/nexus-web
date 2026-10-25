"""Resource-graph routes: connection reads, machine-fact removal and the detach of a
chat's context. Authored links have no route: devices replicate them as authored changes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    ContextOut,
)
from nexus.services.resource_graph import connections, context, links
from nexus.services.resource_graph.refs import require_ref
from nexus.services.suggestion_changes import record_input_change

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(tags=["resource-graph"])


@router.post("/resource-graph/connections/query")
def query_connections(
    body: ConnectionQueryRequest, viewer: ViewerDep, db: DbSession
) -> Data[ConnectionPageOut]:
    return Data(data=connections.query_connections(db, viewer_id=viewer.user_id, query=body))


@router.delete("/resource-graph/facts/{edge_id}", status_code=204)
def remove_fact(edge_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    """Idempotent: an absent fact is 204 again. Only discovery and assistant facts."""
    if links.remove_machine_fact(db, viewer_id=viewer.user_id, edge_id=edge_id):
        record_input_change(db, owners=(f"link:{edge_id}",))
    db.commit()
    return Response(status_code=204)


@router.get("/conversations/{conversation_id}/context")
def get_context(conversation_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[ContextOut]:
    return Data(
        data=context.context_out(db, viewer_id=viewer.user_id, conversation_id=conversation_id)
    )


@router.delete("/conversations/{conversation_id}/context/{target_ref}", status_code=204)
def detach_context(
    conversation_id: UUID,
    target_ref: str,
    viewer: ViewerDep,
    db: DbSession,
    expected_context_version: Annotated[int, Query(ge=1)],
) -> Response:
    context.detach_context_target(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        target=require_ref(target_ref),
        expected_context_version=expected_context_version,
    )
    db.commit()
    return Response(status_code=204)
