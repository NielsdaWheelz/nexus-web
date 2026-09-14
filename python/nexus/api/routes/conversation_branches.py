"""Conversation branch/fork API routes.

Routes for the conversation branch tree: active-path selection and fork
list/rename/delete. Each route is transport-only and calls exactly one
service function.

Routes:
- GET    /api/conversations/{conversation_id}/tree
- POST   /api/conversations/{conversation_id}/active-path
- GET    /api/conversations/{conversation_id}/forks
- PATCH  /api/conversations/{conversation_id}/forks/{branch_id}
- DELETE /api/conversations/{conversation_id}/forks/{branch_id}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.conversation import RenameBranchRequest, SetActivePathRequest
from nexus.services import conversation_branches as conversation_branches_service

router = APIRouter(tags=["conversation-branches"])


@router.get("/conversations/{conversation_id}/tree")
def get_conversation_tree(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversation_branches_service.get_conversation_tree(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return ok(result)


@router.post("/conversations/{conversation_id}/active-path")
def set_conversation_active_path(
    conversation_id: UUID,
    body: SetActivePathRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversation_branches_service.set_active_path(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        active_leaf_message_id=body.active_leaf_message_id,
    )
    return ok(result)


@router.get("/conversations/{conversation_id}/forks")
def list_conversation_forks(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    search: str | None = Query(default=None, description="Fork search query"),
) -> dict:
    result = conversation_branches_service.list_forks(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        search=search,
    )
    return ok(result)


@router.patch("/conversations/{conversation_id}/forks/{branch_id}")
def rename_conversation_fork(
    conversation_id: UUID,
    branch_id: UUID,
    body: RenameBranchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = conversation_branches_service.rename_branch(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        branch_id=branch_id,
        title=body.title,
    )
    return ok(result)


@router.delete("/conversations/{conversation_id}/forks/{branch_id}", status_code=204)
def delete_conversation_fork(
    conversation_id: UUID,
    branch_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    conversation_branches_service.delete_branch(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        branch_id=branch_id,
    )
    return Response(status_code=204)
