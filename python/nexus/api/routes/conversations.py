"""Conversation API routes: index, create, get, undo tool call, delete."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from nexus.api.deps import require_chat_contract_revision, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import ok, ok_page
from nexus.schemas.collection_page import parse_manual_page_query
from nexus.services import conversations as conversations_service
from nexus.services.agent_tools.writes import undo_tool_call as revert_tool_call
from nexus.services.message_trust_trails import build_assistant_trust_trail

router = APIRouter(tags=["conversations"])


class CreateConversationRequest(BaseModel):
    initial_context_refs: list[str] | None = None

    model_config = ConfigDict(extra="forbid")


@router.get("/conversations")
def list_conversations(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List conversations.

    An explicit ``q`` selects the retained destination picker and an explicit
    ``has_context_ref`` the retained resource-graph mode; both keep the manual
    ``{data, page}`` envelope. Every other request is the finite primary index.

    Errors:
        E_INVALID_REQUEST (400): a view state outside the advertised inventory,
            a malformed has_context_ref URI, or ``q`` over its length bound.
        E_INVALID_CURSOR (400): the cursor is malformed or unparseable.
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
        if mode_key == "q":
            conversations, page = conversations_service.list_conversations_matching_title(
                db,
                viewer_id=viewer.user_id,
                limit=query.limit,
                cursor=query.cursor,
                q=query.parameters["q"],
            )
        else:
            conversations, page = conversations_service.list_conversations_with_context_ref(
                db,
                viewer_id=viewer.user_id,
                has_context_ref=query.parameters["has_context_ref"],
                limit=query.limit,
                cursor=query.cursor,
            )
        return ok_page(conversations, page)

    view, query = conversations_service.parse_conversation_index_query(
        request.query_params.multi_items()
    )
    return ok(
        conversations_service.list_conversation_index(
            db,
            viewer_id=viewer.user_id,
            limit=query.limit,
            cursor=query.cursor,
            collection_revision=query.collection_revision,
            view=view,
        ),
        by_alias=True,
    )


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    body: Annotated[CreateConversationRequest | None, Body()] = None,
) -> dict:
    """Create an empty private conversation, with its initial context refs."""

    return ok(
        conversations_service.create_conversation(
            db=db,
            viewer_id=viewer.user_id,
            initial_context_refs=body.initial_context_refs if body is not None else None,
        )
    )


@router.get("/conversations/{conversation_id}")
def get_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    return ok(
        conversations_service.get_conversation(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
        )
    )


@router.post(
    "/conversations/{conversation_id}/tool-calls/{tool_call_id}/undo",
    dependencies=[
        Depends(require_tool_projection_revision),
        Depends(require_chat_contract_revision),
    ],
)
async def undo_tool_call(
    conversation_id: UUID,
    tool_call_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Revert one assistant write tool call's created refs. Idempotent."""

    assistant_message_id = revert_tool_call(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        tool_call_id=tool_call_id,
    )
    # The write owner committed (or replayed read-only). Hydrate the returned
    # trail from a fresh snapshot, never its retained pre-commit rows.
    db.rollback()
    get_repeatable_read_db(db)
    db.expire_all()
    trail = build_assistant_trust_trail(
        db,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
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
    """Delete a conversation and every row it owns; return the index revision."""

    return ok(
        conversations_service.delete_conversation(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
        ),
        by_alias=True,
    )
