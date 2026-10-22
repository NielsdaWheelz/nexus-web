"""Resource-graph routes: connection reads, outline commands and the detach of a
chat's automatic context fact."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.notes import (
    OutlineCommandsOut,
    OutlineCommandsRequest,
    OutlineOut,
)
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    ContextOut,
)
from nexus.services import outline
from nexus.services.resource_graph import connections, context
from nexus.services.resource_graph.refs import require_ref

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(tags=["resource-graph"])


@router.post("/resource-graph/connections/query")
def query_connections(
    body: ConnectionQueryRequest, viewer: ViewerDep, db: DbSession
) -> Data[ConnectionPageOut]:
    return Data(data=connections.query_connections(db, viewer_id=viewer.user_id, query=body))


@router.get("/resource-graph/outline/{ref}")
def read_outline(
    ref: str,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    cursor: str | None = None,
) -> Data[OutlineOut]:
    return Data(
        data=outline.read(
            db, viewer_id=viewer.user_id, ref=require_ref(ref), limit=limit, cursor=cursor
        )
    )


@router.post("/resource-graph/commands")
def commands(
    body: OutlineCommandsRequest, viewer: ViewerDep, db: DbSession
) -> Data[OutlineCommandsOut]:
    return Data(data=outline.execute(db, viewer_id=viewer.user_id, commands=body.commands))


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
