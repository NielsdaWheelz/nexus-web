"""database sessions and transaction helpers.

function-scoped dependencies release request sessions before body transfer.
"""

from collections.abc import AsyncIterator, Generator
from contextlib import contextmanager
from functools import lru_cache
from typing import Annotated

from anyio import CancelScope, CapacityLimiter, to_thread
from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.engine import get_engine


def create_session_factory() -> sessionmaker[Session]:
    """Create a session factory bound to the application engine."""
    return sessionmaker(
        bind=get_engine(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    """The process-wide session factory."""
    return create_session_factory()


def _release_session(db: Session) -> None:
    try:
        if db.in_transaction():
            db.rollback()
    finally:
        db.close()


async def get_db() -> AsyncIterator[Session]:
    """yield one request session through handler execution and serialization."""
    db = get_session_factory()()
    try:
        yield db
    finally:
        with CancelScope(shield=True):
            await to_thread.run_sync(_release_session, db, limiter=CapacityLimiter(1))


DbSession = Annotated[Session, Depends(get_db, scope="function")]


def get_repeatable_read_db(db: DbSession) -> Session:
    """Start one strict read-only snapshot on a fresh request session."""

    if db.in_transaction():
        raise RuntimeError("repeatable-read dependency requires a fresh session")
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    return db


RepeatableReadDbSession = Annotated[Session, Depends(get_repeatable_read_db, scope="function")]


def use_serializable(db: Session) -> None:
    """Select SERIALIZABLE before an attempt opens its transaction."""
    if not db.in_transaction():
        db.connection(execution_options={"isolation_level": "SERIALIZABLE"})


def use_read_committed(db: Session) -> None:
    """Select READ COMMITTED before an attempt opens its transaction."""
    if not db.in_transaction():
        db.connection(execution_options={"isolation_level": "READ COMMITTED"})


@contextmanager
def transaction(db: Session) -> Generator[None, None, None]:
    """Context manager for database transactions.

    Commits on success, rolls back on exception.

    Args:
        db: The database session to manage.

    Yields:
        None - operations should be performed on the db session.

    Raises:
        Re-raises any exception after rollback.

    Usage:
        with transaction(db):
            db.execute(...)
            db.execute(...)
        # Committed if no exception
    """
    try:
        yield
        db.commit()
    except Exception:
        db.rollback()
        raise
