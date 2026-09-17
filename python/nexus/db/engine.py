"""SQLAlchemy engine creation and configuration.

The engine is created once at application startup and provides
connection pooling for all database operations.
"""

from functools import lru_cache
from types import MappingProxyType

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from nexus.config import get_settings


@lru_cache
def get_engine() -> Engine:
    """The application's SQLAlchemy engine, over the psycopg (v3) driver."""

    settings = get_settings()
    # Disable psycopg3 server-side prepared statements — they are
    # per-connection state and break under transaction-pooling proxies
    # (Supavisor / PgBouncer) which may route successive transactions
    # to different backend connections.
    connect_args: dict[str, object] = {"prepare_threshold": None}

    # Role-scoped DB timeouts (API defaults; worker relaxes them via env).
    # 0 disables a timeout, so emit only the nonzero ones.
    timeout_opts = [
        f"-c {key}={value}"
        for key, value in (
            ("statement_timeout", settings.database_statement_timeout_ms),
            ("lock_timeout", settings.database_lock_timeout_ms),
            ("idle_in_transaction_session_timeout", settings.database_idle_in_tx_timeout_ms),
        )
        if value
    ]
    if timeout_opts:
        connect_args["options"] = " ".join(timeout_opts)

    return create_engine(
        settings.database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
        pool_timeout=settings.database_pool_timeout_seconds,
        pool_pre_ping=True,
        echo=False,
        connect_args=connect_args,
    ).execution_options(nexus_connect_args=MappingProxyType(connect_args))
