"""SQLAlchemy engine creation and configuration.

The engine is created once at application startup and provides
connection pooling for all database operations.
"""

from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from nexus.config import get_settings


def create_db_engine(database_url: str | None = None) -> Engine:
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

    return create_engine(
        database_url,
        pool_pre_ping=True,
        echo=False,
    )


@lru_cache
def get_engine() -> Engine:
    """Get the cached database engine.

    Returns:
        The application's SQLAlchemy engine instance.
    """
    return create_db_engine()
