"""Live streams: ``GET /stream/...``, reached through the bff's session lane like any route.

Two semantics share one envelope. A cursor stream (chat runs) emits each committed event
with ``id: <seq>`` and resumes after ``?after=<seq>``; a snapshot stream (oracle readings,
dossier builds, media processing, metadata, podcast subscriptions) emits the whole
``state`` when it changed and ``done`` when terminal, and a reconnect re-sends it. Every
wake (a NOTIFY carrying the entity id, or the keepalive timeout) re-reads committed state
in a fresh session, so a missed NOTIFY delays but never drops. The first read happens
before any byte, so a refusal is an ordinary error answer; a later read that finds the
entity gone closes the stream cleanly; each stream releases its listener however it ends.
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

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.listen import Listener, open_listener
from nexus.db.session import get_repeatable_read_db, get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.conversation import EXECUTION_ADVISORY_EVENT_TYPE
from nexus.schemas.suggestions import SuggestionCurrentOut, SuggestionWithdrawnOut
from nexus.services import media as media_service
from nexus.services import metadata_operations, suggestion_changes, suggestion_shortlists
from nexus.services.chat import events as chat_events
from nexus.services.chat import reads as chat_reads
from nexus.services.dossier import engine as dossier_engine
from nexus.services.oracle import readings as oracle_readings
from nexus.services.podcasts import subscriptions as podcast_subscriptions

router = APIRouter(tags=["streaming"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
KEEPALIVE_SECONDS = 15.0
_GONE = frozenset(
    {ApiErrorCode.E_NOT_FOUND, ApiErrorCode.E_MEDIA_NOT_FOUND, ApiErrorCode.E_DOSSIER_NOT_FOUND}
)
type Snapshot = tuple[dict[str, Any], bool]
type Advisory = tuple[str, dict[str, Any]]


def _frame(event_type: str, payload: Any, seq: int | None = None) -> str:
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}event: {event_type}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"


def _respond(frames: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(
        frames,
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


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
    try:
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
    finally:
        await listener.close()


async def _snapshot_frames(
    request: Request, listener: Listener, read: Callable[[], Snapshot]
) -> AsyncIterator[str]:
    last, quiet = None, time.monotonic()
    try:
        async for _ in listener.wakes(KEEPALIVE_SECONDS):
            if await request.is_disconnected():
                return
            try:
                payload, terminal = await run_in_threadpool(read)
            except ApiError as exc:
                if exc.code in _GONE:
                    return
                raise
            if payload != last:
                last, quiet = payload, time.monotonic()
                yield _frame("state", payload)
            if terminal:
                yield _frame("done", payload)
                return
            if time.monotonic() - quiet >= KEEPALIVE_SECONDS:
                quiet = time.monotonic()
                yield ": keepalive\n\n"
    finally:
        await listener.close()


async def _snapshot_stream(
    request: Request, channel: str, key: UUID, read: Callable[[], Snapshot]
) -> StreamingResponse:
    await run_in_threadpool(read)
    listener = await open_listener(channel, str(key))
    return _respond(_snapshot_frames(request, listener, read))


@router.get("/stream/lectern/suggestions")
async def stream_lectern_suggestions(request: Request, viewer: ViewerDep) -> StreamingResponse:
    return await _stream_suggestions(request, viewer_id=viewer.user_id, library_id=None)


@router.get("/stream/libraries/{library_id}/suggestions")
async def stream_library_suggestions(
    request: Request, library_id: UUID, viewer: ViewerDep
) -> StreamingResponse:
    return await _stream_suggestions(request, viewer_id=viewer.user_id, library_id=library_id)


async def _stream_suggestions(
    request: Request, *, viewer_id: UUID, library_id: UUID | None
) -> StreamingResponse:
    def read(*, initial: bool = False) -> Snapshot:
        try:
            with _snapshot() as db:
                state = suggestion_shortlists.read_suggestion_state(
                    db, viewer_id=viewer_id, library_id=library_id
                )
        except ApiError as exc:
            if initial or exc.code != ApiErrorCode.E_LIBRARY_NOT_FOUND:
                raise
            return SuggestionWithdrawnOut().model_dump(mode="json"), True
        if state.capability == "NotApplicable":
            return SuggestionWithdrawnOut().model_dump(mode="json"), True
        return SuggestionCurrentOut(state=state).model_dump(mode="json"), False

    await run_in_threadpool(read, initial=True)
    listener = await open_listener(suggestion_changes.CHANNEL, suggestion_changes.NOTIFY_KEY)
    return _respond(_snapshot_frames(request, listener, read))


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
            chat_reads.require_run(db, viewer_id=viewer.user_id, run_id=run_id)
            return chat_events.read_after(db, run_id, cursor)

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
    return _respond(_cursor_frames(request, listener, after, read_after, read_advisory))


@router.get("/stream/oracle-readings/{reading_id}/events")
async def stream_oracle_reading_events(
    request: Request, reading_id: UUID, viewer: ViewerDep
) -> StreamingResponse:
    """The reading on each change; ``done`` once complete or failed."""

    def read() -> Snapshot:
        with _snapshot() as db:
            reading = oracle_readings.get_reading(
                db, viewer_id=viewer.user_id, reading_id=reading_id
            )
        return reading.model_dump(mode="json"), reading.status in ("complete", "failed")

    return await _snapshot_stream(request, "oracle_readings", reading_id, read)


@router.get("/stream/artifact-builds/{artifact_build_id}/events")
async def stream_artifact_build_events(
    request: Request, artifact_build_id: UUID, viewer: ViewerDep
) -> StreamingResponse:
    """The build on each change; ``done`` once it is not Active."""

    def read() -> Snapshot:
        with _snapshot() as db:
            build = dossier_engine.build_state(
                db, build_id=artifact_build_id, viewer_id=viewer.user_id
            )
        return build.model_dump(mode="json"), build.status != "Active"

    return await _snapshot_stream(request, "artifact_builds", artifact_build_id, read)


@router.get("/stream/media/{media_id}/events")
async def stream_media_events(
    request: Request, media_id: UUID, viewer: ViewerDep
) -> StreamingResponse:
    """Processing state until nothing it shows is in flight (source work, a requested
    transcript, a readable media's index); media the viewer cannot read is E_MEDIA_NOT_FOUND.
    The client reopens it on the actions that can restart work."""

    def read() -> Snapshot:
        with _snapshot() as db:
            frame, terminal = media_service.read_processing_snapshot(
                db, viewer_id=viewer.user_id, media_id=media_id
            )
        return frame.model_dump(mode="json"), terminal

    return await _snapshot_stream(request, "media_events", media_id, read)


@router.get("/stream/media/{media_id}/metadata/events")
async def stream_metadata_events(
    request: Request, media_id: UUID, viewer: ViewerDep
) -> StreamingResponse:
    """Metadata enrichment state until nothing is unfinished (an idle media: one frame).

    Only a new run changes the view then; the client reopens the stream on admission and
    on every read that can follow one."""

    def read() -> Snapshot:
        with _snapshot() as db:
            view = metadata_operations.metadata_enrichment_for_viewer(
                db, viewer_id=viewer.user_id, media_id=media_id
            )
        return view.model_dump(mode="json"), view.unfinished_count == 0

    return await _snapshot_stream(request, "media_events", media_id, read)


@router.get("/stream/podcast-subscriptions/{podcast_id}/events")
async def stream_podcast_subscription_events(
    request: Request, podcast_id: UUID, viewer: ViewerDep
) -> StreamingResponse:
    """One subscription until sync and backfill settle; a deleted or transferred one ends
    silently (each read names the subscription the stream opened on)."""

    def lifecycle(expected: UUID | None) -> podcast_subscriptions.PodcastSubscriptionLifecycle:
        with get_session_factory()() as db:
            return podcast_subscriptions.read_subscription_lifecycle(
                db,
                viewer_id=viewer.user_id,
                podcast_id=podcast_id,
                expected_subscription_id=expected,
            )

    first = await run_in_threadpool(lifecycle, None)

    def read() -> Snapshot:
        current = lifecycle(first.subscription_id)
        return current.snapshot.model_dump(mode="json"), current.terminal

    listener = await open_listener(
        podcast_subscriptions.PODCAST_SUBSCRIPTION_NOTIFY_CHANNEL, str(first.subscription_id)
    )
    return _respond(_snapshot_frames(request, listener, read))
