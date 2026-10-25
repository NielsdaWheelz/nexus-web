"""Resource-graph routes: connection reads, outline commands and the detach of a
chat's automatic context fact."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.notes import (
    OutlineChildrenOut,
    OutlineChildrenRequest,
    OutlineCommandsRequest,
    OutlineOut,
)
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    ContextOut,
)
from nexus.schemas.writing import ResourceVersionsOut, ResourceVersionsRequest, WritingAck
from nexus.services import outline
from nexus.services.resource_graph import connections, context
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_items import versions

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
def commands(body: OutlineCommandsRequest, viewer: ViewerDep, db: DbSession) -> Data[WritingAck]:
    return Data(data=outline.execute(db, viewer_id=viewer.user_id, commands=body.commands))


@router.post("/resource-graph/outline/children/query")
def query_outline_children(
    body: OutlineChildrenRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[OutlineChildrenOut]:
    return Data(data=outline.query_children(db, viewer_id=viewer.user_id, request=body))


@router.post("/resource-graph/versions/query")
def query_versions(
    body: ResourceVersionsRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResourceVersionsOut]:
    return Data(data=versions.query(db, viewer_id=viewer.user_id, refs=body.refs))


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
