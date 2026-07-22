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
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import ok, ok_page
from nexus.schemas.artifact import (
    ArtifactBuildOut,
    ConversationDistillateOut,
    ConversationDistillOut,
    RevisionStatus,
)
from nexus.services import conversations as conversations_service
from nexus.services.artifacts import distillate as distillate_service

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
    q: str | None = Query(
        default=None,
        description="Owned-scope title search (destination picker); composes only with cursor/limit",
    ),
) -> dict:
    """List conversations.

    When ``q`` is supplied, forces owned scope and title-searches; it composes
    only with cursor/limit and rejects any other scope/context filter. When
    ``has_context_ref`` is supplied, returns conversations with any edge to the
    given resource URI (single-user: viewer-owned only); ``scope`` is ignored in
    that case. Otherwise lists by visibility scope (mine|all|shared).

    Returns conversations ordered by updated_at DESC, id DESC.
    Supports cursor-based pagination.

    Errors:
        E_INVALID_REQUEST (400): Invalid scope value, malformed has_context_ref
            URI, or ``q`` combined with another filter / over its length bound.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    conversations, page = conversations_service.list_conversations(
        db=db,
        viewer_id=viewer.user_id,
        limit=limit,
        cursor=cursor,
        scope=scope,
        has_context_ref=has_context_ref,
        q=q,
    )
    return ok_page(conversations, page)


class CreateConversationRequest(BaseModel):
    """Request body for POST /api/conversations."""

    initial_context_refs: list[str] | None = None

    model_config = ConfigDict(extra="forbid")


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    body: Annotated[CreateConversationRequest | None, Body()] = None,
) -> dict:
    """Create an empty private conversation.

    If ``initial_context_refs`` is supplied, each URI is added as a conversation
    context edge in order (validation + insert via the context service). On
    failure the surrounding request transaction rolls back.

    Returns 201 Created with the conversation object.
    """
    initial_context_refs = body.initial_context_refs if body is not None else None
    result = conversations_service.create_conversation(
        db=db,
        viewer_id=viewer.user_id,
        initial_context_refs=initial_context_refs,
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


@router.post("/conversations/{conversation_id}/distill", status_code=202)
def distill_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Distill a conversation on demand (the ``Distill`` verb).

    Enqueues an artifact revision over the shared generation-run plane and returns
    the revision id (the revision IS the run).

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    from typing import cast

    ref = distillate_service.distill(db, viewer_id=viewer.user_id, conversation_id=conversation_id)
    return ok(
        ConversationDistillOut(
            artifact_id=ref.artifact_id,
            revision_id=ref.revision_id,
            revision_ref=f"artifact_revision:{ref.revision_id}",
            status=cast("RevisionStatus", ref.status),
        )
    )


@router.get("/conversations/{conversation_id}/distillate")
def get_conversation_distillate(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return the conversation's current distillate content + citations.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    from typing import cast

    view = distillate_service.read_distillate(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id
    )
    build = (
        ArtifactBuildOut(
            revision_id=view.build.revision_id,
            status=cast("RevisionStatus", view.build.status),
        )
        if view.build is not None
        else None
    )
    return ok(
        ConversationDistillateOut(
            artifact_id=view.artifact_id,
            revision_id=view.revision_id,
            revision_ref=(
                f"artifact_revision:{view.revision_id}" if view.revision_id is not None else None
            ),
            status=view.status,
            content_md=view.content_md,
            citations=view.citations,
            build=build,
        )
    )


@router.post("/conversations/{conversation_id}/tool-calls/{tool_call_id}/undo")
def undo_tool_call(
    conversation_id: UUID,
    tool_call_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Revert one assistant write tool call's created refs (amanuensis §6).

    Owner-gated on the conversation; idempotent (a second undo is a no-op 200).
    Returns the updated ``TrustToolCallOut``.

    Errors:
        E_NOT_FOUND (404): The tool call is not a write tool of this conversation.
    """
    from nexus.services.agent_tools.writes import undo_tool_call as revert_tool_call
    from nexus.services.message_trust_trails import build_assistant_trust_trail

    assistant_message_id = revert_tool_call(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        tool_call_id=tool_call_id,
    )
    trail = build_assistant_trust_trail(
        db, viewer_id=viewer.user_id, assistant_message_id=assistant_message_id
    )
    tool_call = next((call for call in trail.tool_calls if call.id == tool_call_id), None)
    if tool_call is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Write tool call not found")
    return ok(tool_call)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a conversation.

    Explicitly deletes its resource-graph edges, messages, conversation_shares,
    and chat runs in the service layer.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    conversations_service.delete_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return Response(status_code=204)
