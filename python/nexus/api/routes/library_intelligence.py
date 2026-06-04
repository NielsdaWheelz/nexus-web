"""Library intelligence routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.services import library_intelligence as library_intelligence_service

router = APIRouter(tags=["library-intelligence"])


@router.get("/libraries/{library_id}/intelligence")
def get_library_intelligence(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = library_intelligence_service.get_library_intelligence(
        db,
        viewer.user_id,
        library_id,
    )
    return ok(result)


@router.post("/libraries/{library_id}/intelligence/refresh", status_code=202)
def refresh_library_intelligence(
    library_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    result = library_intelligence_service.refresh_library_intelligence(
        db,
        viewer.user_id,
        library_id,
    )
    return JSONResponse(status_code=202, content=ok(result))
