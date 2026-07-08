"""SSE replay/tail routes for durable runs and media processing status.

All four browser-callable streams live under ``/stream/`` (auth via stream-token
bearer; see ``stream_paths.is_stream_path``). Three are append-cursor durable-run
streams (chat run, oracle reading, library-intelligence revision) that share one
generic factory; the fourth is the media processing-status snapshot/diff stream.

Push-driven: an AFTER trigger ``pg_notify``s the per-entity channel on each new
event/state change; the tail uses the shared stream LISTEN resource and re-reads
on each notification. The synchronous DB reads run in a threadpool so they never
block the event loop. The framing and tail envelope live in ``_sse``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import get_stream_viewer
from nexus.api.routes._sse import open_sse_listener, tail_cursor_stream, tail_snapshot_stream
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services import chat_runs as chat_runs_service
from nexus.services import media as media_service
from nexus.services import oracle as oracle_service
from nexus.services import run_kit
from nexus.services.artifacts import revisions as artifact_revisions_service
from nexus.services.redact import safe_kv

router = APIRouter(tags=["streaming"])
logger = get_logger(__name__)

_SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


@dataclass(frozen=True)
class CursorStreamKind:
    """Binds a durable-run kind to its ownership assert and after-cursor read.

    ``assert_viewer`` and ``read_after`` both run inside an open session opened by
    the shared wrapper; they receive ``viewer_id`` even when the underlying read is
    viewer-less (oracle/LI gate ownership in ``assert_viewer``, so the read ignores
    the param — a redundant viewer arg on those service reads would be dead checks).
    """

    run_kind: run_kit.RunStreamKind
    assert_viewer: Callable[[Session, UUID, UUID], None]
    read_after: Callable[[Session, UUID, UUID, int], tuple[Sequence[Any], bool]]


_CHAT_RUN_KIND = CursorStreamKind(
    run_kind=run_kit.RunStreamKind.ChatRun,
    assert_viewer=lambda db, viewer_id, run_id: chat_runs_service.assert_chat_run_owner(
        db, viewer_id=viewer_id, run_id=run_id
    ),
    read_after=lambda db, viewer_id, run_id, after: run_kit.get_run_events(
        db, run_kit.RunStreamKind.ChatRun, run_id, after
    ),
)

_ORACLE_READING_KIND = CursorStreamKind(
    run_kind=run_kit.RunStreamKind.OracleReading,
    assert_viewer=lambda db, viewer_id, reading_id: oracle_service.assert_reading_owner(
        db, viewer_id=viewer_id, reading_id=reading_id
    ),
    read_after=lambda db, viewer_id, reading_id, after: run_kit.get_run_events(
        db, run_kit.RunStreamKind.OracleReading, reading_id, after
    ),
)

_ARTIFACT_REVISION_KIND = CursorStreamKind(
    run_kind=run_kit.RunStreamKind.ArtifactRevision,
    assert_viewer=lambda db, viewer_id, revision_id: (
        artifact_revisions_service.assert_revision_viewer(
            db, viewer_id=viewer_id, revision_id=revision_id
        )
    ),
    read_after=lambda db, viewer_id, revision_id, after: run_kit.get_run_events(
        db, run_kit.RunStreamKind.ArtifactRevision, revision_id, after
    ),
)


async def make_cursor_stream_response(
    kind: CursorStreamKind, *, request: Request, entity_id: UUID, viewer_id: UUID, after: int
) -> StreamingResponse:
    """Threadpool ownership assert + open listener + append-cursor tail, one envelope."""

    def assert_viewer() -> None:
        with get_session_factory()() as db:
            kind.assert_viewer(db, viewer_id, entity_id)

    def read_after(after: int) -> tuple[Sequence[Any], bool]:
        with get_session_factory()() as db:
            return kind.read_after(db, viewer_id, entity_id, after)

    await run_in_threadpool(assert_viewer)
    listener = await open_sse_listener(run_kit.notify_channel(kind.run_kind), str(entity_id))
    return StreamingResponse(
        tail_cursor_stream(request=request, listener=listener, after=after, read_after=read_after),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
    )


@router.get("/stream/chat-runs/{run_id}/events")
async def stream_chat_run_events(
    request: Request,
    run_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    sse_attempt: str | None = Header(default=None, alias="X-Nexus-SSE-Attempt"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    attempt = _parse_sse_attempt(sse_attempt)
    logger.info(
        "chat_run.sse.connected",
        **safe_kv(
            chat_run_id=str(run_id),
            viewer_id=str(viewer_id),
            sse_attempt=attempt,
            is_reconnect=attempt > 0 or cursor > 0,
            cursor=cursor,
            cursor_source="after" if after is not None else "last_event_id" if cursor else "none",
        ),
    )
    return await make_cursor_stream_response(
        _CHAT_RUN_KIND, request=request, entity_id=run_id, viewer_id=viewer_id, after=cursor
    )


@router.get("/stream/oracle-readings/{reading_id}/events")
async def stream_oracle_reading_events(
    request: Request,
    reading_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    return await make_cursor_stream_response(
        _ORACLE_READING_KIND,
        request=request,
        entity_id=reading_id,
        viewer_id=viewer_id,
        after=cursor,
    )


@router.get("/stream/artifact-revisions/{revision_id}/events")
async def stream_artifact_revision_events(
    request: Request,
    revision_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    return await make_cursor_stream_response(
        _ARTIFACT_REVISION_KIND,
        request=request,
        entity_id=revision_id,
        viewer_id=viewer_id,
        after=cursor,
    )


@router.get("/stream/media/{media_id}/events")
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
        headers=_SSE_HEADERS,
    )


def _assert_media_readable(viewer_id: UUID, media_id: UUID) -> None:
    with get_session_factory()() as db:
        media_service.get_media_for_viewer(db, viewer_id, media_id)


def _read_media_snapshot(viewer_id: UUID, media_id: UUID) -> tuple[dict, bool]:
    with get_session_factory()() as db:
        snapshot = media_service.read_event_snapshot(db, viewer_id=viewer_id, media_id=media_id)
    return snapshot.payload, snapshot.terminal


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


def _parse_sse_attempt(value: str | None) -> int:
    if value is None or not value.strip():
        return 0
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "X-Nexus-SSE-Attempt must be an integer"
        ) from exc
    if parsed < 0:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "X-Nexus-SSE-Attempt must be non-negative")
    return parsed
