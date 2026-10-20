"""Chat HTTP routes: sends and runs, conversations, the tree, quotes.

Run reads and commands each own a worker-thread session, so a client disconnect never
closes a session mid-transaction and lock waits never hold the event loop.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import get_generation_catalog
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import (
    DbSession,
    RepeatableReadDbSession,
    get_session_factory,
)
from nexus.responses import Data
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.conversation import (
    ChatAdmissionReceipt,
    ChatRunCreateRequest,
    ChatRunRepeatRequest,
    ChatRunResponse,
    ConversationListItemOut,
    ConversationOut,
    ConversationTreeOut,
    CreateConversationRequest,
    ForkTitleOut,
    ForkTitleRequest,
    MessageDeleteOut,
    ReaderSelectionKey,
    ReaderSelectionPreview,
)
from nexus.services.chat import admit, conversations, quotes, reads
from nexus.services.generation.catalog import Catalog
from nexus.services.tools.run import Toolbox

router = APIRouter(tags=["chat"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
CatalogDep = Annotated[Catalog, Depends(get_generation_catalog)]
KeyHeader = Annotated[str | None, Header(alias="Idempotency-Key")]


def _tools(request: Request) -> Toolbox:
    return request.app.state.toolbox


ToolsDep = Annotated[Toolbox, Depends(_tools)]


@router.post("/chat-runs")
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


@router.get("/chat-runs/{run_id}")
async def get_chat_run(run_id: UUID, viewer: ViewerDep) -> Data[ChatRunResponse]:
    def read() -> ChatRunResponse:
        with get_session_factory()() as db:
            return reads.run_response(db, viewer_id=viewer.user_id, run_id=run_id)

    return Data(data=await run_in_threadpool(read))


@router.post("/chat-runs/{run_id}/cancel")
async def cancel_chat_run(run_id: UUID, viewer: ViewerDep) -> Data[ChatRunResponse]:
    response = await run_in_threadpool(admit.cancel, viewer_id=viewer.user_id, run_id=run_id)
    return Data(data=response)


async def _repeat(
    operation: Literal["rerun", "regenerate"],
    assistant_message_id: UUID,
    body: ChatRunRepeatRequest,
    viewer: Viewer,
    catalog: Catalog,
    tools: Toolbox,
    idempotency_key: str | None,
) -> Data[ChatAdmissionReceipt]:
    receipt = await admit.repeat(
        operation=operation,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        selection=body.selection,
        expected_revision=body.expected_revision,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tools=tools,
    )
    return Data(data=receipt)


@router.post("/messages/{assistant_message_id}/rerun")
async def rerun_assistant_message(
    assistant_message_id: UUID,
    body: ChatRunRepeatRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatAdmissionReceipt]:
    return await _repeat(
        "rerun", assistant_message_id, body, viewer, catalog, tools, idempotency_key
    )


@router.post("/messages/{assistant_message_id}/regenerate")
async def regenerate_assistant_message(
    assistant_message_id: UUID,
    body: ChatRunRepeatRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatAdmissionReceipt]:
    return await _repeat(
        "regenerate", assistant_message_id, body, viewer, catalog, tools, idempotency_key
    )


@router.get("/conversations")
def list_conversations(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[ConversationListItemOut]]:
    """The owned-chat index: four views, literal title search and keyset paging.

    Optional ``media_id`` scopes current direct context by its endpoint's media owner.

    Errors:
        E_INVALID_REQUEST (400): a view outside the advertised four, an unknown query
            or repeated key, invalid media id, or title search over 200 characters.
        E_INVALID_CURSOR (400): malformed or mismatched viewer, media, search or view.
        E_MEDIA_NOT_FOUND (404): scoped media is missing or unreadable, including
            viewer tombstones and pending teardown.
    """

    items = request.query_params.multi_items()
    return Data(data=conversations.index(db, viewer_id=viewer.user_id, items=items))


@router.post("/conversations", status_code=201)
def create_conversation(
    body: CreateConversationRequest, viewer: ViewerDep, db: DbSession
) -> Data[ConversationOut]:
    """An empty chat with its initial context refs (a resource's "chat" action)."""

    return Data(
        data=conversations.create(
            db,
            viewer_id=viewer.user_id,
            conversation_id=body.id,
            initial_context_refs=body.initial_context_refs,
        )
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID,
    expected_revision: Annotated[int, Query(ge=0)],
    viewer: ViewerDep,
    db: DbSession,
) -> Response:
    conversations.delete_conversation(
        db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        expected_revision=expected_revision,
    )
    return Response(status_code=204)


@router.get("/conversations/{conversation_id}/tree")
def get_conversation_tree(
    conversation_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ConversationTreeOut]:
    return Data(data=reads.tree(db, viewer_id=viewer.user_id, conversation_id=conversation_id))


@router.patch("/messages/{message_id}/fork-title")
def rename_fork(
    message_id: UUID, body: ForkTitleRequest, viewer: ViewerDep, db: DbSession
) -> Data[ForkTitleOut]:
    return Data(
        data=conversations.rename_fork(
            db,
            viewer_id=viewer.user_id,
            message_id=message_id,
            title=body.title,
            expected=body.expected_title,
        )
    )


@router.delete("/messages/{message_id}")
def delete_message(
    message_id: UUID,
    conversation_id: UUID,
    expected_revision: Annotated[int, Query(ge=0)],
    viewer: ViewerDep,
    db: DbSession,
) -> Data[MessageDeleteOut]:
    """Delete a message and its subtree; the conversation too when it was the last."""

    return Data(
        data=conversations.delete_message(
            db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
            message_id=message_id,
            expected_revision=expected_revision,
        )
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
