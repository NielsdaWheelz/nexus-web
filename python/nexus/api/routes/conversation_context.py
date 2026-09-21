"""Conversation context-ref routes.

Context refs are ``resource_edges`` rows sourced from the conversation;
admission semantics live in ``nexus.services.resource_graph.context``.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.resource_graph import context_ref_out
from nexus.services.resource_graph import context as context_service

router = APIRouter(tags=["conversation-context"])


@router.get("/conversations/{conversation_id}/context-refs")
def list_context_refs(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List a conversation's context refs, hydrated, in first-attached order."""

    rows = context_service.list_context_refs(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id
    )
    return ok([context_ref_out(row) for row in rows])


@router.delete("/conversations/{conversation_id}/context-refs/{edge_id}", status_code=204)
def remove_context_ref(
    conversation_id: UUID,
    edge_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    context_service.remove_context_ref(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id, edge_id=edge_id
    )
    db.commit()
    return Response(status_code=204)
