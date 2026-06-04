"""Message retrieval/rerank ledger API routes.

Read-only inspection of an assistant message's retrieval-candidate and rerank
ledgers. Each route is transport-only and calls exactly one service function.

Routes:
- GET /api/messages/{message_id}/retrieval-candidate-ledgers
- GET /api/messages/{message_id}/rerank-ledgers
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.services import message_retrievals as message_retrievals_service

router = APIRouter(tags=["message-retrievals"])


@router.get("/messages/{message_id}/retrieval-candidate-ledgers")
def list_message_retrieval_candidate_ledgers(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    tool_call_id: Annotated[
        UUID | None,
        Query(description="Optional retrieval tool-call filter"),
    ] = None,
) -> dict:
    result = message_retrievals_service.list_message_retrieval_candidate_ledgers(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
        tool_call_id=tool_call_id,
    )
    return ok(result)


@router.get("/messages/{message_id}/rerank-ledgers")
def list_message_rerank_ledgers(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    tool_call_id: Annotated[
        UUID | None,
        Query(description="Optional retrieval tool-call filter"),
    ] = None,
) -> dict:
    result = message_retrievals_service.list_message_rerank_ledgers(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
        tool_call_id=tool_call_id,
    )
    return ok(result)
