"""Focused tests for shared SSE Postgres LISTEN resource ownership."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from nexus.db import listen
from nexus.errors import ApiErrorCode

pytestmark = pytest.mark.unit


class _FakeConnection:
    def __init__(self, payloads: list[str] | None = None, *, fail_execute: bool = False) -> None:
        self.payloads = payloads or []
        self.fail_execute = fail_execute
        self.executed: list[object] = []
        self.closed = False

    async def execute(self, query: object) -> object:
        if self.fail_execute:
            raise RuntimeError("listen failed")
        self.executed.append(query)
        return object()

    def notifies(self, *, timeout: float):
        return self._notifies(timeout=timeout)

    async def _notifies(self, *, timeout: float):
        del timeout
        while self.payloads:
            yield SimpleNamespace(payload=self.payloads.pop(0))

    async def close(self) -> None:
        self.closed = True


class _RecordingLogger:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, object]]] = []

    def info(self, event: str, **kwargs: object) -> None:
        self.events.append(("info", event, kwargs))

    def warning(self, event: str, **kwargs: object) -> None:
        self.events.append(("warning", event, kwargs))


@pytest.mark.asyncio
async def test_listen_manager_caps_process_local_connections(monkeypatch) -> None:
    connections: list[_FakeConnection] = []

    async def fake_connect() -> _FakeConnection:
        conn = _FakeConnection()
        connections.append(conn)
        return conn

    monkeypatch.setattr(listen, "_connect", fake_connect)
    manager = listen.PostgresListenManager(max_connections=1)

    listener = await manager.open(channel="media_events", target="media-1", idle_timeout_seconds=1)

    with pytest.raises(listen.StreamListenCapacityError) as exc_info:
        await manager.open(channel="media_events", target="media-2", idle_timeout_seconds=1)

    assert exc_info.value.code == ApiErrorCode.E_RATE_LIMITED
    assert exc_info.value.status_code == 429
    assert "capacity exhausted" in exc_info.value.message
    assert manager.stats == listen.StreamListenStats(active=1, capacity=1)
    assert len(connections) == 1

    await listener.close(reason="test")

    assert manager.stats == listen.StreamListenStats(active=0, capacity=1)
    assert connections[0].closed is True


@pytest.mark.asyncio
async def test_listen_manager_logs_open_rejection_and_close(monkeypatch) -> None:
    recorded = _RecordingLogger()

    async def fake_connect() -> _FakeConnection:
        return _FakeConnection()

    monkeypatch.setattr(listen, "_connect", fake_connect)
    monkeypatch.setattr(listen, "logger", recorded)
    manager = listen.PostgresListenManager(max_connections=1)

    listener = await manager.open(
        channel="chat_run_events",
        target="run-1",
        idle_timeout_seconds=15,
    )
    with pytest.raises(listen.StreamListenCapacityError):
        await manager.open(channel="chat_run_events", target="run-2", idle_timeout_seconds=15)
    await listener.close(reason="terminal")

    event_names = [event for _level, event, _fields in recorded.events]
    assert event_names == [
        "stream.listen.open",
        "stream.listen.rejected",
        "stream.listen.close",
    ]
    close_fields = recorded.events[-1][2]
    assert close_fields["channel"] == "chat_run_events"
    assert close_fields["target"] == "run-1"
    assert close_fields["reason"] == "terminal"
    assert close_fields["active_listeners"] == 0
    assert close_fields["max_listeners"] == 1


@pytest.mark.asyncio
async def test_listen_manager_releases_capacity_when_listen_fails(monkeypatch) -> None:
    conn = _FakeConnection(fail_execute=True)

    async def fake_connect() -> _FakeConnection:
        return conn

    monkeypatch.setattr(listen, "_connect", fake_connect)
    manager = listen.PostgresListenManager(max_connections=1)

    with pytest.raises(RuntimeError, match="listen failed"):
        await manager.open(channel="media_events", target="media-1", idle_timeout_seconds=1)

    assert manager.stats == listen.StreamListenStats(active=0, capacity=1)
    assert conn.closed is True


@pytest.mark.asyncio
async def test_listener_yields_initial_tick_and_filters_notification_payloads(monkeypatch) -> None:
    conn = _FakeConnection(payloads=["other", "target"])

    async def fake_connect() -> _FakeConnection:
        return conn

    monkeypatch.setattr(listen, "_connect", fake_connect)
    manager = listen.PostgresListenManager(max_connections=1)
    listener = await manager.open(channel="media_events", target="target", idle_timeout_seconds=1)
    notifications = listener.notifications()

    assert await notifications.__anext__() is None
    assert await notifications.__anext__() is None

    await listener.close(reason="test")
