"""Durable chat-run API routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import get_generation_catalog_service, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.responses import ok
from nexus.schemas.conversation import (
    CHAT_RUN_STATUS_FILTER,
    ChatRunCreateRequest,
    ChatRunRepeatRequest,
    ChatRunResponse,
)
from nexus.schemas.presence import Present
from nexus.services import chat_run_candidates
from nexus.services import chat_runs as chat_runs_service
from nexus.services.generation_catalog import GenerationCatalogService
from nexus.services.tool_runtime.catalog import ComposedToolRuntime

router = APIRouter(
    tags=["chat-runs"],
    dependencies=[Depends(require_tool_projection_revision)],
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
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    reader_selection = (
        body.reader_selection.value if isinstance(body.reader_selection, Present) else None
    )
    result = await chat_runs_service.create_chat_run(
        viewer_id=viewer.user_id,
        destination=body.destination,
        reader_selection=reader_selection,
        content=body.content,
        catalog_definition_revision=body.catalog_definition_revision,
        selection=body.selection,
        tool_authority=body.tool_authority,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=_tool_runtime(request),
    )
    return ok(result)


@router.get("/chat-runs")
async def list_chat_runs(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
    conversation_id: Annotated[UUID, Query()],
    status: Annotated[CHAT_RUN_STATUS_FILTER, Query()] = "active",
) -> dict:
    snapshot = await catalog.read_chat()

    def read() -> list[ChatRunResponse]:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            return chat_runs_service.list_chat_runs_for_conversation(
                db=db,
                viewer_id=viewer.user_id,
                conversation_id=conversation_id,
                status=status,
                catalog_snapshot=snapshot,
            )

    return ok(await run_in_threadpool(read))


@router.get("/chat-runs/{run_id}")
async def get_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
) -> dict:
    snapshot = await catalog.read_chat()

    def read() -> ChatRunResponse:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            return chat_runs_service.get_chat_run(
                db=db,
                viewer_id=viewer.user_id,
                run_id=run_id,
                catalog_snapshot=snapshot,
            )

    return ok(await run_in_threadpool(read))


@router.post("/chat-runs/{run_id}/cancel")
async def cancel_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
) -> dict:
    snapshot = await catalog.read_chat()

    def cancel() -> ChatRunResponse:
        with get_session_factory()() as db:
            return chat_runs_service.cancel_chat_run(
                db=db,
                viewer_id=viewer.user_id,
                run_id=run_id,
                catalog_snapshot=snapshot,
            )

    return ok(await run_in_threadpool(cancel))


@router.post("/messages/{assistant_message_id}/rerun", status_code=200)
async def rerun_assistant_message(
    assistant_message_id: UUID,
    request: Request,
    body: ChatRunRepeatRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    result = await chat_run_candidates.repeat_assistant_response(
        operation="rerun",
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        catalog_definition_revision=body.catalog_definition_revision,
        selection=body.selection,
        tool_authority=body.tool_authority,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=_tool_runtime(request),
    )
    return ok(result)


@router.post("/messages/{assistant_message_id}/regenerate", status_code=200)
async def regenerate_assistant_message(
    assistant_message_id: UUID,
    request: Request,
    body: ChatRunRepeatRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    result = await chat_run_candidates.repeat_assistant_response(
        operation="regenerate",
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        catalog_definition_revision=body.catalog_definition_revision,
        selection=body.selection,
        tool_authority=body.tool_authority,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=_tool_runtime(request),
    )
    return ok(result)
