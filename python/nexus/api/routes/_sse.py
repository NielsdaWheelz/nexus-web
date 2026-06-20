"""SSE transport: the one frame formatter, keepalive cadence, and tail loops.

There are two genuinely different stream semantics — append-cursor and
snapshot/diff — but they share an identical and dangerous envelope (disconnect
check, gone-close, keepalive, ``finally`` close). The envelope and the frame
formatter are owned here once; the divergent read/emit policy stays as two
small tailers. A single flag-driven coroutine would be the hollow generic the
cleanliness rules forbid, and the mismatched formatter it replaced was a live
``Last-Event-ID`` foot-gun.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from nexus.db.listen import StreamNotificationListener, open_stream_listener
from nexus.errors import ApiError, ApiErrorCode

STREAM_IDLE_TTL_SECONDS = 45.0
KEEPALIVE_INTERVAL_SECONDS = STREAM_IDLE_TTL_SECONDS / 3.0

# Error codes meaning "the streamed resource is gone" → clean terminal close,
# not a 500. Owned here so chat-run and media share one policy. (Oracle signals
# gone by returning terminal=True instead — see run_kit.is_run_terminal.)
STREAM_GONE_CODES = frozenset({ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_MEDIA_NOT_FOUND})


def format_sse_event(*, event_type: str, payload: dict[str, Any], seq: int | None = None) -> str:
    """The one SSE frame formatter. Emits the ``id:`` resume line iff seq is set."""
    data = json.dumps(payload, separators=(",", ":"))
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}event: {event_type}\ndata: {data}\n\n"


async def open_sse_listener(channel: str, key: str) -> StreamNotificationListener:
    """Open the shared LISTEN resource at the SSE keepalive cadence."""
    return await open_stream_listener(channel, key, KEEPALIVE_INTERVAL_SECONDS)


async def tail_cursor_stream(
    *,
    request: Request,
    listener: StreamNotificationListener,
    after: int,
    read_after: Callable[[int], tuple[Sequence[Any], bool]],
) -> AsyncIterator[str]:
    """Append-cursor SSE. ``read_after(cursor)`` returns (events, terminal); each
    event exposes ``.seq`` / ``.event_type`` / ``.payload``. Emits every new event
    with its ``id:``, advances the cursor, and closes on a ``done`` event or a
    terminal read. A read that raises a gone code OR returns terminal closes cleanly.
    """
    cursor = after
    last_keepalive = time.monotonic()
    close_reason = "closed"
    try:
        async for _ in listener.notifications():
            if await request.is_disconnected():
                close_reason = "client_disconnected"
                return
            try:
                events, terminal = await run_in_threadpool(read_after, cursor)
            except ApiError as exc:
                if exc.code in STREAM_GONE_CODES:
                    close_reason = "gone"
                    return
                raise
            for event in events:
                cursor = event.seq
                yield format_sse_event(
                    event_type=event.event_type, payload=event.payload, seq=event.seq
                )
                if event.event_type == "done":
                    close_reason = "terminal"
                    return
            if terminal:
                close_reason = "terminal"
                return
            now = time.monotonic()
            if now - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
                yield ": keepalive\n\n"
                last_keepalive = now
    except BaseException:
        close_reason = "error"
        raise
    finally:
        await listener.close(reason=close_reason)


async def tail_snapshot_stream(
    *,
    request: Request,
    listener: StreamNotificationListener,
    read_snapshot: Callable[[], tuple[dict[str, Any], bool]],
) -> AsyncIterator[str]:
    """Snapshot/diff SSE. ``read_snapshot()`` returns (payload, terminal). Emits a
    ``state`` frame only when the payload changes (no ``id:``), then a ``done`` frame
    and closes when the read reports terminal. Same gone/keepalive/finally envelope.
    """
    last_payload: dict[str, Any] | None = None
    last_keepalive = time.monotonic()
    close_reason = "closed"
    try:
        async for _ in listener.notifications():
            if await request.is_disconnected():
                close_reason = "client_disconnected"
                return
            try:
                payload, terminal = await run_in_threadpool(read_snapshot)
            except ApiError as exc:
                if exc.code in STREAM_GONE_CODES:
                    close_reason = "gone"
                    return
                raise
            if payload != last_payload:
                yield format_sse_event(event_type="state", payload=payload)
                last_payload = payload
                last_keepalive = time.monotonic()
            if terminal:
                yield format_sse_event(event_type="done", payload=payload)
                close_reason = "terminal"
                return
            now = time.monotonic()
            if now - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
                yield ": keepalive\n\n"
                last_keepalive = now
    except BaseException:
        close_reason = "error"
        raise
    finally:
        await listener.close(reason=close_reason)
