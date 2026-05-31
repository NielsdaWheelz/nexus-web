from __future__ import annotations

import pytest

from nexus.db.session import REQUEST_DB_SESSIONS_STATE_KEY
from nexus.middleware.db_session import RequestDbSessionMiddleware


class FakeSession:
    def __init__(self) -> None:
        self.closed = False
        self.rollback_count = 0
        self.close_count = 0
        self.transaction_open = True

    def in_transaction(self) -> bool:
        return self.transaction_open

    def rollback(self) -> None:
        self.rollback_count += 1
        self.transaction_open = False

    def close(self) -> None:
        self.close_count += 1
        self.closed = True


async def _empty_receive() -> dict:
    return {"type": "http.request", "body": b"", "more_body": False}


@pytest.mark.asyncio
async def test_request_db_session_middleware_releases_before_response_body() -> None:
    session = FakeSession()
    send_observations: list[tuple[str, bool]] = []

    async def app(scope, receive, send) -> None:
        scope["state"][REQUEST_DB_SESSIONS_STATE_KEY] = [session]
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            }
        )
        await send({"type": "http.response.body", "body": b"ok", "more_body": False})

    async def send(message) -> None:
        send_observations.append((message["type"], session.closed))

    middleware = RequestDbSessionMiddleware(app)
    await middleware({"type": "http", "state": {}}, _empty_receive, send)

    assert send_observations == [
        ("http.response.start", True),
        ("http.response.body", True),
    ]
    assert session.rollback_count == 1
    assert session.close_count == 1


@pytest.mark.asyncio
async def test_request_db_session_middleware_clears_tracked_sessions() -> None:
    session = FakeSession()
    scope = {"type": "http", "state": {}}

    async def app(scope, receive, send) -> None:
        scope["state"][REQUEST_DB_SESSIONS_STATE_KEY] = [session]
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [],
            }
        )

    async def send(message) -> None:
        return None

    middleware = RequestDbSessionMiddleware(app)
    await middleware(scope, _empty_receive, send)

    assert scope["state"][REQUEST_DB_SESSIONS_STATE_KEY] == []
    assert session.close_count == 1


@pytest.mark.asyncio
async def test_request_db_session_middleware_releases_when_app_raises_before_response() -> None:
    session = FakeSession()

    async def app(scope, receive, send) -> None:
        scope["state"][REQUEST_DB_SESSIONS_STATE_KEY] = [session]
        raise RuntimeError("boom")

    async def send(message) -> None:
        raise AssertionError(f"unexpected send: {message!r}")

    middleware = RequestDbSessionMiddleware(app)

    with pytest.raises(RuntimeError, match="boom"):
        await middleware({"type": "http", "state": {}}, _empty_receive, send)

    assert session.closed is True
    assert session.rollback_count == 1
    assert session.close_count == 1


@pytest.mark.asyncio
async def test_request_db_session_middleware_noops_without_tracked_sessions() -> None:
    sent: list[str] = []

    async def app(scope, receive, send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 204,
                "headers": [],
            }
        )

    async def send(message) -> None:
        sent.append(message["type"])

    middleware = RequestDbSessionMiddleware(app)
    await middleware({"type": "http", "state": {}}, _empty_receive, send)

    assert sent == ["http.response.start"]
