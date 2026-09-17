"""Shared async Postgres LISTEN/NOTIFY resources for SSE delivery.

Workers append durable run events or update snapshot owners such as media,
Podcast refresh runs, subscriptions, and backfills. AFTER triggers `pg_notify`
only the entity identity on a per-owner channel. An SSE handler listens on that
channel and re-reads the table when notified, so streaming is push-driven
instead of polling.

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
from time import monotonic
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.rows import TupleRow

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


class PostgresStreamListener:
    def __init__(
        self,
        *,
        manager: PostgresListenManager,
        conn: psycopg.AsyncConnection[TupleRow],
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
            active = self._manager._release()
            logger.info(
                "stream.listen.close",
                listener_id=self._listener_id,
                channel=self._channel,
                target=self._target,
                reason=reason,
                active_listeners=active,
                max_listeners=STREAM_LISTEN_MAX_CONNECTIONS,
                duration_seconds=round(monotonic() - self._opened_at, 3),
            )
        if close_error is not None:
            raise close_error


class PostgresListenManager:
    def __init__(self) -> None:
        self._active = 0
        self._lock = threading.Lock()

    async def open(
        self,
        *,
        channel: str,
        target: str,
        idle_timeout_seconds: float,
    ) -> PostgresStreamListener:
        listener_id, active_after_acquire = self._reserve(channel=channel, target=target)
        conn: psycopg.AsyncConnection[TupleRow] | None = None
        try:
            conn = await _connect()
            await conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel)))
        except BaseException:
            active = self._release()
            if conn is not None:
                try:
                    await conn.close()
                except BaseException as close_exc:
                    logger.warning(
                        "stream.listen.open_cleanup_failed",
                        listener_id=listener_id,
                        channel=channel,
                        target=target,
                        error=str(close_exc),
                    )
            logger.warning(
                "stream.listen.open_failed",
                listener_id=listener_id,
                channel=channel,
                target=target,
                active_listeners=active,
                max_listeners=STREAM_LISTEN_MAX_CONNECTIONS,
            )
            raise

        logger.info(
            "stream.listen.open",
            listener_id=listener_id,
            channel=channel,
            target=target,
            active_listeners=active_after_acquire,
            max_listeners=STREAM_LISTEN_MAX_CONNECTIONS,
            idle_timeout_seconds=idle_timeout_seconds,
        )
        return PostgresStreamListener(
            manager=self,
            conn=conn,
            listener_id=listener_id,
            channel=channel,
            target=target,
            idle_timeout_seconds=idle_timeout_seconds,
            opened_at=monotonic(),
        )

    def _reserve(self, *, channel: str, target: str) -> tuple[str, int]:
        with self._lock:
            if self._active >= STREAM_LISTEN_MAX_CONNECTIONS:
                logger.warning(
                    "stream.listen.rejected",
                    channel=channel,
                    target=target,
                    active_listeners=self._active,
                    max_listeners=STREAM_LISTEN_MAX_CONNECTIONS,
                )
                raise StreamListenCapacityError()
            self._active += 1
            return str(uuid4()), self._active

    def _release(self) -> int:
        with self._lock:
            if self._active > 0:
                self._active -= 1
            return self._active


_listen_manager = PostgresListenManager()


async def _connect() -> psycopg.AsyncConnection[TupleRow]:
    # psycopg wants the bare libpq URL, not SQLAlchemy's postgresql+psycopg://.
    url = get_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    return await psycopg.AsyncConnection.connect(url, autocommit=True)


async def open_stream_listener(
    channel: str, target: str, idle_timeout_seconds: float
) -> PostgresStreamListener:
    return await _listen_manager.open(
        channel=channel,
        target=target,
        idle_timeout_seconds=idle_timeout_seconds,
    )
