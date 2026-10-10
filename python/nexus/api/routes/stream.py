"""SSE replay/tail routes for durable runs and media processing status.

every browser-callable stream lives under ``/stream/`` (auth via stream-token
bearer; see ``stream_paths.is_stream_path``). Chat runs are append-cursor durable-run
streams; dossier builds, oracle readings, media processing, metadata and podcast
subscription lifecycles use snapshot/diff streams.

Push-driven: an AFTER trigger ``pg_notify``s the per-entity channel on each new
event/state change; the tail uses the shared stream LISTEN resource and re-reads
on each notification. The synchronous DB reads run in a threadpool so they never
block the event loop. The framing and tail envelope live in ``_sse``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.api.deps import (
    get_stream_viewer,
    require_chat_contract_revision,
    require_tool_projection_revision,
)
from nexus.api.routes._sse import (
    open_sse_listener,
    tail_cursor_stream,
    tail_snapshot_stream,
)
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.conversation import EXECUTION_ADVISORY_EVENT_TYPE
from nexus.services import media as media_service
from nexus.services import metadata_operations
from nexus.services.chat import events as chat_events
from nexus.services.chat import reads as chat_reads
from nexus.services.dossier import engine as dossier_engine
from nexus.services.oracle import readings as oracle_readings
from nexus.services.podcasts import subscriptions as podcast_subscription_service

router = APIRouter(tags=["streaming"])
logger = get_logger(__name__)

_SSE_HEADERS = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}


@router.get(
    "/stream/chat-runs/{run_id}/events",
)
async def stream_chat_run_events(
    request: Request,
    run_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    chat_contract_revision: str | None = Header(default=None, alias="X-Nexus-Chat-Contract"),
    tool_projection_revision: str | None = Header(default=None, alias="X-Nexus-Tool-Projection"),
    after: int | None = Query(default=None, ge=0),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    sse_attempt: str | None = Header(default=None, alias="X-Nexus-SSE-Attempt"),
) -> StreamingResponse:
    # The stream bearer dependency resolves before either revision can reject a caller.
    require_chat_contract_revision(chat_contract_revision)
    require_tool_projection_revision(tool_projection_revision)
    cursor = after if after is not None else _parse_last_event_id(last_event_id)
    attempt = _parse_sse_attempt(sse_attempt)
    logger.info(
        "chat_run.sse.connected",
        chat_run_id=str(run_id),
        viewer_id=str(viewer_id),
        sse_attempt=attempt,
        is_reconnect=attempt > 0 or cursor > 0,
        cursor=cursor,
        cursor_source="after" if after is not None else "last_event_id" if cursor else "none",
    )

    # The ownership assert runs before listener setup and again in the same fresh
    # session before every replay/tail read, so a terminal event never crosses
    # the stream after ownership or visibility is revoked.
    def assert_viewer(db: Session) -> None:
        chat_reads.require_run(db, viewer_id=viewer_id, run_id=run_id)

    def read_after(after: int) -> tuple[Sequence[Any], bool]:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            assert_viewer(db)
            return chat_events.read_after(db, run_id, after)

    def read_advisory() -> tuple[str, dict[str, Any]] | None:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            assert_viewer(db)
            advisory = chat_reads.advisory(db, run_id=run_id)
            if advisory is None:
                return None
            return EXECUTION_ADVISORY_EVENT_TYPE, advisory.model_dump(mode="json")

    def assert_viewer_once() -> None:
        with get_session_factory()() as db:
            assert_viewer(db)

    await run_in_threadpool(assert_viewer_once)
    listener = await open_sse_listener(chat_events.CHANNEL, str(run_id))
    return StreamingResponse(
        tail_cursor_stream(
            request=request,
            listener=listener,
            after=cursor,
            read_after=read_after,
            read_advisory=read_advisory,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
    )


@router.get("/stream/oracle-readings/{reading_id}/events")
async def stream_oracle_reading_events(
    request: Request,
    reading_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    """The reading's ``OracleReadingOut`` on each change; ``done`` once it is complete or failed."""

    def read_snapshot() -> tuple[dict[str, Any], bool]:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            reading = oracle_readings.get_reading(db, viewer_id=viewer_id, reading_id=reading_id)
        return reading.model_dump(mode="json"), reading.status in ("complete", "failed")

    await run_in_threadpool(read_snapshot)
    listener = await open_sse_listener("oracle_readings", str(reading_id))
    return StreamingResponse(
        tail_snapshot_stream(request=request, listener=listener, read_snapshot=read_snapshot),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
    )


@router.get("/stream/artifact-builds/{artifact_build_id}/events")
async def stream_artifact_build_events(
    request: Request,
    artifact_build_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    """The build's ``DossierBuildOut`` on each change; ``done`` once it is not Active."""

    def read_snapshot() -> tuple[dict[str, Any], bool]:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            build = dossier_engine.build_state(db, build_id=artifact_build_id, viewer_id=viewer_id)
        return build.model_dump(mode="json"), build.status != "Active"

    await run_in_threadpool(read_snapshot)
    listener = await open_sse_listener("artifact_builds", str(artifact_build_id))
    return StreamingResponse(
        tail_snapshot_stream(request=request, listener=listener, read_snapshot=read_snapshot),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
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


@router.get("/stream/media/{media_id}/metadata/events")
async def stream_metadata_events(
    request: Request,
    media_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    await run_in_threadpool(_assert_media_readable, viewer_id, media_id)
    listener = await open_sse_listener("media_events", str(media_id))

    def snapshot() -> tuple[dict[str, Any], bool]:
        with get_session_factory()() as db:
            get_repeatable_read_db(db)
            view = metadata_operations.metadata_enrichment_for_viewer(
                db, viewer_id=viewer_id, media_id=media_id
            )
            return view.model_dump(mode="json"), False

    return StreamingResponse(
        tail_snapshot_stream(request=request, listener=listener, read_snapshot=snapshot),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
    )


@router.get("/stream/podcast-subscriptions/{podcast_id}/events")
async def stream_podcast_subscription_events(
    request: Request,
    podcast_id: UUID,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
) -> StreamingResponse:
    """Push one viewer-owned subscription until sync and historical backfill settle."""

    def read_lifecycle(
        *, expected_subscription_id: UUID | None = None
    ) -> podcast_subscription_service.PodcastSubscriptionLifecycle:
        with get_session_factory()() as db:
            return podcast_subscription_service.read_subscription_lifecycle(
                db,
                viewer_id=viewer_id,
                podcast_id=podcast_id,
                expected_subscription_id=expected_subscription_id,
            )

    # Ownership is asserted before opening LISTEN and again for each new state
    # read below. A deleted or transferred subscription therefore ends silently
    # rather than leaking its final state through a pre-existing stream.
    lifecycle = await run_in_threadpool(read_lifecycle)
    listener = await open_sse_listener(
        podcast_subscription_service.PODCAST_SUBSCRIPTION_NOTIFY_CHANNEL,
        str(lifecycle.subscription_id),
    )

    def read_snapshot() -> tuple[dict[str, Any], bool]:
        current = read_lifecycle(expected_subscription_id=lifecycle.subscription_id)
        return current.snapshot.model_dump(mode="json", by_alias=True), current.terminal

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


def _read_media_snapshot(viewer_id: UUID, media_id: UUID) -> tuple[dict[str, Any], bool]:
    with get_session_factory()() as db:
        snapshot = media_service.read_event_snapshot(db, viewer_id=viewer_id, media_id=media_id)
    return snapshot.payload.model_dump(mode="json"), snapshot.terminal


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
