"""Database session management and transaction helpers.

Provides:
- Request-scoped database sessions via get_db() dependency
- Transaction context manager for mutations
"""

from collections.abc import Generator
from contextlib import contextmanager
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.engine import get_engine

REQUEST_DB_SESSIONS_STATE_KEY = "_nexus_request_db_sessions"


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


def get_db(request: Request) -> Generator[Session, None, None]:
    """FastAPI dependency that provides a database session.

    Yields:
        A database session that is automatically closed after use.

    Usage:
        @app.get("/endpoint")
        def endpoint(db: Session = Depends(get_db)):
            ...
    """
    SessionLocal = get_session_factory()
    db = SessionLocal()
    track_request_db_session(request, db)
    try:
        yield db
    finally:
        db.close()


def get_repeatable_read_db(
    db: Annotated[Session, Depends(get_db)],
) -> Session:
    """Start one strict read-only snapshot on a fresh request session."""

    if db.in_transaction():
        raise RuntimeError("repeatable-read dependency requires a fresh session")
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    return db


def track_request_db_session(request: Request, db: Session) -> None:
    """Track a request-scoped session for response-start connection release."""
    sessions = getattr(request.state, REQUEST_DB_SESSIONS_STATE_KEY, None)
    if sessions is None:
        sessions = []
        setattr(request.state, REQUEST_DB_SESSIONS_STATE_KEY, sessions)
    sessions.append(db)


def release_tracked_request_db_sessions(scope_state: dict[str, Any]) -> None:
    """Release all DB sessions tracked for one ASGI request scope."""
    sessions = scope_state.get(REQUEST_DB_SESSIONS_STATE_KEY)
    if not sessions:
        return

    scope_state[REQUEST_DB_SESSIONS_STATE_KEY] = []
    for db in sessions:
        if db.in_transaction():
            db.rollback()
        db.close()


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
