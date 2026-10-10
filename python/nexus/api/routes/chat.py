"""Chat HTTP routes: sends and runs, conversations, the tree, quotes.

Run reads and commands each own a worker-thread session, so a client disconnect never
closes a session mid-transaction and lock waits never hold the event loop.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import (
    get_generation_catalog,
    require_chat_contract_revision,
    require_tool_projection_revision,
)
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import (
    DbSession,
    RepeatableReadDbSession,
    get_repeatable_read_db,
    get_session_factory,
)
from nexus.responses import Data
from nexus.schemas.collection_page import CollectionPage, CollectionRevisionOut
from nexus.schemas.conversation import (
    ChatAdmissionReceipt,
    ChatRunCreateRequest,
    ChatRunRepeatRequest,
    ChatRunResponse,
    ConversationListItemOut,
    ConversationOut,
    ConversationTreeOut,
    CreateConversationRequest,
    ForkTitleRequest,
    MessageDeleteOut,
    ReaderSelectionKey,
    ReaderSelectionPreview,
    SetActivePathRequest,
    TrustToolCallOut,
)
from nexus.services.agent_tools.writes import undo_tool_call as revert_tool_call
from nexus.services.chat import admit, conversations, quotes, reads
from nexus.services.generation.catalog import Catalog
from nexus.services.tool_runtime.catalog import ComposedToolRuntime

router = APIRouter(tags=["chat"])
CONTRACT = [Depends(require_chat_contract_revision), Depends(require_tool_projection_revision)]
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
CatalogDep = Annotated[Catalog, Depends(get_generation_catalog)]
KeyHeader = Annotated[str | None, Header(alias="Idempotency-Key")]


def _tools(request: Request) -> ComposedToolRuntime:
    return request.app.state.tool_runtime


ToolsDep = Annotated[ComposedToolRuntime, Depends(_tools)]


@router.post("/chat-runs", dependencies=CONTRACT)
async def create_chat_run(
    body: ChatRunCreateRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatAdmissionReceipt]:
    receipt = await admit.create_chat_run(
        viewer_id=viewer.user_id,
        request=body,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tools=tools,
    )
    return Data(data=receipt)


@router.get("/chat-runs/{run_id}", dependencies=CONTRACT)
async def get_chat_run(run_id: UUID, viewer: ViewerDep) -> Data[ChatRunResponse]:
    def read() -> ChatRunResponse:
        with get_session_factory()() as db:
            return reads.run_response(db, viewer_id=viewer.user_id, run_id=run_id)

    return Data(data=await run_in_threadpool(read))


@router.post("/chat-runs/{run_id}/cancel", dependencies=CONTRACT)
async def cancel_chat_run(run_id: UUID, viewer: ViewerDep) -> Data[ChatRunResponse]:
    response = await run_in_threadpool(admit.cancel, viewer_id=viewer.user_id, run_id=run_id)
    return Data(data=response)


async def _repeat(
    operation: Literal["rerun", "regenerate"],
    assistant_message_id: UUID,
    body: ChatRunRepeatRequest,
    viewer: Viewer,
    catalog: Catalog,
    tools: ComposedToolRuntime,
    idempotency_key: str | None,
) -> Data[ChatRunResponse]:
    response = await admit.repeat(
        operation=operation,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        selection=body.selection,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tools=tools,
    )
    return Data(data=response)


@router.post("/messages/{assistant_message_id}/rerun", dependencies=CONTRACT)
async def rerun_assistant_message(
    assistant_message_id: UUID,
    body: ChatRunRepeatRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatRunResponse]:
    return await _repeat(
        "rerun", assistant_message_id, body, viewer, catalog, tools, idempotency_key
    )


@router.post("/messages/{assistant_message_id}/regenerate", dependencies=CONTRACT)
async def regenerate_assistant_message(
    assistant_message_id: UUID,
    body: ChatRunRepeatRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatRunResponse]:
    return await _repeat(
        "regenerate", assistant_message_id, body, viewer, catalog, tools, idempotency_key
    )


@router.get("/conversations")
def list_conversations(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[ConversationListItemOut]]:
    """The chats index: four views, a literal ``title_search``, revision-bound paging.

    Errors:
        E_INVALID_REQUEST (400): a view outside the advertised four, an unknown query
            key, or a title search over 200 characters.
        E_INVALID_CURSOR (400): the cursor is malformed or unparseable.
    """

    items = request.query_params.multi_items()
    return Data(data=conversations.index(db, viewer_id=viewer.user_id, items=items))


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: ViewerDep,
    db: DbSession,
    body: Annotated[CreateConversationRequest | None, Body()] = None,
) -> Data[ConversationOut]:
    """An empty chat with its initial context refs (a resource's "chat" action)."""

    refs = body.initial_context_refs if body is not None else None
    return Data(data=conversations.create(db, viewer_id=viewer.user_id, initial_context_refs=refs))


@router.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[CollectionRevisionOut]:
    deleted = conversations.delete_conversation(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id
    )
    return Data(data=deleted)


@router.get("/conversations/{conversation_id}/tree", dependencies=CONTRACT)
def get_conversation_tree(
    conversation_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ConversationTreeOut]:
    return Data(data=reads.tree(db, viewer_id=viewer.user_id, conversation_id=conversation_id))


@router.post("/conversations/{conversation_id}/active-path", status_code=204, dependencies=CONTRACT)
def set_active_path(
    conversation_id: UUID, body: SetActivePathRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    conversations.select_leaf(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        leaf_id=body.active_leaf_message_id,
    )
    return Response(status_code=204)


@router.post(
    "/conversations/{conversation_id}/tool-calls/{tool_call_id}/undo", dependencies=CONTRACT
)
def undo_tool_call(
    conversation_id: UUID, tool_call_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[TrustToolCallOut]:
    """Revert one assistant write's created refs. Idempotent."""

    assistant_message_id = revert_tool_call(
        db, viewer_id=viewer.user_id, conversation_id=conversation_id, tool_call_id=tool_call_id
    )
    # The write owner committed (or replayed read-only): read the call from a fresh
    # snapshot, never its retained pre-commit rows.
    db.rollback()
    get_repeatable_read_db(db)
    db.expire_all()
    call = reads.tool_call(
        db,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        tool_call_id=tool_call_id,
    )
    return Data(data=call)


@router.patch("/messages/{message_id}/fork-title", status_code=204)
def rename_fork(
    message_id: UUID, body: ForkTitleRequest, viewer: ViewerDep, db: DbSession
) -> Response:
    conversations.rename_fork(db, viewer_id=viewer.user_id, message_id=message_id, title=body.title)
    return Response(status_code=204)


@router.delete("/messages/{message_id}")
def delete_message(message_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[MessageDeleteOut]:
    """Delete a message and its subtree; the conversation too when it was the last."""

    return Data(
        data=conversations.delete_message(db, viewer_id=viewer.user_id, message_id=message_id)
    )


@router.get("/chat-reader-selections/highlights/{highlight_id}")
def get_reader_selection_preview(
    highlight_id: UUID,
    viewer: ViewerDep,
    db: DbSession,
    media_id: Annotated[UUID, Query(description="The key's parent media id")],
) -> Data[ReaderSelectionPreview]:
    key = ReaderSelectionKey(media_id=media_id, highlight_id=highlight_id)
    return Data(data=quotes.preview(db, viewer_id=viewer.user_id, key=key))
