"""Durable chat-run API routes.

Each read and cancel opens its own worker-thread session: a client disconnect
cannot then close a session mid-transaction, and lock waits never hold the
event loop.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import (
    get_generation_catalog,
    require_chat_contract_revision,
    require_tool_projection_revision,
)
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.responses import Data
from nexus.schemas.conversation import (
    ChatAdmissionReceipt,
    ChatRunCreateRequest,
    ChatRunRepeatRequest,
    ChatRunResponse,
)
from nexus.schemas.presence import Present
from nexus.services import chat_runs as chat_runs_service
from nexus.services.generation.catalog import Catalog
from nexus.services.tool_runtime.catalog import ComposedToolRuntime

router = APIRouter(
    tags=["chat-runs"],
    dependencies=[
        Depends(require_chat_contract_revision),
        Depends(require_tool_projection_revision),
    ],
)


def _tool_runtime(request: Request) -> ComposedToolRuntime:
    runtime = request.app.state.tool_runtime
    if not isinstance(runtime, ComposedToolRuntime):
        raise AssertionError("application lacks the composed generation tool runtime")
    return runtime


@router.post("/chat-runs", status_code=200)
async def create_chat_run(
    request: Request,
    body: ChatRunCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[Catalog, Depends(get_generation_catalog)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> Data[ChatAdmissionReceipt]:
    receipt = await chat_runs_service.create_chat_run(
        viewer_id=viewer.user_id,
        destination=body.destination,
        reader_selection=(
            body.reader_selection.value if isinstance(body.reader_selection, Present) else None
        ),
        content=body.content,
        selection=body.selection,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=_tool_runtime(request),
    )
    return Data(data=receipt)


@router.get("/chat-runs/{run_id}")
async def get_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Data[ChatRunResponse]:
    def read() -> ChatRunResponse:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            return chat_runs_service.get_chat_run(
                db=db,
                viewer_id=viewer.user_id,
                run_id=run_id,
            )

    return Data(data=await run_in_threadpool(read))


@router.post("/chat-runs/{run_id}/cancel")
async def cancel_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Data[ChatRunResponse]:
    def cancel() -> ChatRunResponse:
        with get_session_factory()() as db:
            return chat_runs_service.cancel_chat_run(
                db=db,
                viewer_id=viewer.user_id,
                run_id=run_id,
            )

    response = await run_in_threadpool(cancel)
    return Data(data=response)


@router.post("/messages/{assistant_message_id}/rerun", status_code=200)
async def rerun_assistant_message(
    assistant_message_id: UUID,
    request: Request,
    body: ChatRunRepeatRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[Catalog, Depends(get_generation_catalog)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> Data[ChatRunResponse]:
    return Data(
        data=await chat_runs_service.repeat_assistant_response(
            operation="rerun",
            viewer_id=viewer.user_id,
            assistant_message_id=assistant_message_id,
            selection=body.selection,
            idempotency_key=idempotency_key,
            catalog=catalog,
            tool_runtime=_tool_runtime(request),
        )
    )


@router.post("/messages/{assistant_message_id}/regenerate", status_code=200)
async def regenerate_assistant_message(
    assistant_message_id: UUID,
    request: Request,
    body: ChatRunRepeatRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[Catalog, Depends(get_generation_catalog)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> Data[ChatRunResponse]:
    return Data(
        data=await chat_runs_service.repeat_assistant_response(
            operation="regenerate",
            viewer_id=viewer.user_id,
            assistant_message_id=assistant_message_id,
            selection=body.selection,
            idempotency_key=idempotency_key,
            catalog=catalog,
            tool_runtime=_tool_runtime(request),
        )
    )
