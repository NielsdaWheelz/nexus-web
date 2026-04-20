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
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
    page_type: Annotated[
        Literal["documents", "videos", "podcasts", "podcast_episodes"] | None,
        Query(),
    ] = None,
    cursor: Annotated[str | None, Query()] = None,
) -> dict:
    """Browse globally discoverable acquisition results."""
    _ = viewer
    return success_response(
        browse_service.browse_content(
            db,
            q,
            limit=limit,
            page_type=page_type,
            cursor=cursor,
        )
    )
