"""Database sessions: the process factory, the request session, snapshots and transactions.

A session never autoflushes (a query does not see unflushed adds) and keeps objects readable
after commit (a committed object holds its values until it is refreshed).
"""

from collections.abc import AsyncIterator, Generator
from contextlib import contextmanager
from functools import lru_cache
from typing import Annotated

from anyio import CancelScope, CapacityLimiter, to_thread
from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.engine import get_async_engine, get_engine


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    """The process's one session factory."""
    return sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)


def open_async_session() -> AsyncSession:
    """One async session on its own connection. Sync domain code runs in it through
    `run_sync`, whose greenlet bridge awaits psycopg on the calling loop without threads."""
    return AsyncSession(get_async_engine(), autoflush=False, expire_on_commit=False)


def _release(db: Session) -> None:
    try:
        if db.in_transaction():
            db.rollback()
    finally:
        db.close()


async def get_db() -> AsyncIterator[Session]:
    """One request session. After the response is serialized and before its body streams, it
    rolls back and closes on its own thread (its own limiter: a saturated default pool cannot
    strand it), shielded, even when the client has gone. A stream must not borrow it."""
    db = get_session_factory()()
    try:
        yield db
    finally:
        with CancelScope(shield=True):
            await to_thread.run_sync(_release, db, limiter=CapacityLimiter(1))


DbSession = Annotated[Session, Depends(get_db, scope="function")]


def get_repeatable_read_db(db: DbSession) -> Session:
    """One REPEATABLE READ, READ ONLY snapshot; a session with a transaction open is refused."""
    if db.in_transaction():
        raise RuntimeError("repeatable-read dependency requires a fresh session")
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    return db


RepeatableReadDbSession = Annotated[Session, Depends(get_repeatable_read_db, scope="function")]


@contextmanager
def transaction(db: Session) -> Generator[None, None, None]:
    """Commit what the block did; on an exception roll back and re-raise."""
    try:
        yield
        db.commit()
    except Exception:
        db.rollback()
        raise
