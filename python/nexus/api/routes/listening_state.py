"""Listening-state routes: per-media playback position get/put and batch mark.

Transport-only: validate input, call the listening_state service, return the
envelope. The batch path owns a static `/media/listening-state/...` prefix, so
this router must be registered before the `media` router (see create_api_router).
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.attention import AttentionBlock
from nexus.schemas.media import ListeningStateBatchUpsertRequest, ListeningStateUpsertRequest
from nexus.services import attention, listening_state

router = APIRouter(tags=["media"])


@router.post("/media/listening-state/batch", status_code=204)
def post_listening_state_batch(
    body: ListeningStateBatchUpsertRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Batch mark many visible podcast episodes played/unplayed."""
    listening_state.batch_mark_listening_state_for_viewer(
        db,
        viewer.user_id,
        media_ids=body.media_ids,
        is_completed=body.is_completed,
    )
    return Response(status_code=204)


@router.get("/media/{media_id}/listening-state")
def get_listening_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get per-media listening state for the authenticated viewer."""
    result = listening_state.get_listening_state_for_viewer(db, viewer.user_id, media_id)
    return ok(result)


@router.put("/media/{media_id}/listening-state", status_code=204)
def put_listening_state(
    media_id: UUID,
    body: ListeningStateUpsertRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Upsert per-media listening state for the authenticated viewer."""
    listening_state.upsert_listening_state_for_viewer(
        db,
        viewer.user_id,
        media_id,
        position_ms=body.position_ms,
        duration_ms=body.duration_ms,
        playback_speed=body.playback_speed,
        is_completed=body.is_completed,
    )
    if body.dwell_ms_delta is not None and body.device_id is not None:
        attention.record_attention(
            db,
            viewer.user_id,
            media_id,
            AttentionBlock(
                dwell_ms_delta=body.dwell_ms_delta,
                device_id=body.device_id,
                spans_touched=[],
                progression=_audio_progression(body),
            ),
        )
    return Response(status_code=204)


def _audio_progression(body: ListeningStateUpsertRequest) -> float | None:
    """Playback fraction for the session's max_progression: completion wins, else
    position/duration when both are known, else None."""
    if body.is_completed:
        return 1.0
    if body.position_ms is not None and body.duration_ms and body.duration_ms > 0:
        return min(1.0, body.position_ms / body.duration_ms)
    return None
