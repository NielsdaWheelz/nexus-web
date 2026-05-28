"""SSE stream for media processing-status updates.

Mirrors the chat-run SSE pattern (`nexus.api.routes.stream`): browser-facing
StreamingResponse authenticated via a short-lived `stream_token` Bearer.
Emits a `state` snapshot on open and on every change, a `done` event on
terminal status, and keepalive comments while idle.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from nexus.api.routes.stream import get_stream_viewer
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.media import MediaOut
from nexus.services import media as media_service

router = APIRouter(tags=["streaming"])

STREAM_IDLE_TTL_SECONDS = 45.0
KEEPALIVE_INTERVAL_SECONDS = STREAM_IDLE_TTL_SECONDS / 3.0
# justify-polling: media processing_status is mutated by a separate worker
# process; the API process has no push channel to the worker, so the SSE
# loop polls the media row. 1.0s matches the cadence the previous browser
# poll used, and the loop self-terminates on `done` (processing_status in
# {ready, failed}) or client disconnect.
POLL_INTERVAL_SECONDS = 1.0

_TERMINAL_STATUSES = frozenset({"ready", "failed"})


@router.get("/media/{media_id}/events")
async def stream_media_events(
    request: Request,
    media_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    db_factory = get_session_factory()
    with db_factory() as db:
        # Surfaces NotFoundError (E_MEDIA_NOT_FOUND, 404) if the viewer
        # cannot read the media — masks existence, matching GET /media/{id}.
        media_service.get_media_for_viewer(db, viewer_id, media_id)

    return StreamingResponse(
        _tail_media_events(request=request, media_id=media_id, viewer_id=viewer_id),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


async def _tail_media_events(
    *,
    request: Request,
    media_id: UUID,
    viewer_id: UUID,
) -> AsyncIterator[str]:
    db_factory = get_session_factory()
    last_payload: dict[str, Any] | None = None
    last_keepalive = time.monotonic()

    while True:
        if await request.is_disconnected():
            return

        with db_factory() as db:
            try:
                media = media_service.get_media_for_viewer(db, viewer_id, media_id)
            except ApiError as exc:
                if exc.code == ApiErrorCode.E_MEDIA_NOT_FOUND:
                    return
                raise

        payload = _build_state_payload(media)

        if payload != last_payload:
            yield _format_sse_event("state", payload)
            last_payload = payload
            last_keepalive = time.monotonic()

        if payload["processing_status"] in _TERMINAL_STATUSES:
            yield _format_sse_event("done", payload)
            return

        now = time.monotonic()
        if now - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
            yield ": keepalive\n\n"
            last_keepalive = now

        await asyncio.sleep(POLL_INTERVAL_SECONDS)


def _build_state_payload(media: MediaOut) -> dict[str, Any]:
    return {
        "processing_status": media.processing_status,
        "last_error_code": media.last_error_code,
        "failure_stage": media.failure_stage,
        "capabilities": media.capabilities.model_dump(mode="json"),
        "transcript_state": media.transcript_state,
        "transcript_coverage": media.transcript_coverage,
        "updated_at": media.updated_at.isoformat(),
    }


def _format_sse_event(event_type: str, payload: dict[str, Any]) -> str:
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {event_type}\ndata: {data}\n\n"
