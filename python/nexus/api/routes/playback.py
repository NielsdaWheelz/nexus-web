"""Player routes: the fresh descriptor, listening writes and the preview hand-off. Transport
only; the consumption service owns fences. This router owns static ``/media/{id}/<literal>``
paths, so it registers before the ``media`` router.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.consumption import (
    ListeningIn,
    ListeningPositionOut,
    PlayerDescriptor,
    PreviewPositionIn,
)
from nexus.services.consumption import state

router = APIRouter(tags=["media"])


@router.get("/media/{media_id}/player")
def get_player(
    media_id: UUID, viewer: Annotated[Viewer, Depends(get_viewer)], db: RepeatableReadDbSession
) -> Data[PlayerDescriptor]:
    return Data(data=state.get_player(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/listening-state")
def put_listening_state(
    media_id: UUID, body: ListeningIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[ListeningPositionOut]:
    return Data(data=state.record_listening(viewer.user_id, media_id, body))


@router.post("/media/{media_id}/preview-position", status_code=204)
def install_preview_position(
    media_id: UUID, body: PreviewPositionIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Response:
    state.install_preview_position(viewer.user_id, media_id, body)
    return Response(status_code=204)
