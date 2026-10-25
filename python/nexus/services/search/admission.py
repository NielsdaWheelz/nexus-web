"""One database-wide expensive search, including result consumption and backend cleanup.

The owned physical connection holds a named session advisory lock across admission
transaction rollback and the caller's fresh read snapshot. It is retired on exit;
there is no explicit unlock that could admit another read before backend cleanup.
Provider calls and direct lookups happen outside these contexts. Async callers carry
their existing absolute deadline through connection, admission and snapshot work.
The database connection must retain one server session across transactions, as the
current standalone PostgreSQL deployment does; transaction-pooling proxies do not.
"""

import asyncio
import math
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from nexus.db.engine import get_async_engine, get_engine
from nexus.db.session import get_session_factory
from nexus.logging import get_logger

logger = get_logger(__name__)


def remaining_milliseconds(deadline: float) -> int:
    """The original caller budget; an expired operation must never begin another read."""
    remaining = math.ceil((deadline - asyncio.get_running_loop().time()) * 1000)
    if remaining <= 0:
        raise TimeoutError("Search deadline expired")
    return remaining


def _admit(db: Session, deadline: float | None) -> None:
    db.execute(text("SET LOCAL lock_timeout = '0'"))
    if deadline is not None:
        db.execute(
            text("SELECT set_config('statement_timeout', :timeout, true)"),
            {"timeout": str(remaining_milliseconds(deadline))},
        )
    db.execute(
        text("SELECT pg_advisory_lock(hashtextextended(:key, 0))"),
        {"key": "nexus:expensive-search"},
    )
    # The external connection retains its session lock, but not the admission snapshot.
    db.rollback()
    if deadline is not None:
        remaining_milliseconds(deadline)


@contextmanager
def search_session() -> Iterator[Session]:
    """One admitted sync session; the caller materializes its read before leaving."""
    with get_engine().connect() as connection:
        try:
            with get_session_factory()(bind=connection) as db:
                _admit(db, None)
                yield db
        finally:
            connection.invalidate()


@asynccontextmanager
async def search_session_async(*, deadline: float | None = None) -> AsyncIterator[AsyncSession]:
    """Native cancellable admission; cancellation closes its waiting or reading backend."""
    if deadline is not None:
        remaining_milliseconds(deadline)
    logger.info("search.connection.begin", mono_ns=time.monotonic_ns())
    async with get_async_engine().connect() as connection:
        logger.info("search.connection.end", mono_ns=time.monotonic_ns())
        try:
            async with AsyncSession(
                bind=connection, autoflush=False, expire_on_commit=False
            ) as database:
                try:
                    logger.info("search.admission.begin", mono_ns=time.monotonic_ns())
                    await database.run_sync(lambda db: _admit(db, deadline))
                    logger.info("search.admission.admitted", mono_ns=time.monotonic_ns())
                    yield database
                finally:
                    logger.info("search.connection_cleanup.begin", mono_ns=time.monotonic_ns())
        finally:
            await connection.invalidate()
            logger.info("search.connection_cleanup.end", mono_ns=time.monotonic_ns())
