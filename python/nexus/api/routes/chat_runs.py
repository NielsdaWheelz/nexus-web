"""Durable chat-run API routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.conversation import CHAT_RUN_STATUS_FILTER, ChatRunCreateRequest
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
        chat_subject=body.chat_subject,
        reader_selection=body.reader_selection,
        parent_message_id=body.parent_message_id,
        branch_anchor=body.branch_anchor,
        content=body.content,
        model_id=body.model_id,
        reasoning=body.reasoning,
        key_mode=body.key_mode,
        idempotency_key=idempotency_key,
    )
    return ok(result)


@router.get("/chat-runs")
def list_chat_runs(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    conversation_id: Annotated[UUID, Query()],
    status: Annotated[CHAT_RUN_STATUS_FILTER, Query()] = "active",
) -> dict:
    results = chat_runs_service.list_chat_runs_for_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        status=status,
    )
    return ok(results)


@router.get("/chat-runs/{run_id}")
def get_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = chat_runs_service.get_chat_run(db=db, viewer_id=viewer.user_id, run_id=run_id)
    return ok(result)


@router.post("/chat-runs/{run_id}/cancel")
def cancel_chat_run(
    run_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = chat_runs_service.cancel_chat_run(db=db, viewer_id=viewer.user_id, run_id=run_id)
    return ok(result)


@router.post("/messages/{assistant_message_id}/retry", status_code=200)
def retry_failed_assistant_response(
    assistant_message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    result = chat_runs_service.retry_failed_assistant_response(
        db=db,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=idempotency_key,
    )
    return ok(result)


@router.post("/messages/{assistant_message_id}/resend", status_code=200)
def resend_assistant_response(
    assistant_message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    result = chat_runs_service.resend_assistant_response(
        db=db,
        viewer_id=viewer.user_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=idempotency_key,
    )
    return ok(result)
