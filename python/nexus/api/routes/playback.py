"""Player routes: the fresh descriptor, listening writes and the preview hand-off. Transport
only; the consumption service owns fences. This router owns static ``/media/{id}/<literal>``
paths, so it registers before the ``media`` router.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.api.deps import DeviceId
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas import playback_sessions as queue_wire
from nexus.schemas.consumption import (
    EpisodeConsumptionObservation,
    ListeningIn,
    PlayerActivationOut,
    PreviewPositionIn,
)
from nexus.schemas.episode_download import EpisodeDownloadOut
from nexus.schemas.reader_document import ReaderTranscriptDocumentOut
from nexus.services import episode_download, playback_sessions, playback_snapshot
from nexus.services.consumption import state

router = APIRouter(tags=["media"])


@router.get("/media/{media_id}/episode-download")
def get_episode_download(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    response: Response,
) -> Data[EpisodeDownloadOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return Data(data=episode_download.capture(db, viewer.user_id, media_id))


@router.get(
    "/media/{media_id}/episode-download/transcript",
    response_model=Data[ReaderTranscriptDocumentOut],
)
def get_episode_download_transcript(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    source_key: Annotated[str, Query(pattern=r"^[a-f0-9]{64}$")],
    sha256: Annotated[str, Query(pattern=r"^[a-f0-9]{64}$")],
) -> Response:
    return Response(
        content=episode_download.transcript(db, viewer.user_id, media_id, source_key, sha256),
        media_type="application/json",
        headers={"Cache-Control": "private, no-store"},
    )


@router.get("/media/{media_id}/player")
def get_player(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    response: Response,
) -> Data[PlayerActivationOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return Data(data=state.get_player(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/listening-state")
def put_listening_state(
    media_id: UUID, body: ListeningIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[EpisodeConsumptionObservation]:
    return Data(data=state.record_listening(viewer.user_id, media_id, body))


@router.post("/media/{media_id}/preview-position", status_code=204)
def install_preview_position(
    media_id: UUID, body: PreviewPositionIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Response:
    state.install_preview_position(viewer.user_id, media_id, body)
    return Response(status_code=204)


@router.post("/playback/snapshot")
def capture_playback_snapshot(
    body: queue_wire.PlaybackSnapshotRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[queue_wire.PlaybackSnapshotOut]:
    return Data(data=playback_snapshot.capture(db, viewer.user_id, body))


@router.get("/me/playback-session")
def get_playback_session(
    device_id: DeviceId,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    response: Response,
) -> Data[queue_wire.BrowserSessionOut | None]:
    response.headers["Cache-Control"] = "no-store"
    return Data(data=playback_sessions.get_session(db, viewer.user_id, device_id))


@router.put("/me/playback-session")
def put_playback_session(
    body: queue_wire.PutPlaybackSessionRequest,
    device_id: DeviceId,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    response: Response,
) -> Data[queue_wire.BrowserSessionOut]:
    response.headers["Cache-Control"] = "no-store"
    return Data(data=playback_sessions.put_session(viewer.user_id, device_id, body))
