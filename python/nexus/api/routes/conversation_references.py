"""Conversation references API routes.

Routes for the polymorphic conversation_references table (see
``docs/conversation-references.md``). Each reference is an opaque
``<scheme>:<uuid>`` URI; resolution happens in the service layer via
``nexus.services.resource_resolver``.

Routes:
- GET    /api/conversations/{conversation_id}/references
- POST   /api/conversations/{conversation_id}/references
- DELETE /api/conversations/{conversation_id}/references/{reference_id}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import success_response
from nexus.services import conversation_references as references_service

router = APIRouter(tags=["conversation-references"])


class AddConversationReferenceRequest(BaseModel):
    """Request body for POST /api/conversations/{id}/references."""

    resource_uri: str

    model_config = ConfigDict(extra="forbid")


@router.get("/conversations/{conversation_id}/references")
def list_conversation_references(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List all references for a conversation, resolved with label/summary.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    rows = references_service.list_references(db, conversation_id, viewer_id=viewer.user_id)
    return {"data": [references_service.reference_to_api_payload(row) for row in rows]}


@router.post("/conversations/{conversation_id}/references", status_code=201)
def add_conversation_reference(
    conversation_id: UUID,
    body: AddConversationReferenceRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Add a reference to a conversation. Idempotent on (conversation_id, resource_uri).

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_INVALID_REQUEST (400): resource_uri is malformed.
    """
    row = references_service.add_reference(
        db, conversation_id, body.resource_uri, viewer_id=viewer.user_id
    )
    return success_response(references_service.reference_to_api_payload(row))


@router.delete(
    "/conversations/{conversation_id}/references/{reference_id}",
    status_code=204,
)
def remove_conversation_reference(
    conversation_id: UUID,
    reference_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a reference from a conversation.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_NOT_FOUND (404): Reference doesn't exist on this conversation.
    """
    references_service.remove_reference(db, conversation_id, reference_id, viewer_id=viewer.user_id)
    return Response(status_code=204)
