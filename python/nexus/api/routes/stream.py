"""SSE replay/tail routes for durable runs and media processing status.

All five browser-callable streams live under ``/stream/`` (auth via stream-token
bearer; see ``stream_paths.is_stream_path``). Three are append-cursor durable-run
streams (chat run, oracle reading, Dossier build) that share one generic factory;
media processing and Podcast refresh runs use snapshot/diff streams.

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
from nexus.api.routes._sse import (
    open_sse_listener,
    tail_cursor_stream,
    tail_snapshot_stream,
)
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.execution import (
    EXECUTION_ADVISORY_EVENT_TYPE,
    DurableExecutionOut,
)
from nexus.services import chat_runs as chat_runs_service
from nexus.services import media as media_service
from nexus.services import oracle as oracle_service
from nexus.services import run_kit
from nexus.services.artifacts import engine as artifact_engine
from nexus.services.artifacts.handles import unseal_artifact_build
from nexus.services.chat_run_execution import chat_run_execution_phase
from nexus.services.durable_step_journal import DurableExecutionPhase
from nexus.services.podcasts import refresh as podcast_refresh_service
from nexus.services.podcasts.handles import (
    PodcastRefreshRunHandle,
    unseal_podcast_refresh_run,
)
from nexus.services.redact import safe_kv

router = APIRouter(tags=["streaming"])
logger = get_logger(__name__)

_SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


@dataclass(frozen=True)
class CursorStreamKind:
    """Binds a durable-run kind to its ownership assert and after-cursor read.

    ``assert_viewer`` runs before listener setup and again in the same fresh
    session immediately before every replay/tail ``read_after``. This prevents a
    terminal event from crossing the stream after ownership or visibility is
    revoked. Both callbacks receive ``viewer_id`` even when the underlying event
    read is viewer-less.
    """

    run_kind: run_kit.RunStreamKind
    assert_viewer: Callable[[Session, UUID, UUID], None]
    read_after: Callable[[Session, UUID, UUID, int], tuple[Sequence[Any], bool]]
    read_advisory: Callable[[Session, UUID, UUID], DurableExecutionPhase | None] | None = None


_CHAT_RUN_KIND = CursorStreamKind(
    run_kind=run_kit.RunStreamKind.ChatRun,
    assert_viewer=lambda db, viewer_id, run_id: chat_runs_service.assert_chat_run_owner(
        db, viewer_id=viewer_id, run_id=run_id
    ),
    read_after=lambda db, viewer_id, run_id, after: run_kit.get_run_events(
        db, run_kit.RunStreamKind.ChatRun, run_id, after
    ),
    read_advisory=lambda db, viewer_id, run_id: chat_run_execution_phase(db, run_id=run_id),
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

_ARTIFACT_BUILD_KIND = CursorStreamKind(
    run_kind=run_kit.RunStreamKind.ArtifactBuild,
    assert_viewer=lambda db, viewer_id, build_id: artifact_engine.assert_build_viewer(
        db, viewer_id=viewer_id, build_id=build_id
    ),
    read_after=lambda db, viewer_id, build_id, after: run_kit.get_run_events(
        db, run_kit.RunStreamKind.ArtifactBuild, build_id, after
    ),
    read_advisory=lambda db, viewer_id, build_id: artifact_engine.build_execution_phase(
        db, build_id=build_id, viewer_id=viewer_id
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
            kind.assert_viewer(db, viewer_id, entity_id)
            return kind.read_after(db, viewer_id, entity_id, after)

    def read_advisory() -> tuple[str, dict[str, Any]] | None:
        if kind.read_advisory is None:
            return None
        with get_session_factory()() as db:
            kind.assert_viewer(db, viewer_id, entity_id)
            phase = kind.read_advisory(db, viewer_id, entity_id)
            if phase is None:
                return None
            payload = DurableExecutionOut(phase=phase).model_dump(mode="json")
            return EXECUTION_ADVISORY_EVENT_TYPE, payload

    await run_in_threadpool(assert_viewer)
    listener = await open_sse_listener(run_kit.notify_channel(kind.run_kind), str(entity_id))
    return StreamingResponse(
        tail_cursor_stream(
            request=request,
            listener=listener,
            after=after,
            read_after=read_after,
            read_advisory=read_advisory if kind.read_advisory is not None else None,
        ),
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


@router.get("/stream/artifact-builds/{artifact_build_handle}/events")
async def stream_artifact_build_events(
    request: Request,
    artifact_build_handle: str,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    build_id = unseal_artifact_build(artifact_build_handle)
    return await make_cursor_stream_response(
        _ARTIFACT_BUILD_KIND,
        request=request,
        entity_id=build_id,
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


@router.get("/stream/podcast-refresh-runs/{refresh_run_handle}/events")
async def stream_podcast_refresh_run_events(
    request: Request,
    refresh_run_handle: PodcastRefreshRunHandle,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    run_id = unseal_podcast_refresh_run(refresh_run_handle)

    def assert_owner() -> None:
        with get_session_factory()() as db:
            podcast_refresh_service.assert_refresh_run_owner(
                db,
                viewer_id=viewer_id,
                run_id=run_id,
            )

    def read_snapshot() -> tuple[dict[str, Any], bool]:
        with get_session_factory()() as db:
            snapshot = podcast_refresh_service.get_refresh_run_snapshot(
                db,
                viewer_id=viewer_id,
                run_id=run_id,
            )
        return (
            snapshot.model_dump(mode="json", by_alias=True),
            snapshot.status != "Running",
        )

    await run_in_threadpool(assert_owner)
    listener = await open_sse_listener(
        podcast_refresh_service.PODCAST_REFRESH_NOTIFY_CHANNEL,
        str(run_id),
    )
    return StreamingResponse(
        tail_snapshot_stream(
            request=request,
            listener=listener,
            read_snapshot=read_snapshot,
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
