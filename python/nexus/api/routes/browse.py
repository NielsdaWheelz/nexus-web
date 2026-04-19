"""Global browse route."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.services import browse as browse_service

router = APIRouter()


@router.get("/browse")
def browse_content(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: Annotated[str, Query(min_length=1)],
    type: Annotated[
        Literal["all", "podcasts", "podcast_episodes", "videos", "documents"],
        Query(),
    ] = "all",
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> dict:
    """Browse globally discoverable acquisition results."""
    _ = viewer
    return success_response(
        browse_service.browse_content(
            db,
            q,
            result_type=type,
            limit=limit,
            cursor=cursor,
        )
    )
