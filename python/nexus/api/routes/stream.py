"""SSE replay/tail routes for durable chat runs."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse

from nexus.api.deps import get_session_factory
from nexus.auth.stream_token import verify_stream_token
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import set_stream_jti
from nexus.services import chat_runs as chat_runs_service

router = APIRouter(prefix="/stream", tags=["streaming"])

KEEPALIVE_INTERVAL_SECONDS = 15.0
POLL_INTERVAL_SECONDS = 0.5


def get_stream_viewer(request: Request) -> UUID:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Missing or invalid Authorization header",
        )

    token = auth_header[7:].strip()
    if not token:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Empty bearer token")

    user_id, jti = verify_stream_token(token)
    if jti:
        set_stream_jti(jti)
    return user_id


@router.get("/chat-runs/{run_id}/events")
async def stream_chat_run_events(
    run_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    db_factory = get_session_factory()
    with db_factory() as db:
        chat_runs_service.assert_chat_run_owner(db, viewer_id=viewer_id, run_id=run_id)

    return StreamingResponse(
        _tail_chat_run_events(run_id=run_id, viewer_id=viewer_id, after=cursor),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


async def _tail_chat_run_events(run_id: UUID, viewer_id: UUID, after: int) -> AsyncIterator[str]:
    db_factory = get_session_factory()
    cursor = after
    last_keepalive = time.monotonic()

    while True:
        with db_factory() as db:
            events = chat_runs_service.get_chat_run_events(
                db,
                viewer_id=viewer_id,
                run_id=run_id,
                after=cursor,
            )

        for event in events:
            cursor = event.seq
            yield _format_sse_event(event.seq, event.event_type, event.payload)
            if event.event_type == "done":
                return

        now = time.monotonic()
        if now - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
            yield ": keepalive\n\n"
            last_keepalive = now

        await asyncio.sleep(POLL_INTERVAL_SECONDS)


def _parse_last_event_id(value: str | None) -> int:
    if value is None or not value.strip():
        return 0
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Last-Event-ID must be an integer") from exc
    if parsed < 0:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Last-Event-ID must be non-negative")
    return parsed


def _format_sse_event(seq: int, event_type: str, payload: dict) -> str:
    data = json.dumps(payload, separators=(",", ":"))
    return f"id: {seq}\nevent: {event_type}\ndata: {data}\n\n"
