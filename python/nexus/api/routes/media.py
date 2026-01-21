"""Media routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.services import media as media_service

router = APIRouter()


@router.get("/media/{media_id}")
def get_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get media by ID.

    Returns media metadata if the viewer can read it.
    Returns 404 if media does not exist or viewer cannot read it (masks existence).
    """
    result = media_service.get_media_for_viewer(db, viewer.user_id, media_id)
    return success_response(result.model_dump(mode="json"))


@router.get("/media/{media_id}/fragments")
def get_media_fragments(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get fragments for a media item.

    Returns fragments ordered by idx ASC if the viewer can read the media.
    Returns 404 if media does not exist or viewer cannot read it (masks existence).
    """
    result = media_service.list_fragments_for_viewer(db, viewer.user_id, media_id)
    return success_response([fragment.model_dump(mode="json") for fragment in result])
