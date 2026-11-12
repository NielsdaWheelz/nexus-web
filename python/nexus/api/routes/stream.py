"""Chat output: committed events after a cursor, plus unsequenced execution advisories.

Each notification or existing idle reconciliation reads a fresh committed snapshot.
The response owns its listener through completion, cancellation and failed sends.
"""

import json
import time
from collections.abc import AsyncIterator, Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.types import Receive, Scope, Send

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.listen import Listener, open_listener
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.chat import EXECUTION_ADVISORY_EVENT_TYPE
from nexus.services.chat import events as chat_events
from nexus.services.chat import reads as chat_reads

router = APIRouter(tags=["streaming"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
KEEPALIVE_SECONDS = 15.0
_GONE = frozenset({ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_MEDIA_NOT_FOUND})
type Advisory = tuple[str, dict[str, Any]]


def _frame(event_type: str, payload: Any, seq: int | None = None) -> str:
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}event: {event_type}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"


class _StreamResponse(StreamingResponse):
    """Own the listener even if headers fail before the frame iterator starts."""

    def __init__(self, frames: AsyncIterator[str], listener: Listener) -> None:
        self._listener = listener
        super().__init__(
            frames,
            media_type="text/event-stream; charset=utf-8",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._listener.close()


@contextmanager
def _snapshot() -> Iterator[Session]:
    """A fresh repeatable-read session of its own, for one read."""
    with get_session_factory()() as db:
        yield get_repeatable_read_db(db)


async def _cursor_frames(
    request: Request,
    listener: Listener,
    after: int,
    read_after: Callable[[int], tuple[Sequence[Any], bool]],
    read_advisory: Callable[[], Advisory | None],
) -> AsyncIterator[str]:
    cursor, advisory, quiet = after, None, time.monotonic()
    async for _ in listener.wakes(KEEPALIVE_SECONDS):
        if await request.is_disconnected():
            return
        try:
            events, terminal = await run_in_threadpool(read_after, cursor)
            latest = None if terminal else await run_in_threadpool(read_advisory)
        except ApiError as exc:
            if exc.code in _GONE:
                return
            raise
        if latest is not None and latest != advisory:
            advisory, quiet = latest, time.monotonic()
            yield _frame(*latest)
        for event in events:
            cursor, quiet = event.seq, time.monotonic()
            yield _frame(event.event_type, event.payload, event.seq)
            if event.event_type == "done":
                return
        if terminal:
            return
        if time.monotonic() - quiet >= KEEPALIVE_SECONDS:
            quiet = time.monotonic()
            yield ": keepalive\n\n"


@router.get("/stream/chat-runs/{run_id}/events")
async def stream_chat_run_events(
    request: Request, run_id: UUID, viewer: ViewerDep, after: Annotated[int, Query(ge=0)] = 0
) -> StreamingResponse:
    """Each committed run event after ``after``, then ``done``; advisories carry no id.

    Every read re-asserts the viewer's ownership in its own session, so no event crosses
    the stream after ownership or visibility is revoked.
    """

    def read_after(cursor: int) -> tuple[Sequence[Any], bool]:
        with _snapshot() as db:
            return chat_reads.read_events(db, viewer_id=viewer.user_id, run_id=run_id, after=cursor)

    def read_advisory() -> Advisory | None:
        with _snapshot() as db:
            chat_reads.require_run(db, viewer_id=viewer.user_id, run_id=run_id)
            advisory = chat_reads.advisory(db, run_id=run_id)
        if advisory is None:
            return None
        return EXECUTION_ADVISORY_EVENT_TYPE, advisory.model_dump(mode="json")

    def require() -> None:
        with _snapshot() as db:
            chat_reads.require_run(db, viewer_id=viewer.user_id, run_id=run_id)

    await run_in_threadpool(require)
    listener = await open_listener(chat_events.CHANNEL, str(run_id))
    try:
        return _StreamResponse(
            _cursor_frames(request, listener, after, read_after, read_advisory), listener
        )
    except BaseException:
        await listener.close()
        raise
