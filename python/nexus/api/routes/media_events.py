"""SSE stream for media processing-status updates.

Browser-facing StreamingResponse authenticated via a short-lived stream-token
Bearer. Emits a `state` snapshot on open and on every change, a `done` event on
terminal status, and keepalives while idle. The framing, terminal decision, and
tail envelope live in ``_sse`` and ``services.media.read_event_snapshot``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import get_stream_viewer
from nexus.api.routes._sse import open_sse_listener, tail_snapshot_stream
from nexus.db.session import get_session_factory
from nexus.services import media as media_service

router = APIRouter(tags=["streaming"])


@router.get("/media/{media_id}/events")
async def stream_media_events(
    request: Request,
    media_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    # Surfaces NotFoundError (E_MEDIA_NOT_FOUND, 404) if the viewer cannot
    # read the media — masks existence, matching GET /media/{id}.
    await run_in_threadpool(_assert_media_readable, viewer_id, media_id)
    listener = await open_sse_listener("media_events", str(media_id))
    return StreamingResponse(
        tail_snapshot_stream(
            request=request,
            listener=listener,
            read_snapshot=lambda: _read_media_snapshot(viewer_id, media_id),
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


def _assert_media_readable(viewer_id: UUID, media_id: UUID) -> None:
    with get_session_factory()() as db:
        media_service.get_media_for_viewer(db, viewer_id, media_id)


def _read_media_snapshot(viewer_id: UUID, media_id: UUID) -> tuple[dict, bool]:
    with get_session_factory()() as db:
        snapshot = media_service.read_event_snapshot(db, viewer_id=viewer_id, media_id=media_id)
    return snapshot.payload, snapshot.terminal
