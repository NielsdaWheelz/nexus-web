"""Conversation context-ref routes (spec §10.1).

Context refs are ``resource_edges`` rows sourced from the conversation. Admission
semantics live in ``nexus.services.resource_graph.context``.

Routes:
- GET    /conversations/{conversation_id}/context-refs
- POST   /conversations/{conversation_id}/context-refs
- DELETE /conversations/{conversation_id}/context-refs/{edge_id}

(`GET /conversations?has_context_ref=` lives with the conversations routes.)
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.resource_graph import AddContextRefRequest, ContextRefOut
from nexus.services.resource_graph import context as context_service
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph.refs import ResourceRef

router = APIRouter(tags=["conversation-context"])


def _parse_ref_or_400(raw: str) -> ResourceRef:
    parsed = refs_service.parse_resource_ref(raw)
    if isinstance(parsed, refs_service.ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    return parsed


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


@router.post("/conversations/{conversation_id}/context-refs", status_code=201)
def add_context_ref(
    conversation_id: UUID,
    body: AddContextRefRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Attach a resource to the conversation context. Idempotent per pair.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): conversation doesn't exist or viewer is not owner.
        E_INVALID_REQUEST (400): resource_ref is malformed.
        E_NOT_FOUND (404): the resource does not exist or is not visible.
    """
    target = _parse_ref_or_400(body.resource_ref)
    row = context_service.add_context_ref_without_commit(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        target=target,
        origin="user",
    )
    db.commit()
    return ok(_context_ref_out(row))


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
