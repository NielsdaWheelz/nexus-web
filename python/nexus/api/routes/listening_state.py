"""Listening-state routes: per-media playback position GET + heartbeat PUT.

Transport-only: the consumption service facade owns the fresh session, the
viewer lock, and the revision CAS. This router owns the static
``/media/{id}/listening-state`` path, so it stays registered before the
``media`` router (see ``create_api_router``).
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.consumption import ListeningHeartbeatIn
from nexus.services.consumption import service as consumption_service

router = APIRouter(tags=["media"])


@router.get("/media/{media_id}/listening-state")
def get_listening_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get per-media listening state for the authenticated viewer."""
    result = consumption_service.get_listening_state(db, viewer.user_id, media_id)
    return ok(result, by_alias=True)


@router.put("/media/{media_id}/listening-state")
def put_listening_state(
    media_id: UUID,
    body: ListeningHeartbeatIn,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Record one revision-fenced listening heartbeat (position)."""
    result = consumption_service.record_listening_heartbeat(viewer.user_id, media_id, body)
    return ok(result, by_alias=True)
