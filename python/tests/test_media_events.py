"""Integration test for the media processing-status SSE stream."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text

from nexus.api.routes import _sse
from nexus.api.routes import stream as stream_route
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.factories import create_test_media_in_library
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


class _FakeRequest:
    """Minimal stand-in for fastapi.Request inside the SSE generator.

    The generator only awaits `is_disconnected`; provide a flag so tests
    can simulate a client disconnect deterministically.
    """

    def __init__(self) -> None:
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


def _parse_state_event(chunk: str) -> tuple[str, dict]:
    """Parse a single SSE frame into (event_type, data_dict)."""
    lines = [line for line in chunk.split("\n") if line and not line.startswith(":")]
    fields: dict[str, str] = {}
    for line in lines:
        key, value = line.split(": ", 1)
        fields[key] = value
    return fields["event"], json.loads(fields["data"])


async def _next_event(generator: AsyncIterator[str]) -> tuple[str, dict]:
    while True:
        chunk = await generator.__anext__()
        if chunk.startswith(":"):
            continue
        return _parse_state_event(chunk)


def _update_processing_status(direct_db: DirectSessionManager, media_id: UUID, status: str) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                "UPDATE media SET processing_status = :status, updated_at = now() "
                "WHERE id = :media_id"
            ),
            {"media_id": media_id, "status": status},
        )
        session.commit()


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_status", ["ready_for_reading", "failed"])
async def test_media_events_emits_state_on_open_and_changes_then_done(
    direct_db: DirectSessionManager,
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
    terminal_status: str,
) -> None:
    """Stream opens with current state, emits each change, terminates on readable.

    Push-driven: each committed ``media`` UPDATE fires NOTIFY, which wakes the
    tail's LISTEN connection immediately.
    """
    user_id = uuid4()
    with direct_db.session() as session:
        default_library_id = ensure_user_and_default_library(session, user_id)
        media_id = create_test_media_in_library(
            session,
            user_id,
            default_library_id,
            title="Pending Article",
            status="pending",
        )
        session.commit()
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("users", "id", user_id)
    from nexus.db.session import create_session_factory

    session_factory = create_session_factory(engine)
    monkeypatch.setattr(stream_route, "get_session_factory", lambda: session_factory)

    request = _FakeRequest()
    listener = await _sse.open_sse_listener("media_events", str(media_id))
    generator = _sse.tail_snapshot_stream(
        request=request,
        listener=listener,
        read_snapshot=lambda: stream_route._read_media_snapshot(user_id, media_id),
    )

    # First yield: the initial `state` snapshot reflecting `pending`.
    event_type, payload = await _next_event(generator)
    assert event_type == "state", f"expected first event to be 'state', got '{event_type}'"
    assert payload["processing_status"] == "pending", (
        f"expected processing_status='pending' on stream open, got {payload}"
    )
    assert "capabilities" in payload and isinstance(payload["capabilities"], dict)
    assert "updated_at" in payload and isinstance(payload["updated_at"], str)

    # Advance to a terminal state; the next yielded frame should close the stream.
    _update_processing_status(direct_db, media_id, terminal_status)
    event_type, payload = await _next_event(generator)
    assert event_type == "state", f"expected 'state' after status change, got '{event_type}'"
    assert payload["processing_status"] == terminal_status

    event_type, payload = await _next_event(generator)
    assert event_type == "done", f"expected 'done' on terminal status, got '{event_type}'"
    assert payload["processing_status"] == terminal_status

    # After `done`, the generator must close cleanly.
    with pytest.raises(StopAsyncIteration):
        await generator.__anext__()
