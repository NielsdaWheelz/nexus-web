"""Durable chat-run API routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.conversation import ChatRunCreateRequest
from nexus.services import chat_runs as chat_runs_service

router = APIRouter(tags=["chat-runs"])


@router.post("/chat-runs", status_code=200)
def create_chat_run(
    body: ChatRunCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    result = chat_runs_service.create_chat_run(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=body.conversation_id,
        content=body.content,
        model_id=body.model_id,
        reasoning=body.reasoning,
        key_mode=body.key_mode,
        contexts=body.contexts,
        web_search=body.web_search,
        idempotency_key=idempotency_key,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/chat-runs")
def list_chat_runs(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    conversation_id: Annotated[UUID, Query()],
    status: Annotated[str, Query()] = "active",
) -> dict:
    results = chat_runs_service.list_chat_runs_for_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        status=status,
    )
    return success_response([result.model_dump(mode="json") for result in results])


@router.get("/chat-runs/{run_id}")
def get_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = chat_runs_service.get_chat_run(db=db, viewer_id=viewer.user_id, run_id=run_id)
    return success_response(result.model_dump(mode="json"))


@router.post("/chat-runs/{run_id}/cancel")
def cancel_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = chat_runs_service.cancel_chat_run(db=db, viewer_id=viewer.user_id, run_id=run_id)
    return success_response(result.model_dump(mode="json"))
