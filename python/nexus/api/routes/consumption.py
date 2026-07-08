"""Consumption-override routes: explicit mark-finished / mark-unread verb.

Transport-only: validate input, call the attention service, return 204. Owns a
static `/media/{id}/consumption-override` path, so this router is registered
before the `media` router (see create_api_router).
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.schemas.attention import ConsumptionOverrideRequest
from nexus.services import attention

router = APIRouter(tags=["media"])


@router.post("/media/{media_id}/consumption-override", status_code=204)
def post_consumption_override(
    media_id: UUID,
    body: ConsumptionOverrideRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Upsert the explicit read-state override for the authenticated viewer."""
    attention.set_consumption_override(db, viewer.user_id, media_id, body.status)
    return Response(status_code=204)


@router.delete("/media/{media_id}/consumption-override", status_code=204)
def delete_consumption_override(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Remove the override (revert to derived read-state); idempotent."""
    attention.delete_consumption_override(db, viewer.user_id, media_id)
    return Response(status_code=204)
