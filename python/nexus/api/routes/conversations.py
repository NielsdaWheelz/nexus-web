"""Conversations API routes.

Route handlers for conversation CRUD operations.
Routes are transport-only: each calls exactly one service function.

Route contract:
- Conversations: GET (list/get), POST (create), DELETE

All routes require authentication.
The finite primary index returns strict CollectionPage data. The explicit
destination/context modes retain their existing {"data": [...], "page": {...}}
contracts.
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import ok, ok_page
from nexus.schemas.collection_page import parse_manual_page_query
from nexus.services import conversations as conversations_service

router = APIRouter(tags=["conversations"])


@router.get("/conversations")
def list_conversations(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List conversations.

    An explicit ``q`` selects the retained owned destination picker. An explicit
    ``has_context_ref`` selects the retained resource-graph mode; neither owns
    the ``sort``/``direction`` view keys. Every unmarked request, with optional
    ``scope`` and view keys, selects the finite primary index.

    Errors:
        E_INVALID_REQUEST (400): Invalid scope value, a view state outside the
            advertised inventory, malformed has_context_ref URI, or ``q``
            combined with another filter / over its length bound.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    raw_keys = {key for key, _value in request.query_params.multi_items()}
    if "q" in raw_keys or "has_context_ref" in raw_keys:
        mode_key = "q" if "q" in raw_keys else "has_context_ref"
        query = parse_manual_page_query(
            request.query_params.multi_items(),
            domain_keys=frozenset({mode_key}),
            default_limit=conversations_service.DEFAULT_LIMIT,
            max_limit=conversations_service.MAX_LIMIT,
        )
        conversations, page = conversations_service.list_retained_conversations(
            db=db,
            viewer_id=viewer.user_id,
            limit=query.limit,
            cursor=query.cursor,
            scope=None,
            has_context_ref=query.parameters.get("has_context_ref"),
            q=query.parameters.get("q"),
        )
        return ok_page(conversations, page)

    view, query = conversations_service.parse_conversation_index_query(
        request.query_params.multi_items()
    )
    page = conversations_service.list_conversation_index(
        db,
        viewer_id=viewer.user_id,
        limit=query.limit,
        cursor=query.cursor,
        collection_revision=query.collection_revision,
        scope=query.parameters.get("scope"),
        view=view,
    )
    return ok(page, by_alias=True)


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


@router.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Delete a conversation.

    Explicitly deletes its resource-graph edges, messages, conversation_shares,
    and chat runs in the service layer.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    result = conversations_service.delete_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return ok(result, by_alias=True)
