"""Current user endpoint.

Returns information about the authenticated viewer.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.reader import ReaderProfilePatch
from nexus.services import reader as reader_service

router = APIRouter()


@router.get("/me")
async def get_me(viewer: Annotated[Viewer, Depends(get_viewer)]) -> dict:
    """Get current user information.

    Requires authentication. Returns the authenticated user's ID
    and their default library ID.

    Returns:
        Success envelope with user_id and default_library_id.
    """
    return success_response(
        {
            "user_id": str(viewer.user_id),
            "default_library_id": str(viewer.default_library_id),
        }
    )


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
