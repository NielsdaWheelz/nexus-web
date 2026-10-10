"""Player routes: the fresh descriptor, listening writes, the preview hand-off and activity
capture. Transport only; the consumption service owns sessions and fences. This router owns
static ``/media/{id}/<literal>`` paths, so it registers before the ``media`` router. The BFF
injects ``deviceId`` into the capture body from the device cookie.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.errors import InvalidRequestError
from nexus.responses import Data
from nexus.schemas.consumption import (
    ActivityRecordIn,
    ListeningIn,
    ListeningPositionOut,
    PlayerDescriptor,
    PreviewPositionIn,
)
from nexus.services.consumption import activity
from nexus.services.consumption import service as consumption_service
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["media"])


@router.get("/media/{media_id}/player")
def get_player(
    media_id: UUID, viewer: Annotated[Viewer, Depends(get_viewer)], db: RepeatableReadDbSession
) -> Data[PlayerDescriptor]:
    return Data(data=consumption_service.get_player(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/listening-state")
def put_listening_state(
    media_id: UUID, body: ListeningIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[ListeningPositionOut]:
    return Data(data=consumption_service.record_listening(viewer.user_id, media_id, body))


@router.post("/media/{media_id}/preview-position", status_code=204)
def install_preview_position(
    media_id: UUID, body: PreviewPositionIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Response:
    consumption_service.install_preview_position(viewer.user_id, media_id, body)
    return Response(status_code=204)


@router.post("/consumption/activity", status_code=204, tags=["consumption"])
def post_activity(
    body: ActivityRecordIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Response:
    ref = parse_resource_ref(body.media_ref)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme != "media":
        raise InvalidRequestError(message="Invalid mediaRef")
    activity.record_batch(
        viewer.user_id,
        media_id=ref.id,
        device_id=body.device_id,
        device_class=body.device_class,
        batch=body.batch,
    )
    return Response(status_code=204)
