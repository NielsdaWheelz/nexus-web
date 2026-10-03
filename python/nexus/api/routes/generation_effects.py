"""Account-owned generation effect history and undo."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.services.generation_effects import (
    GenerationEffectRefusal,
    list_generation_effects,
    undo_generation_position,
)

router = APIRouter(tags=["generation-effects"])


def _user_error(error: GenerationEffectRefusal) -> JSONResponse:
    return JSONResponse(
        status_code=error.status,
        content={"error": {"code": error.code, "message": error.code.replace("_", " ")}},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/generation-effects/{position_id}/undo")
def undo_background_generation_write(
    position_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    try:
        changed = undo_generation_position(db, viewer_id=viewer.user_id, position_id=position_id)
    except GenerationEffectRefusal as error:
        return _user_error(error)
    return JSONResponse(
        {"position_id": str(position_id), "reverted": True, "changed": changed},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/generation-effects")
def recent_generation_effects(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    generation_id: Annotated[UUID | None, Query()] = None,
    before: Annotated[UUID | None, Query()] = None,
) -> JSONResponse:
    try:
        page = list_generation_effects(
            db, viewer_id=viewer.user_id, generation_id=generation_id, before=before
        )
    except GenerationEffectRefusal as error:
        return _user_error(error)
    return JSONResponse(page, headers={"Cache-Control": "no-store"})
