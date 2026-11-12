"""Resource-graph routes: connection reads and machine-fact removal. Authored links
have no route: devices replicate them as authored changes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    RemoteChildrenOut,
    RemoteChildrenRequest,
)
from nexus.services.resource_graph import connections, links
from nexus.services.suggestion_changes import record_input_change

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(tags=["resource-graph"])


@router.post("/resource-graph/connections/query")
def query_connections(
    body: ConnectionQueryRequest, viewer: ViewerDep, db: DbSession
) -> Data[ConnectionPageOut]:
    return Data(data=connections.query_connections(db, viewer_id=viewer.user_id, query=body))


@router.post("/resource-graph/connections/children/query")
def query_remote_children(
    body: RemoteChildrenRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[RemoteChildrenOut]:
    return Data(data=connections.query_remote_children(db, viewer_id=viewer.user_id, request=body))


@router.delete("/resource-graph/facts/{edge_id}", status_code=204)
def remove_fact(edge_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    """Idempotent: an absent fact is 204 again. Only discovery and assistant facts."""
    if links.remove_machine_fact(db, viewer_id=viewer.user_id, edge_id=edge_id):
        record_input_change(db, owners=(f"link:{edge_id}",))
    db.commit()
    return Response(status_code=204)
