"""Current user endpoint.

Returns information about the authenticated viewer including profile fields.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.command_palette import CommandPaletteSelectionRecordRequest
from nexus.schemas.reader import ReaderProfilePatch
from nexus.schemas.user import UpdateProfileRequest
from nexus.services import command_palette as command_palette_service
from nexus.services import reader as reader_service
from nexus.services import users as users_service

router = APIRouter()


@router.get("/me")
def get_me(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get current user information.

    Requires authentication. Returns the authenticated user's ID,
    default library ID, email, and display name.
    """
    profile = users_service.get_user_profile(
        db, viewer.user_id, viewer.default_library_id, viewer.email
    )
    return success_response(profile.model_dump(mode="json"))


@router.patch("/me")
def patch_me(
    body: UpdateProfileRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update user profile (display_name)."""
    users_service.update_display_name(db, viewer.user_id, body.display_name)
    profile = users_service.get_user_profile(
        db, viewer.user_id, viewer.default_library_id, viewer.email
    )
    return success_response(profile.model_dump(mode="json"))


@router.get("/me/reader-profile")
def get_reader_profile(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get reader profile (per-user defaults). Returns defaults when none exists."""
    result = reader_service.get_reader_profile(db, viewer.user_id)
    return success_response(result.model_dump(mode="json"))


@router.patch("/me/reader-profile")
def patch_reader_profile(
    body: ReaderProfilePatch,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update reader profile (partial)."""
    result = reader_service.patch_reader_profile(db, viewer.user_id, body)
    return success_response(result.model_dump(mode="json"))


@router.get("/me/palette-history")
def get_palette_history(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    query: Annotated[str | None, Query(max_length=500)] = None,
) -> dict:
    """Get command palette usage history for the current viewer."""
    result = command_palette_service.get_history_for_viewer(db, viewer.user_id, query=query)
    return success_response(result.model_dump(mode="json"))


@router.post("/me/palette-selections")
def post_palette_selection(
    body: CommandPaletteSelectionRecordRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Record one accepted command palette selection for the current viewer."""
    result = command_palette_service.record_selection_for_viewer(
        db,
        viewer.user_id,
        body,
    )
    return success_response(result.model_dump(mode="json"))
