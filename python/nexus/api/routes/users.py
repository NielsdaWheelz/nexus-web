"""People search: find an existing user to share with or invite."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.user import UserSearchOut
from nexus.services import users as users_service

router = APIRouter(tags=["users"])


@router.get("/users/search")
def search_users(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=320)],
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
) -> Data[list[UserSearchOut]]:
    """Display name contains `q` (at least 3 characters), or email is exactly `q`."""
    return Data(data=users_service.search_users(db, q, viewer.user_id, limit))
