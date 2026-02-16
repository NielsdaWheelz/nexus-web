"""Library routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.library import (
    AddMediaRequest,
    CreateLibraryRequest,
    TransferLibraryOwnershipRequest,
    UpdateLibraryMemberRequest,
    UpdateLibraryRequest,
)
from nexus.services import libraries as libraries_service

router = APIRouter()


@router.get("/libraries")
def list_libraries(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, description="Maximum results (clamped to 200)"),
) -> dict:
    """List all libraries the viewer is a member of.

    Returns libraries ordered by created_at ASC, id ASC.
    """
    result = libraries_service.list_libraries(db, viewer.user_id, limit=limit)
    return success_response([lib.model_dump(mode="json") for lib in result])


@router.post("/libraries", status_code=201)
def create_library(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: CreateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a new non-default library.

    The viewer becomes the owner and admin of the new library.
    """
    result = libraries_service.create_library(db, viewer.user_id, body.name)
    return success_response(result.model_dump(mode="json"))


@router.get("/libraries/{library_id}")
def get_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a single library by ID.

    Viewer must be a member. Non-members get masked 404.
    """
    result = libraries_service.get_library(db, viewer.user_id, library_id)
    return success_response(result.model_dump(mode="json"))


@router.patch("/libraries/{library_id}")
def rename_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Rename a library.

    Only admins can rename libraries. Cannot rename default library.
    """
    result = libraries_service.rename_library(db, viewer.user_id, library_id, body.name)
    return success_response(result.model_dump(mode="json"))


@router.delete("/libraries/{library_id}", status_code=204)
def delete_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a library.

    S4: owner-only for non-default libraries. Non-owner admins get 403 E_OWNER_REQUIRED.
    """
    libraries_service.delete_library(db, viewer.user_id, library_id)
    return Response(status_code=204)


# ---- Members ----


@router.get("/libraries/{library_id}/members")
def list_library_members(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, description="Maximum results (clamped to 200)"),
) -> dict:
    """List members of a library.

    Admin-only. Owner first, then admins, then members, then created_at ASC.
    """
    result = libraries_service.list_library_members(db, viewer.user_id, library_id, limit=limit)
    return success_response([m.model_dump(mode="json") for m in result])


@router.patch("/libraries/{library_id}/members/{user_id}")
def update_library_member_role(
    library_id: UUID,
    user_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: UpdateLibraryMemberRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update a library member's role.

    Admin-only. Cannot change owner role. Cannot demote last admin.
    Default library forbidden.
    """
    result = libraries_service.update_library_member_role(
        db, viewer.user_id, library_id, user_id, body.role
    )
    return success_response(result.model_dump(mode="json"))


@router.delete("/libraries/{library_id}/members/{user_id}", status_code=204)
def remove_library_member(
    library_id: UUID,
    user_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove a member from a library.

    Admin-only. Cannot remove owner. Cannot remove last admin.
    Default library forbidden. Idempotent for absent targets.
    """
    libraries_service.remove_library_member(db, viewer.user_id, library_id, user_id)
    return Response(status_code=204)


# ---- Ownership Transfer ----


@router.post("/libraries/{library_id}/transfer-ownership")
def transfer_library_ownership(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: TransferLibraryOwnershipRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Transfer library ownership to another member.

    Owner-only. Target must be existing member. Previous owner stays admin.
    Default library forbidden.
    """
    result = libraries_service.transfer_library_ownership(
        db, viewer.user_id, library_id, body.new_owner_user_id
    )
    return success_response(result.model_dump(mode="json"))


# ---- Library Media ----


@router.get("/libraries/{library_id}/media")
def list_library_media(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, description="Maximum results (clamped to 200)"),
) -> dict:
    """List media in a library.

    Returns media ordered by library_media.created_at DESC, media.id DESC.
    """
    result = libraries_service.list_library_media(db, viewer.user_id, library_id, limit=limit)
    return success_response([media.model_dump(mode="json") for media in result])


@router.post("/libraries/{library_id}/media", status_code=201)
def add_media_to_library(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    body: AddMediaRequest,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Add media to a library.

    Only admins can add media. Enforces default library closure.
    """
    result = libraries_service.add_media_to_library(db, viewer.user_id, library_id, body.media_id)
    return success_response(result.model_dump(mode="json"))


@router.delete("/libraries/{library_id}/media/{media_id}", status_code=204)
def remove_media_from_library(
    library_id: UUID,
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove media from a library.

    Only admins can remove media. Enforces default library closure rules.
    """
    libraries_service.remove_media_from_library(db, viewer.user_id, library_id, media_id)
    return Response(status_code=204)
