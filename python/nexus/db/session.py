"""Database session management and transaction helpers.

Provides:
- Request-scoped database sessions via get_db() dependency
- Transaction context manager for mutations
"""

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from nexus.db.engine import get_engine


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


def get_db() -> Generator[Session, None, None]:
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
    try:
        yield db
    finally:
        db.close()


def release_connection(db: Session) -> None:
    """Return a request session's checked-out connection before response transfer.

    FastAPI yield-dependency cleanup runs after the response body is sent. For
    hot read routes with large JSON bodies, that can leave a PostgreSQL
    transaction idle while the ASGI server is blocked on client reads. Routes
    that have fully materialized their response can call this before returning.
    """
    if db.in_transaction():
        db.rollback()
    db.close()


def use_serializable_if_available(db: Session) -> None:
    bind = db.get_bind()
    in_outer_transaction = bool(getattr(bind, "in_transaction", lambda: False)())
    if not db.in_transaction() and not in_outer_transaction:
        db.connection(execution_options={"isolation_level": "SERIALIZABLE"})


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
