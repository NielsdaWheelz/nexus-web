"""Viewer Activity and exact media repair routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.responses import ok
from nexus.schemas.media_activity import MediaRepairOut, MediaRepairRequest
from nexus.services.ingest_recovery import repair_media_work
from nexus.services.media_activity import read_media_activity

router = APIRouter(tags=["media"])


@router.get("/media/activity")
def get_media_activity(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    limit: int = Query(default=20, ge=1, le=20),
) -> dict:
    return ok(
        read_media_activity(
            db,
            viewer_id=viewer.user_id,
            limit=limit,
            is_admin="admin" in viewer.roles,
        )
    )


@router.post("/media/{media_id}/repair", status_code=202)
def repair_media(
    media_id: UUID,
    request: MediaRepairRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    job_id = repair_media_work(
        db,
        media_id=media_id,
        scope=request.scope,
        viewer_id=viewer.user_id,
        is_admin="admin" in viewer.roles,
    )
    return ok(MediaRepairOut(media_id=media_id, scope=request.scope, job_id=job_id))
