"""Conversation context-ref routes (spec §10.1).

Context refs are ``resource_edges`` rows sourced from the conversation. Admission
semantics live in ``nexus.services.resource_graph.context``.

Routes:
- GET    /conversations/{conversation_id}/context-refs
- DELETE /conversations/{conversation_id}/context-refs/{edge_id}

(`GET /conversations?has_context_ref=` lives with the conversations routes.)
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.resource_graph import ContextRefOut
from nexus.services.resource_graph import context as context_service

router = APIRouter(tags=["conversation-context"])


def _context_ref_out(row: context_service.ContextRefOut) -> ContextRefOut:
    return ContextRefOut(
        id=row.edge_id,
        conversation_id=row.conversation_id,
        resource_ref=row.target.uri,
        activation=row.activation,
        label=row.resolved.label,
        summary=row.resolved.summary,
        missing=row.resolved.missing,
        created_at=row.created_at,
    )


@router.get("/conversations/{conversation_id}/context-refs")
def list_context_refs(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List a conversation's context refs, hydrated, first-attached order.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): conversation doesn't exist or viewer is not owner.
    """
    rows = context_service.list_context_refs(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id
    )
    return ok([_context_ref_out(row) for row in rows])


@router.delete("/conversations/{conversation_id}/context-refs/{edge_id}", status_code=204)
def remove_context_ref(
    conversation_id: UUID,
    edge_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a context ref from the conversation.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): conversation doesn't exist or viewer is not owner.
        E_NOT_FOUND (404): edge doesn't exist on this conversation.
    """
    context_service.remove_context_ref(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id, edge_id=edge_id
    )
    db.commit()
    return Response(status_code=204)
