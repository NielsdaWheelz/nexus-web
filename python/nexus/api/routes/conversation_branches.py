"""Conversation branch routes: the tree, the active path, and fork editing."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_generation_catalog_service, require_tool_projection_revision
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.responses import ok
from nexus.schemas.conversation import RenameBranchRequest, SetActivePathRequest
from nexus.services import conversation_branches as conversation_branches_service
from nexus.services.generation_catalog import GenerationCatalogService

router = APIRouter(tags=["conversation-branches"])


@router.get(
    "/conversations/{conversation_id}/tree",
    dependencies=[Depends(require_tool_projection_revision)],
)
async def get_conversation_tree(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
) -> dict:
    catalog_snapshot = await catalog.read_chat()
    get_repeatable_read_db(db)
    return ok(
        conversation_branches_service.get_conversation_tree(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
            catalog_snapshot=catalog_snapshot,
        )
    )


@router.post(
    "/conversations/{conversation_id}/active-path",
    dependencies=[Depends(require_tool_projection_revision)],
)
async def set_conversation_active_path(
    conversation_id: UUID,
    body: SetActivePathRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    catalog: Annotated[GenerationCatalogService, Depends(get_generation_catalog_service)],
) -> dict:
    catalog_snapshot = await catalog.read_chat()
    return ok(
        conversation_branches_service.set_active_path(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
            active_leaf_message_id=body.active_leaf_message_id,
            catalog_snapshot=catalog_snapshot,
        )
    )


@router.get("/conversations/{conversation_id}/forks")
def list_conversation_forks(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    search: str | None = Query(default=None, description="Fork search query"),
) -> dict:
    return ok(
        conversation_branches_service.list_forks(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
            search=search,
        )
    )


@router.patch("/conversations/{conversation_id}/forks/{branch_id}")
def rename_conversation_fork(
    conversation_id: UUID,
    branch_id: UUID,
    body: RenameBranchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        conversation_branches_service.rename_branch(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
            branch_id=branch_id,
            title=body.title,
        )
    )


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
