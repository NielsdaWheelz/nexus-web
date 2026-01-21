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
