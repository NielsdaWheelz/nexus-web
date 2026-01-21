"""Current user endpoint.

Returns information about the authenticated viewer.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response

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
