"""One scope-owned LISTEN socket, local subscriptions and coalesced hint delivery.

All five channels are registered before the sole notification consumer starts.
Subscribers subscribe before reading, wake initially and on idle, and reread committed
state. A failed socket wakes every affected subscriber and ends their stream; existing
client retries register on a new socket. The API database scope closes and joins the
hub before its event loop ends. At most 64 local subscribers are admitted.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator

import psycopg
from anyio import CancelScope
from psycopg import sql

from nexus.config import get_settings
from nexus.db.engine import require_async_database_scope
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

MAX_LISTENERS = 64
_CHANNELS = (
    "nexus_writing",
    "nexus_suggestions",
    "chat_run_events",
    "oracle_readings",
    "media_events",
)
logger = get_logger(__name__)
_hub: _Hub | None = None


class _Hub:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.listeners: set[Listener] = set()
        self.conn: psycopg.AsyncConnection | None = None
        self.pump: asyncio.Task[None] | None = None
        self.failed = False

    async def start(self) -> None:
        if self.conn is not None:
            return
        url = get_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)
        conn = await psycopg.AsyncConnection.connect(
            url, autocommit=True, application_name=f"nexus:api:listener:{os.getpid()}"
        )
        try:
            for channel in _CHANNELS:
                await conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel)))
        except BaseException:
            with CancelScope(shield=True):
                await conn.close()
            raise
        self.conn = conn
        self.pump = asyncio.create_task(self.consume())

    async def consume(self) -> None:
        assert self.conn is not None
        try:
            async for note in self.conn.notifies():
                for listener in self.listeners:
                    if note.channel == listener.channel and note.payload == listener.key:
                        listener.wake.set()
        except Exception:
            logger.warning("stream.listen.failed", exc_info=True)
        finally:
            self.failed = True
            for listener in self.listeners:
                listener.wake.set()
            with CancelScope(shield=True):
                await self.conn.close()

    async def close(self) -> None:
        self.failed = True
        for listener in self.listeners:
            listener.wake.set()
        with CancelScope(shield=True):
            if self.pump is not None:
                self.pump.cancel()
                try:
                    await self.pump
                except asyncio.CancelledError:
                    pass
            if self.conn is not None:
                await self.conn.close()


class Listener:
    def __init__(self, hub: _Hub, channel: str, key: str) -> None:
        self.hub = hub
        self.channel = channel
        self.key = key
        self.wake = asyncio.Event()
        self.closed = False

    async def wakes(self, idle_seconds: float) -> AsyncIterator[None]:
        """Initially, then matching hints or idle; loss terminates rather than inventing state."""
        yield
        while not self.closed:
            try:
                async with asyncio.timeout(idle_seconds):
                    await self.wake.wait()
            except TimeoutError:
                pass
            self.wake.clear()
            if self.closed:
                return
            if self.hub.failed:
                raise RuntimeError("database notification connection ended")
            yield

    async def close(self) -> None:
        """Idempotent local unsubscribe; the shared socket stays warm until scope exit."""
        if not self.closed:
            self.closed = True
            self.hub.listeners.discard(self)
            self.wake.set()


async def open_listener(channel: str, key: str) -> Listener:
    """Subscribe locally after all socket registrations have acknowledged."""
    global _hub
    require_async_database_scope()
    if channel not in _CHANNELS:
        raise ValueError("unknown notification channel")
    while True:
        if _hub is None:
            _hub = _Hub()
        hub = _hub
        async with hub.lock:
            if hub is not _hub:
                continue
            if hub.failed:
                await hub.close()
                _hub = None
                continue
            if len(hub.listeners) >= MAX_LISTENERS:
                logger.warning("stream.listen.rejected", channel=channel, active=len(hub.listeners))
                raise ApiError(ApiErrorCode.E_RATE_LIMITED, "Too many live streams; retry shortly")
            await hub.start()
            listener = Listener(hub, channel, key)
            hub.listeners.add(listener)
            return listener


async def close_listeners() -> None:
    """Database-scope teardown: join the sole pump before forgetting loop-bound state."""
    global _hub
    if _hub is not None:
        await _hub.close()
        _hub = None
