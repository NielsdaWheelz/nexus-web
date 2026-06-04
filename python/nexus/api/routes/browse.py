"""Global browse route."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import success_response
from nexus.services import browse as browse_service
from nexus.services.browse import BrowseSectionType

router = APIRouter(tags=["browse"])


@router.get("/browse")
def browse_content(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: Annotated[str, Query(min_length=1)],
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
    page_type: Annotated[BrowseSectionType | None, Query()] = None,
    cursor: Annotated[str | None, Query()] = None,
) -> dict:
    """Browse globally discoverable acquisition results."""
    return success_response(
        browse_service.browse_content(
            db,
            viewer.user_id,
            q,
            limit=limit,
            page_type=page_type,
            cursor=cursor,
        )
    )
