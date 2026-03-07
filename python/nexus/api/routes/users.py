"""User routes.

User search endpoint for finding users by email or display name.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.services import users as users_service

router = APIRouter()


@router.get("/users/search")
def search_users(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: Annotated[str, Query(min_length=1, description="Search query (min 3 chars)")],
    limit: Annotated[int, Query(ge=1, le=20, description="Max results")] = 10,
) -> dict:
    """Search users by email prefix or display name.

    Authenticated endpoint. Returns matching users excluding the searcher.
    Minimum query length: 3 characters.
    """
    results = users_service.search_users(db, q, viewer.user_id, limit=limit)
    return success_response([r.model_dump(mode="json") for r in results])
