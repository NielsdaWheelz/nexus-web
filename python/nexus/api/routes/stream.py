"""SSE replay/tail routes for durable chat runs and oracle readings.

Push-driven: an AFTER trigger (migration 0122) ``pg_notify``s the per-run /
per-reading channel on each new event; the tail ``LISTEN``s via
``wait_for_notifications`` and re-reads on each notification. The synchronous
DB reads run in a threadpool so they never block the event loop.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from nexus.auth.stream_token import verify_stream_token
from nexus.db.listen import wait_for_notifications
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import set_stream_jti
from nexus.schemas.conversation import ChatRunEventOut
from nexus.schemas.oracle import OracleReadingEventOut
from nexus.services import chat_runs as chat_runs_service
from nexus.services import oracle as oracle_service

router = APIRouter(tags=["streaming"])

STREAM_IDLE_TTL_SECONDS = 45.0
KEEPALIVE_INTERVAL_SECONDS = STREAM_IDLE_TTL_SECONDS / 3.0


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
    request: Request,
    run_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    await run_in_threadpool(_assert_chat_run_owner, viewer_id, run_id)
    return StreamingResponse(
        _tail_chat_run_events(request=request, run_id=run_id, viewer_id=viewer_id, after=cursor),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _assert_chat_run_owner(viewer_id: UUID, run_id: UUID) -> None:
    with get_session_factory()() as db:
        chat_runs_service.assert_chat_run_owner(db, viewer_id=viewer_id, run_id=run_id)


def _read_chat_run_events(
    viewer_id: UUID, run_id: UUID, after: int
) -> tuple[list[ChatRunEventOut], bool]:
    with get_session_factory()() as db:
        events = chat_runs_service.get_chat_run_events(
            db, viewer_id=viewer_id, run_id=run_id, after=after
        )
        terminal = chat_runs_service.is_chat_run_terminal(db, viewer_id=viewer_id, run_id=run_id)
    return events, terminal


async def _tail_chat_run_events(
    *,
    request: Request,
    run_id: UUID,
    viewer_id: UUID,
    after: int,
) -> AsyncIterator[str]:
    cursor = after
    last_keepalive = time.monotonic()

    async for _ in wait_for_notifications(
        "chat_run_events", str(run_id), KEEPALIVE_INTERVAL_SECONDS
    ):
        if await request.is_disconnected():
            return

        try:
            events, terminal = await run_in_threadpool(
                _read_chat_run_events, viewer_id, run_id, cursor
            )
        except ApiError as exc:
            if exc.code == ApiErrorCode.E_NOT_FOUND:
                return
            raise

        for event in events:
            cursor = event.seq
            yield _format_sse_event(event.seq, event.event_type, event.payload)
            if event.event_type == "done":
                return

        if terminal:
            return

        now = time.monotonic()
        if now - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
            yield ": keepalive\n\n"
            last_keepalive = now


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


@router.get("/stream/oracle-readings/{reading_id}/events")
async def stream_oracle_reading_events(
    request: Request,
    reading_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    await run_in_threadpool(_assert_reading_owner, viewer_id, reading_id)
    return StreamingResponse(
        _tail_oracle_reading_events(request=request, reading_id=reading_id, after=cursor),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


def _assert_reading_owner(viewer_id: UUID, reading_id: UUID) -> None:
    with get_session_factory()() as db:
        oracle_service.assert_reading_owner(db, viewer_id=viewer_id, reading_id=reading_id)


def _read_reading_events(reading_id: UUID, after: int) -> tuple[list[OracleReadingEventOut], bool]:
    with get_session_factory()() as db:
        events = oracle_service.get_reading_events(db, reading_id=reading_id, after=after)
        terminal = oracle_service.is_reading_terminal(db, reading_id=reading_id)
    return events, terminal


async def _tail_oracle_reading_events(
    *,
    request: Request,
    reading_id: UUID,
    after: int,
) -> AsyncIterator[str]:
    cursor = after
    last_keepalive = time.monotonic()

    async for _ in wait_for_notifications(
        "oracle_reading_events", str(reading_id), KEEPALIVE_INTERVAL_SECONDS
    ):
        if await request.is_disconnected():
            return

        events, terminal = await run_in_threadpool(_read_reading_events, reading_id, cursor)

        for event in events:
            cursor = event.seq
            yield _format_sse_event(event.seq, event.event_type, event.payload)
            if event.event_type == "done":
                return

        if terminal:
            return

        now = time.monotonic()
        if now - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
            yield ": keepalive\n\n"
            last_keepalive = now
