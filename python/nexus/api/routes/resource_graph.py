"""Resource-graph routes: connection reads, links and their note, and the detach of a
chat's automatic context fact."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.note_bodies import AnnotationNoteRequest
from nexus.schemas.notes import (
    OutlineCommandsOut,
    OutlineCommandsRequest,
    OutlineOut,
)
from nexus.schemas.resource_graph import (
    ConnectionPageOut,
    ConnectionQueryRequest,
    ContextOut,
    LinkNoteOut,
)
from nexus.services import outline
from nexus.services.resource_graph import connections, context, links
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


@router.put("/resource-graph/links/{link_id}/note")
def put_link_note(
    link_id: UUID, body: AnnotationNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[LinkNoteOut]:
    """Create the link's one note and attach it to both ends. That note already attached
    has landed; another note attached is 409 E_NOTE_CONFLICT."""
    return Data(
        data=links.put_link_note(db, viewer_id=viewer.user_id, link_id=link_id, request=body)
    )


@router.delete("/resource-graph/links/{link_id}/note/{note_id}", status_code=204)
def delete_link_note(link_id: UUID, note_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    """Detach the note from the link (idempotent); the note and the link stay."""
    links.detach_link_note(db, viewer_id=viewer.user_id, link_id=link_id, note_id=note_id)
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
