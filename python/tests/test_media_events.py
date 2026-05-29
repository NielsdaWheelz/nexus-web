"""Integration test for the media processing-status SSE stream."""

from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.api.routes import media_events as media_events_route
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
async def test_media_events_emits_state_on_open_and_changes_then_done(
    direct_db: DirectSessionManager,
) -> None:
    """Stream opens with current state, emits each change, terminates on ready.

    Push-driven: each committed ``media`` UPDATE fires the migration-0122
    trigger's NOTIFY, which wakes the tail's LISTEN connection immediately.
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
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("users", "id", user_id)

    request = _FakeRequest()
    generator = media_events_route._tail_media_events(
        request=request, media_id=media_id, viewer_id=user_id
    )

    # First yield: the initial `state` snapshot reflecting `pending`.
    first_chunk = await generator.__anext__()
    event_type, payload = _parse_state_event(first_chunk)
    assert event_type == "state", f"expected first event to be 'state', got '{event_type}'"
    assert payload["processing_status"] == "pending", (
        f"expected processing_status='pending' on stream open, got {payload}"
    )
    assert "capabilities" in payload and isinstance(payload["capabilities"], dict)
    assert "updated_at" in payload and isinstance(payload["updated_at"], str)

    # Advance to ready_for_reading; the next yielded frame should be the new state.
    _update_processing_status(direct_db, media_id, "ready_for_reading")
    next_chunk = await generator.__anext__()
    event_type, payload = _parse_state_event(next_chunk)
    assert event_type == "state", f"expected 'state' after status change, got '{event_type}'"
    assert payload["processing_status"] == "ready_for_reading", (
        f"expected 'ready_for_reading' after mid-stream update, got {payload}"
    )

    # Advance to terminal `ready`; expect one more state frame then a `done`.
    _update_processing_status(direct_db, media_id, "ready")
    chunk = await generator.__anext__()
    event_type, payload = _parse_state_event(chunk)
    assert event_type == "state", f"expected 'state' for terminal transition, got '{event_type}'"
    assert payload["processing_status"] == "ready", (
        f"expected 'ready' on terminal transition, got {payload}"
    )

    done_chunk = await generator.__anext__()
    event_type, payload = _parse_state_event(done_chunk)
    assert event_type == "done", f"expected 'done' on terminal status, got '{event_type}'"
    assert payload["processing_status"] == "ready", (
        f"expected done payload to carry final state, got {payload}"
    )

    # After `done`, the generator must close cleanly.
    with pytest.raises(StopAsyncIteration):
        await generator.__anext__()
