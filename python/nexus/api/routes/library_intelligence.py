"""Library intelligence routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.services import library_intelligence as library_intelligence_service

router = APIRouter()


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
    return success_response(result.model_dump(mode="json"))


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
    return JSONResponse(status_code=202, content=success_response(result.model_dump(mode="json")))
