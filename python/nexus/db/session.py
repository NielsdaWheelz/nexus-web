"""Database session management and transaction helpers.

Provides:
- Request-scoped database sessions via get_db() dependency
- Transaction context manager for mutations
"""

from collections.abc import Generator
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.engine import get_engine

REQUEST_DB_SESSIONS_STATE_KEY = "_nexus_request_db_sessions"


def create_session_factory(engine: Any = None) -> sessionmaker[Session]:
    """Create a session factory bound to an engine.

    Args:
        engine: SQLAlchemy engine. If None, uses the default engine.

    Returns:
        Configured sessionmaker instance.
    """
    if engine is None:
        engine = get_engine()

    return sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


# Default session factory - created lazily
_SessionLocal: sessionmaker[Session] | None = None


def get_session_factory() -> sessionmaker[Session]:
    """Get or create the default session factory."""
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = create_session_factory()
    return _SessionLocal


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

    bind = db.get_bind()
    in_outer_transaction = bool(getattr(bind, "in_transaction", lambda: False)())
    if db.in_transaction() or in_outer_transaction:
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


def release_connection(db: Session) -> None:
    """Return a request session's checked-out connection before response transfer."""
    if db.in_transaction():
        db.rollback()
    db.close()


def release_tracked_request_db_sessions(scope_state: Any) -> None:
    """Release all DB sessions tracked for one ASGI request scope."""
    if not isinstance(scope_state, dict):
        return

    sessions = scope_state.get(REQUEST_DB_SESSIONS_STATE_KEY)
    if not sessions:
        return

    scope_state[REQUEST_DB_SESSIONS_STATE_KEY] = []
    for db in sessions:
        release_connection(db)


def use_serializable_if_available(db: Session) -> None:
    bind = db.get_bind()
    in_outer_transaction = bool(getattr(bind, "in_transaction", lambda: False)())
    if not db.in_transaction() and not in_outer_transaction:
        db.connection(execution_options={"isolation_level": "SERIALIZABLE"})


def use_read_committed_if_available(db: Session) -> None:
    """Select READ COMMITTED before an attempt opens its transaction."""
    bind = db.get_bind()
    in_outer_transaction = bool(getattr(bind, "in_transaction", lambda: False)())
    if not db.in_transaction() and not in_outer_transaction:
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
