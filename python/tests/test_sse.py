"""Wire-format and close-semantics tests for the shared SSE transport (`_sse`)."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest

from nexus.api.routes import stream as stream_routes
from nexus.api.routes._sse import (
    STREAM_GONE_CODES,
    format_sse_event,
    tail_cursor_stream,
    tail_snapshot_stream,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services import run_kit

pytestmark = pytest.mark.unit


class _FakeListener:
    def __init__(self, ticks: int = 3) -> None:
        self._ticks = ticks
        self.closed_reason: str | None = None

    async def notifications(self):
        for _ in range(self._ticks):
            yield

    async def close(self, *, reason: str = "closed") -> None:
        self.closed_reason = reason


class _FakeRequest:
    def __init__(self, disconnected: bool = False) -> None:
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


def test_format_sse_event_with_seq_emits_id_line():
    assert (
        format_sse_event(event_type="delta", payload={"a": 1}, seq=5)
        == 'id: 5\nevent: delta\ndata: {"a":1}\n\n'
    )


def test_format_sse_event_without_seq_omits_id_line():
    out = format_sse_event(event_type="state", payload={"a": 1})
    assert out == 'event: state\ndata: {"a":1}\n\n'
    assert "id:" not in out


def test_stream_gone_codes_cover_all_stream_not_found_codes():
    assert ApiErrorCode.E_NOT_FOUND in STREAM_GONE_CODES
    assert ApiErrorCode.E_MEDIA_NOT_FOUND in STREAM_GONE_CODES
    assert ApiErrorCode.E_DOSSIER_NOT_FOUND in STREAM_GONE_CODES


@pytest.mark.asyncio
async def test_cursor_emits_id_lines_and_closes_on_done():
    events = [
        SimpleNamespace(seq=1, event_type="delta", payload={"d": "hi"}),
        SimpleNamespace(seq=2, event_type="done", payload={"status": "complete"}),
    ]
    listener = _FakeListener()
    chunks = [
        chunk
        async for chunk in tail_cursor_stream(
            request=_FakeRequest(),
            listener=listener,
            after=0,
            read_after=lambda _cursor: (events, False),
        )
    ]
    assert chunks[0] == 'id: 1\nevent: delta\ndata: {"d":"hi"}\n\n'
    assert chunks[1].startswith("id: 2\nevent: done")
    assert listener.closed_reason == "terminal"


@pytest.mark.asyncio
async def test_cursor_closes_cleanly_when_read_raises_gone_code():
    def raise_gone(_cursor):
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "gone")

    listener = _FakeListener()
    chunks = [
        chunk
        async for chunk in tail_cursor_stream(
            request=_FakeRequest(), listener=listener, after=0, read_after=raise_gone
        )
    ]
    assert chunks == []
    assert listener.closed_reason == "gone"


@pytest.mark.asyncio
async def test_cursor_closes_cleanly_when_read_returns_terminal():
    # The oracle gone-path: a deleted reading returns terminal=True (not a raise).
    listener = _FakeListener()
    chunks = [
        chunk
        async for chunk in tail_cursor_stream(
            request=_FakeRequest(),
            listener=listener,
            after=0,
            read_after=lambda _cursor: ([], True),
        )
    ]
    assert chunks == []
    assert listener.closed_reason == "terminal"


@pytest.mark.asyncio
async def test_cursor_reauthorizes_before_terminal_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_checks = 0
    event_reads = 0
    listener = _FakeListener(ticks=1)

    class _SessionContext:
        def __enter__(self):
            return object()

        def __exit__(self, *_args) -> None:
            return None

    def assert_viewer(_db, _viewer_id, _entity_id) -> None:
        nonlocal auth_checks
        auth_checks += 1
        if auth_checks > 1:
            raise ApiError(ApiErrorCode.E_DOSSIER_NOT_FOUND, "revoked")

    def read_after(_db, _viewer_id, _entity_id, _after):
        nonlocal event_reads
        event_reads += 1
        return (
            [
                SimpleNamespace(
                    seq=1,
                    event_type="Succeeded",
                    payload={"artifact_revision_ref": "artifact_revision:r1"},
                )
            ],
            True,
        )

    async def open_listener(_channel: str, _key: str):
        return listener

    monkeypatch.setattr(
        stream_routes,
        "get_session_factory",
        lambda: lambda: _SessionContext(),
    )
    monkeypatch.setattr(stream_routes, "open_sse_listener", open_listener)
    response = await stream_routes.make_cursor_stream_response(
        stream_routes.CursorStreamKind(
            run_kind=run_kit.RunStreamKind.ArtifactBuild,
            assert_viewer=assert_viewer,
            read_after=read_after,
        ),
        request=_FakeRequest(),
        entity_id=uuid4(),
        viewer_id=uuid4(),
        after=0,
    )

    chunks = [chunk async for chunk in response.body_iterator]

    assert auth_checks == 2
    assert event_reads == 0
    assert chunks == []
    assert listener.closed_reason == "gone"


@pytest.mark.asyncio
async def test_cursor_emits_changed_unsequenced_execution_advisories():
    advisories = iter(
        [
            ("ExecutionAdvisory", {"phase": "Queued"}),
            ("ExecutionAdvisory", {"phase": "Queued"}),
            ("ExecutionAdvisory", {"phase": "Suspended"}),
        ]
    )
    listener = _FakeListener(ticks=3)
    chunks = [
        chunk
        async for chunk in tail_cursor_stream(
            request=_FakeRequest(),
            listener=listener,
            after=0,
            read_after=lambda _cursor: ([], False),
            read_advisory=lambda: next(advisories),
        )
    ]

    assert chunks == [
        'event: ExecutionAdvisory\ndata: {"phase":"Queued"}\n\n',
        'event: ExecutionAdvisory\ndata: {"phase":"Suspended"}\n\n',
    ]
    assert all("id:" not in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_snapshot_emits_state_then_done_without_id_lines():
    snapshots = iter(
        [
            ({"processing_status": "pending"}, False),
            ({"processing_status": "ready_for_reading"}, True),
        ]
    )
    listener = _FakeListener()
    chunks = [
        chunk
        async for chunk in tail_snapshot_stream(
            request=_FakeRequest(), listener=listener, read_snapshot=lambda: next(snapshots)
        )
    ]
    assert chunks[0] == 'event: state\ndata: {"processing_status":"pending"}\n\n'
    assert chunks[1] == 'event: state\ndata: {"processing_status":"ready_for_reading"}\n\n'
    assert chunks[2].startswith("event: done")
    assert all("id:" not in chunk for chunk in chunks)
    assert listener.closed_reason == "terminal"


@pytest.mark.asyncio
async def test_snapshot_closes_cleanly_when_read_raises_gone_code():
    def raise_gone():
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "gone")

    listener = _FakeListener()
    chunks = [
        chunk
        async for chunk in tail_snapshot_stream(
            request=_FakeRequest(), listener=listener, read_snapshot=raise_gone
        )
    ]
    assert chunks == []
    assert listener.closed_reason == "gone"
