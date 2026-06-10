"""Conversations API routes.

Route handlers for conversation CRUD operations.
Routes are transport-only: each calls exactly one service function.

Route contract:
- Conversations: GET (list/get), POST (create), DELETE

All routes require authentication.
Response envelope: {"data": ...} or {"data": [...], "page": {...}}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Query, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, ok_page
from nexus.services import conversations as conversations_service

router = APIRouter(tags=["conversations"])


@router.get("/conversations")
def list_conversations(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=100, description="Maximum results (1-100)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    scope: str | None = Query(default=None, description="Scope: mine|all|shared"),
    has_context_ref: str | None = Query(
        default=None,
        description="Filter to conversations with a context edge to this resource URI",
    ),
) -> dict:
    """List conversations.

    When ``has_context_ref`` is supplied, returns conversations with any edge to
    the given resource URI (single-user: viewer-owned only); ``scope`` is ignored
    in that case. Otherwise lists by visibility scope (mine|all|shared).

    Returns conversations ordered by updated_at DESC, id DESC.
    Supports cursor-based pagination.

    Errors:
        E_INVALID_REQUEST (400): Invalid scope value or malformed has_context_ref URI.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    conversations, page = conversations_service.list_conversations(
        db=db,
        viewer_id=viewer.user_id,
        limit=limit,
        cursor=cursor,
        scope=scope,
        has_context_ref=has_context_ref,
    )
    return ok_page(conversations, page)


class CreateConversationRequest(BaseModel):
    """Request body for POST /api/conversations."""

    initial_references: list[str] | None = None

    model_config = ConfigDict(extra="forbid")


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    body: Annotated[CreateConversationRequest | None, Body()] = None,
) -> dict:
    """Create an empty private conversation.

    If ``initial_references`` is supplied, each URI is added as a conversation
    context edge in order (validation + insert via the context service). On
    failure the surrounding request transaction rolls back.

    Returns 201 Created with the conversation object.
    """
    initial_references = body.initial_references if body is not None else None
    result = conversations_service.create_conversation(
        db=db,
        viewer_id=viewer.user_id,
        initial_references=initial_references,
    )
    return ok(result)


@router.get("/conversations/{conversation_id}")
def get_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a conversation by ID.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    result = conversations_service.get_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return ok(result)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a conversation.

    Explicitly deletes its resource-graph edges, messages, conversation_media,
    conversation_shares, and chat runs in the service layer.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    conversations_service.delete_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return Response(status_code=204)
