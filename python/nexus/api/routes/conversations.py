"""Conversation API routes: index, create, get, undo tool call, delete."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request
from pydantic import BaseModel, ConfigDict

from nexus.api.deps import require_chat_contract_revision, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession, get_repeatable_read_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import Data, DataPage, ok
from nexus.schemas.collection_page import CollectionPage, parse_manual_page_query
from nexus.schemas.conversation import ConversationListItemOut, ConversationOut, PageInfo
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
) -> Data[CollectionPage[ConversationListItemOut]] | DataPage[ConversationOut, PageInfo]:
    """List conversations.

    An explicit ``has_context_ref`` selects the retained resource-graph mode
    with its manual ``{data, page}`` envelope. Every other request is the finite
    index, with optional literal ``title_search``.

    Errors:
        E_INVALID_REQUEST (400): a view state outside the advertised inventory,
            a malformed has_context_ref URI, or title search over its length bound.
        E_INVALID_CURSOR (400): the cursor is malformed or unparseable.
    """

    if "has_context_ref" in request.query_params:
        query = parse_manual_page_query(
            request.query_params.multi_items(),
            domain_keys=frozenset({"has_context_ref"}),
            default_limit=conversations_service.DEFAULT_LIMIT,
            max_limit=conversations_service.MAX_LIMIT,
        )
        conversations, page = conversations_service.list_conversations_with_context_ref(
            db,
            viewer_id=viewer.user_id,
            has_context_ref=query.parameters["has_context_ref"],
            limit=query.limit,
            cursor=query.cursor,
        )
        return DataPage(data=conversations, page=page)

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
    db: RepeatableReadDbSession,
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
        Depends(require_chat_contract_revision),
        Depends(require_tool_projection_revision),
    ],
)
async def undo_tool_call(
    conversation_id: UUID,
    tool_call_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
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
    db: DbSession,
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
