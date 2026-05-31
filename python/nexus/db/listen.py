"""Shared async Postgres LISTEN/NOTIFY resources for SSE delivery.

The worker appends `chat_run_events` / `oracle_reading_events` rows or updates
`media`; AFTER triggers `pg_notify` the row's id on a per-table channel. An
SSE handler listens on that channel and re-reads the table when notified, so
streaming is push-driven instead of polling.

The LISTEN connection is a raw psycopg async connection, not a SQLAlchemy pool
connection: it is long-lived and mostly idle, so it must not occupy a
request-pool slot. It runs in autocommit, so it holds no transaction and is
exempt from the API's idle-in-transaction timeout.

The raw connection is owned here, not by individual routes. This layer caps
process-local listener count and logs open/close/rejection events so a stream
surge is visible before ordinary request DB pools are exhausted.
"""

from __future__ import annotations

import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass
from time import monotonic
from typing import Protocol, cast
from uuid import uuid4

import psycopg
from psycopg import sql

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

STREAM_LISTEN_MAX_CONNECTIONS = 64


class StreamListenCapacityError(ApiError):
    """Raised when the process-local SSE LISTEN cap is exhausted."""

    def __init__(self) -> None:
        super().__init__(
            ApiErrorCode.E_RATE_LIMITED,
            "Stream listener capacity exhausted; retry shortly.",
        )


class StreamNotificationListener(Protocol):
    """Resource returned by the shared stream LISTEN layer."""

    def notifications(self) -> AsyncIterator[None]:
        """Yield an initial tick, then ticks for relevant notifications/timeouts."""
        ...

    async def close(self, *, reason: str = "closed") -> None:
        """Close the underlying LISTEN connection and release capacity."""
        ...


class _Notification(Protocol):
    payload: str


class _ListenConnection(Protocol):
    async def execute(self, query: object) -> object: ...

    def notifies(self, *, timeout: float) -> AsyncIterator[_Notification]: ...

    async def close(self) -> None: ...


@dataclass(frozen=True)
class StreamListenStats:
    active: int
    capacity: int


@dataclass(frozen=True)
class _ListenSlot:
    listener_id: str
    active_after_acquire: int


class PostgresStreamListener:
    def __init__(
        self,
        *,
        manager: PostgresListenManager,
        conn: _ListenConnection,
        listener_id: str,
        channel: str,
        target: str,
        idle_timeout_seconds: float,
        opened_at: float,
    ) -> None:
        self._manager = manager
        self._conn = conn
        self._listener_id = listener_id
        self._channel = channel
        self._target = target
        self._idle_timeout_seconds = idle_timeout_seconds
        self._opened_at = opened_at
        self._closed = False

    def notifications(self) -> AsyncIterator[None]:
        return self._notifications()

    async def _notifications(self) -> AsyncIterator[None]:
        """Yield once immediately, then once per matching NOTIFY or idle timeout.

        The caller re-reads its table on every yield; the committed row, not the
        notification, is the source of truth, so a coalesced or missed NOTIFY
        only delays an update by up to `idle_timeout_seconds`, never drops it.
        `justify-polling`: the idle timeout is a bounded fallback for a missed
        notification, not the primary signal; its cadence is the stream
        keepalive interval.
        """
        yield  # initial read replays rows committed before the first NOTIFY
        while True:
            async for note in self._conn.notifies(timeout=self._idle_timeout_seconds):
                if note.payload == self._target:
                    break
            yield

    async def close(self, *, reason: str = "closed") -> None:
        if self._closed:
            return
        self._closed = True
        close_error: BaseException | None = None
        try:
            await self._conn.close()
        except BaseException as exc:
            close_error = exc
            logger.warning(
                "stream.listen.close_failed",
                listener_id=self._listener_id,
                channel=self._channel,
                target=self._target,
                reason=reason,
                error=str(exc),
            )
        finally:
            stats = self._manager._release()
            logger.info(
                "stream.listen.close",
                listener_id=self._listener_id,
                channel=self._channel,
                target=self._target,
                reason=reason,
                active_listeners=stats.active,
                max_listeners=stats.capacity,
                duration_seconds=round(monotonic() - self._opened_at, 3),
            )
        if close_error is not None:
            raise close_error


class PostgresListenManager:
    def __init__(
        self,
        *,
        max_connections: int = STREAM_LISTEN_MAX_CONNECTIONS,
    ) -> None:
        if max_connections < 1:
            raise ValueError("max_connections must be >= 1")
        self._max_connections = max_connections
        self._active = 0
        self._lock = threading.Lock()

    @property
    def stats(self) -> StreamListenStats:
        with self._lock:
            return StreamListenStats(active=self._active, capacity=self._max_connections)

    async def open(
        self,
        *,
        channel: str,
        target: str,
        idle_timeout_seconds: float,
    ) -> PostgresStreamListener:
        slot = self._reserve(channel=channel, target=target)
        conn: _ListenConnection | None = None
        try:
            conn = await _connect()
            await conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel)))
        except BaseException:
            stats = self._release()
            if conn is not None:
                try:
                    await conn.close()
                except BaseException as close_exc:
                    logger.warning(
                        "stream.listen.open_cleanup_failed",
                        listener_id=slot.listener_id,
                        channel=channel,
                        target=target,
                        error=str(close_exc),
                    )
            logger.warning(
                "stream.listen.open_failed",
                listener_id=slot.listener_id,
                channel=channel,
                target=target,
                active_listeners=stats.active,
                max_listeners=stats.capacity,
            )
            raise

        logger.info(
            "stream.listen.open",
            listener_id=slot.listener_id,
            channel=channel,
            target=target,
            active_listeners=slot.active_after_acquire,
            max_listeners=self._max_connections,
            idle_timeout_seconds=idle_timeout_seconds,
        )
        return PostgresStreamListener(
            manager=self,
            conn=conn,
            listener_id=slot.listener_id,
            channel=channel,
            target=target,
            idle_timeout_seconds=idle_timeout_seconds,
            opened_at=monotonic(),
        )

    def _reserve(self, *, channel: str, target: str) -> _ListenSlot:
        with self._lock:
            if self._active >= self._max_connections:
                logger.warning(
                    "stream.listen.rejected",
                    channel=channel,
                    target=target,
                    active_listeners=self._active,
                    max_listeners=self._max_connections,
                )
                raise StreamListenCapacityError()
            self._active += 1
            return _ListenSlot(
                listener_id=str(uuid4()),
                active_after_acquire=self._active,
            )

    def _release(self) -> StreamListenStats:
        with self._lock:
            if self._active > 0:
                self._active -= 1
            return StreamListenStats(active=self._active, capacity=self._max_connections)


_listen_manager = PostgresListenManager()


async def _connect() -> _ListenConnection:
    # psycopg wants the bare libpq URL, not SQLAlchemy's postgresql+psycopg://.
    url = get_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    return cast(
        _ListenConnection,
        await psycopg.AsyncConnection.connect(url, autocommit=True),
    )


async def open_stream_listener(
    channel: str, target: str, idle_timeout_seconds: float
) -> PostgresStreamListener:
    return await _listen_manager.open(
        channel=channel,
        target=target,
        idle_timeout_seconds=idle_timeout_seconds,
    )
