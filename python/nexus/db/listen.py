"""Postgres LISTEN for live streams.

Domain triggers ``pg_notify(channel, entity_id)`` after a commit. A stream holds one raw
autocommit psycopg connection (no pool slot, no transaction, so no idle-in-transaction
timeout) and wakes on its entity's notification or after an idle timeout; the caller
re-reads committed state on every wake, so a notification is a hint, never the truth.
At most ``MAX_LISTENERS`` per process (I8): one more is refused with 429
``E_RATE_LIMITED``, which clients retry.
"""

import threading
from collections.abc import AsyncIterator

import psycopg
from psycopg import sql

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

MAX_LISTENERS = 64
logger = get_logger(__name__)
_lock = threading.Lock()
_active = 0


def _release() -> None:
    global _active
    with _lock:
        _active -= 1


class Listener:
    def __init__(self, conn: psycopg.AsyncConnection, channel: str, key: str) -> None:
        self._conn = conn
        self._channel = channel
        self._key = key
        self._closed = False

    async def wakes(self, idle_seconds: float) -> AsyncIterator[None]:
        """Once at once (rows committed before LISTEN), then per notification or idle timeout."""
        yield
        while True:
            async for note in self._conn.notifies(timeout=idle_seconds):
                if note.payload == self._key:
                    break
            yield

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        _release()
        try:
            await self._conn.close()
        except Exception:
            logger.warning("stream.listen.close_failed", channel=self._channel, exc_info=True)


async def open_listener(channel: str, key: str) -> Listener:
    """A listener on ``channel`` waking for ``key``; the caller closes it."""
    global _active
    with _lock:
        if _active >= MAX_LISTENERS:
            logger.warning("stream.listen.rejected", channel=channel, active=_active)
            raise ApiError(ApiErrorCode.E_RATE_LIMITED, "Too many live streams; retry shortly")
        _active += 1
    try:
        # psycopg takes the bare libpq url, not SQLAlchemy's postgresql+psycopg://
        url = get_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)
        conn = await psycopg.AsyncConnection.connect(url, autocommit=True)
    except BaseException:
        _release()
        raise
    listener = Listener(conn, channel, key)
    try:
        await conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel)))
    except BaseException:
        await listener.close()
        raise
    return listener
