"""The account librarian timeline and immutable turn commands."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request, Response
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import get_generation_catalog
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession, get_session_factory
from nexus.responses import Data
from nexus.schemas.chat import (
    AttachmentOut,
    ChatAdmissionReceipt,
    ChatRunCreateRequest,
    ChatRunResponse,
    ChatRunRetryRequest,
    ResolveLibrarianAttachmentsRequest,
    ResolveLibrarianTurnsRequest,
    TimelineOut,
)
from nexus.schemas.chat_selection import ChatSelectionOut
from nexus.schemas.collection_index import CollectionIndex, parse_index_query
from nexus.services.chat import admit, reads, references, selection, timeline
from nexus.services.generation.catalog import Catalog
from nexus.services.tools.run import Toolbox

router = APIRouter(tags=["chat"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
CatalogDep = Annotated[Catalog, Depends(get_generation_catalog)]
KeyHeader = Annotated[str | None, Header(alias="Idempotency-Key")]


def _tools(request: Request) -> Toolbox:
    return request.app.state.toolbox


ToolsDep = Annotated[Toolbox, Depends(_tools)]


@router.get("/me/chat-selection")
def get_chat_selection(
    response: Response, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ChatSelectionOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return Data(data=selection.read(db, user_id=viewer.user_id))


@router.get("/librarian/messages")
def get_messages(
    request: Request,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    around_message_id: UUID | None = None,
) -> Data[TimelineOut]:
    parse_index_query(request.query_params.multi_items(), domain_keys={"around_message_id"})
    return Data(
        data=timeline.index(db, viewer_id=viewer.user_id, around_message_id=around_message_id)
    )


@router.post("/librarian/turns/resolve")
def resolve_librarian_turns(
    body: ResolveLibrarianTurnsRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionIndex[ChatRunResponse]]:
    items = timeline.resolve(db, viewer_id=viewer.user_id, run_ids=body.run_ids)
    return Data(data=CollectionIndex(items=items))


@router.post("/chat-runs")
async def create_chat_run(
    body: ChatRunCreateRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatAdmissionReceipt]:
    return Data(
        data=await admit.create_chat_run(
            viewer_id=viewer.user_id,
            request=body,
            idempotency_key=idempotency_key,
            catalog=catalog,
            tools=tools,
        )
    )


@router.post("/librarian/attachments/resolve")
def resolve_librarian_attachments(
    body: ResolveLibrarianAttachmentsRequest,
    response: Response,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
) -> Data[list[AttachmentOut]]:
    response.headers["Cache-Control"] = "private, no-store"
    return Data(data=references.read_attachments(db, viewer.user_id, body.attachments))


@router.get("/chat-runs/{run_id}")
async def get_chat_run(run_id: UUID, viewer: ViewerDep) -> Data[ChatRunResponse]:
    def read() -> ChatRunResponse:
        with get_session_factory()() as db:
            return reads.run_response(db, viewer_id=viewer.user_id, run_id=run_id)

    return Data(data=await run_in_threadpool(read))


@router.post("/chat-runs/{run_id}/cancel")
async def cancel_chat_run(run_id: UUID, viewer: ViewerDep) -> Data[ChatRunResponse]:
    return Data(data=await run_in_threadpool(admit.cancel, viewer_id=viewer.user_id, run_id=run_id))


@router.post("/chat-runs/{run_id}/retry")
async def retry_turn(
    run_id: UUID,
    body: ChatRunRetryRequest,
    viewer: ViewerDep,
    catalog: CatalogDep,
    tools: ToolsDep,
    idempotency_key: KeyHeader = None,
) -> Data[ChatAdmissionReceipt]:
    return Data(
        data=await admit.retry(
            viewer_id=viewer.user_id,
            source_run_id=run_id,
            selection=body.selection,
            expected_deletion_revision=body.expected_deletion_revision,
            idempotency_key=idempotency_key,
            catalog=catalog,
            tools=tools,
        )
    )


@router.delete("/chat-runs/{run_id}", status_code=204)
def delete_turn(run_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    timeline.delete_turn(db, viewer_id=viewer.user_id, run_id=run_id)
    return Response(status_code=204)
