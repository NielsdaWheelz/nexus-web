"""Async Postgres LISTEN/NOTIFY for push-driven SSE delivery.

The worker appends `chat_run_events` / `oracle_reading_events` rows or updates
`media`; AFTER triggers (migration 0122) `pg_notify` the row's id on a
per-table channel. An SSE handler listens on that channel and re-reads the
table when notified, so streaming is push-driven instead of polling.

The LISTEN connection is a raw psycopg async connection, not a SQLAlchemy pool
connection: it is long-lived and mostly idle, so it must not occupy a
request-pool slot. It runs in autocommit, so it holds no transaction and is
exempt from the API's idle-in-transaction timeout.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import psycopg
from psycopg import sql

from nexus.config import get_settings


async def wait_for_notifications(
    channel: str, target: str, idle_timeout_seconds: float
) -> AsyncIterator[None]:
    """Yield once immediately, then once per NOTIFY on `channel` whose payload
    equals `target`, and at least once per `idle_timeout_seconds`.

    The caller re-reads its table on every yield; the committed row — not the
    notification — is the source of truth, so a coalesced or missed NOTIFY only
    delays an update by up to `idle_timeout_seconds`, never drops it.
    `justify-polling`: the idle timeout is a bounded fallback for a missed
    notification, not the primary signal; its cadence is the stream keepalive
    interval.
    """
    # psycopg wants the bare libpq URL, not SQLAlchemy's postgresql+psycopg://.
    url = get_settings().database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    conn = await psycopg.AsyncConnection.connect(url, autocommit=True)
    try:
        await conn.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel)))
        yield  # initial read replays rows committed before the first NOTIFY
        while True:
            async for note in conn.notifies(timeout=idle_timeout_seconds):
                if note.payload == target:
                    break
            yield
    finally:
        await conn.close()
