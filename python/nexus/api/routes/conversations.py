"""Conversation API routes: index, create, undo tool call, delete."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict

from nexus.api.deps import require_chat_contract_revision, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession, get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import Data
from nexus.schemas.collection_page import (
    CollectionPage,
    CollectionRevisionOut,
)
from nexus.schemas.conversation import (
    ConversationListItemOut,
    ConversationOut,
    TrustToolCallOut,
)
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
    db: RepeatableReadDbSession,
) -> Data[CollectionPage[ConversationListItemOut]]:
    """List conversations: the finite index, with optional literal ``title_search``.

    Errors:
        E_INVALID_REQUEST (400): a view state outside the advertised inventory, an
            unknown query key, or title search over its length bound.
        E_INVALID_CURSOR (400): the cursor is malformed or unparseable.
    """

    view, title_search, query = conversations_service.parse_conversation_index_query(
        request.query_params.multi_items()
    )
    return Data(
        data=conversations_service.list_conversation_index(
            db,
            viewer_id=viewer.user_id,
            limit=query.limit,
            cursor=query.cursor,
            collection_revision=query.collection_revision,
            view=view,
            title_search=title_search,
        ),
    )


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    body: Annotated[CreateConversationRequest | None, Body()] = None,
) -> Data[ConversationOut]:
    """Create an empty private conversation, with its initial context refs."""

    return Data(
        data=conversations_service.create_conversation(
            db=db,
            viewer_id=viewer.user_id,
            initial_context_refs=body.initial_context_refs if body is not None else None,
        )
    )


@router.post(
    "/conversations/{conversation_id}/tool-calls/{tool_call_id}/undo",
    dependencies=[
        Depends(require_chat_contract_revision),
        Depends(require_tool_projection_revision),
    ],
)
async def undo_tool_call(
    conversation_id: UUID,
    tool_call_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[TrustToolCallOut]:
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
    return Data(data=tool_call)


@router.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[CollectionRevisionOut]:
    """Delete a conversation and every row it owns; return the index revision."""

    return Data(
        data=conversations_service.delete_conversation(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
        )
    )
