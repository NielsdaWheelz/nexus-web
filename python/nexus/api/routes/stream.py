"""SSE replay/tail routes for durable chat runs and oracle readings.

Push-driven: an AFTER trigger ``pg_notify``s the per-run / per-reading channel
on each new event; the tail uses the shared stream LISTEN resource and re-reads
on each notification. The synchronous DB reads run in a threadpool so they
never block the event loop. The framing and tail envelope live in ``_sse``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import get_stream_viewer
from nexus.api.routes._sse import open_sse_listener, tail_cursor_stream
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.conversation import ChatRunEventOut
from nexus.schemas.library_intelligence import LibraryIntelligenceRevisionEventOut
from nexus.schemas.oracle import OracleReadingEventOut
from nexus.services import chat_runs as chat_runs_service
from nexus.services import library_intelligence as library_intelligence_service
from nexus.services import oracle as oracle_service
from nexus.services import run_kit

router = APIRouter(tags=["streaming"])


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
    listener = await open_sse_listener(
        run_kit.notify_channel(run_kit.RunStreamKind.ChatRun), str(run_id)
    )
    return StreamingResponse(
        tail_cursor_stream(
            request=request,
            listener=listener,
            after=cursor,
            read_after=lambda c: _read_chat_run_events(viewer_id, run_id, c),
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
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
    listener = await open_sse_listener(
        run_kit.notify_channel(run_kit.RunStreamKind.OracleReading), str(reading_id)
    )
    return StreamingResponse(
        tail_cursor_stream(
            request=request,
            listener=listener,
            after=cursor,
            read_after=lambda c: _read_reading_events(reading_id, c),
        ),
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


@router.get("/stream/library-intelligence/{revision_id}/events")
async def stream_library_intelligence_events(
    request: Request,
    revision_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    await run_in_threadpool(_assert_revision_viewer, viewer_id, revision_id)
    listener = await open_sse_listener(
        run_kit.notify_channel(run_kit.RunStreamKind.LibraryIntelligence), str(revision_id)
    )
    return StreamingResponse(
        tail_cursor_stream(
            request=request,
            listener=listener,
            after=cursor,
            read_after=lambda c: _read_revision_events(revision_id, c),
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


def _assert_revision_viewer(viewer_id: UUID, revision_id: UUID) -> None:
    with get_session_factory()() as db:
        library_intelligence_service.assert_revision_viewer(
            db, viewer_id=viewer_id, revision_id=revision_id
        )


def _read_revision_events(
    revision_id: UUID, after: int
) -> tuple[list[LibraryIntelligenceRevisionEventOut], bool]:
    with get_session_factory()() as db:
        events = library_intelligence_service.get_revision_events(
            db, revision_id=revision_id, after=after
        )
        terminal = library_intelligence_service.is_revision_terminal(db, revision_id=revision_id)
    return events, terminal


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
