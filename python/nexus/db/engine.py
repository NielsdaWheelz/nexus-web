"""SQLAlchemy engine creation and configuration.

The engine is created once at application startup and provides
connection pooling for all database operations.
"""

from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from nexus.config import get_settings

DEFAULT_DATABASE_POOL_SIZE = 10
DEFAULT_DATABASE_MAX_OVERFLOW = 10
DEFAULT_DATABASE_POOL_TIMEOUT_SECONDS = 30.0


def create_db_engine(
    database_url: str | None = None,
    *,
    pool_size: int | None = None,
    max_overflow: int | None = None,
    pool_timeout_seconds: float | None = None,
) -> Engine:
    """Create a SQLAlchemy engine with the given URL.

    Args:
        database_url: PostgreSQL connection string. If None, uses settings.

    Returns:
        Configured SQLAlchemy engine.

    Note:
        Uses psycopg (v3) driver. Connection string format:
        postgresql+psycopg://user:password@host:port/database
    """
    if database_url is None:
        settings = get_settings()
        database_url = settings.database_url
        pool_size = settings.database_pool_size if pool_size is None else pool_size
        max_overflow = settings.database_max_overflow if max_overflow is None else max_overflow
        pool_timeout_seconds = (
            settings.database_pool_timeout_seconds
            if pool_timeout_seconds is None
            else pool_timeout_seconds
        )

    return create_engine(
        database_url,
        pool_size=pool_size or DEFAULT_DATABASE_POOL_SIZE,
        max_overflow=DEFAULT_DATABASE_MAX_OVERFLOW if max_overflow is None else max_overflow,
        pool_timeout=pool_timeout_seconds or DEFAULT_DATABASE_POOL_TIMEOUT_SECONDS,
        pool_pre_ping=True,
        echo=False,
        # Disable psycopg3 server-side prepared statements — they are
        # per-connection state and break under transaction-pooling proxies
        # (Supavisor / PgBouncer) which may route successive transactions
        # to different backend connections.
        connect_args={"prepare_threshold": None},
    )


@lru_cache
def get_engine() -> Engine:
    """Get the cached database engine.

    Returns:
        The application's SQLAlchemy engine instance.
    """
    return create_db_engine()
