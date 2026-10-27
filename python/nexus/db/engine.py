"""The process's database engines, both over psycopg 3.

Every connection runs without server-side prepared statements (a transaction-pooling proxy may
route successive transactions to different backends) and with the role's timeouts: statement
and idle-in-transaction from settings (0 omits one), and a lock wait of at most 10 s.
JIT is disabled: expanded visibility plans can spend seconds compiling millisecond
reads. This favors interactive operations over possible compilation gains in longer
worker ranking queries, whose execution cost remains workload-specific.
"""

from functools import lru_cache
from threading import Lock

from sqlalchemy import Engine, create_engine
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from nexus.config import get_settings

_sync_engine: Engine | None = None
_sync_engine_lock = Lock()


def _connect_args() -> dict[str, object]:
    settings = get_settings()
    timeouts = (
        ("statement_timeout", settings.database_statement_timeout_ms),
        ("lock_timeout", 10_000),
        ("idle_in_transaction_session_timeout", settings.database_idle_in_tx_timeout_ms),
    )
    options = "-c jit=off " + " ".join(f"-c {key}={value}" for key, value in timeouts if value)
    return {"prepare_threshold": None, "options": options}


def get_engine() -> Engine:
    """One lazily constructed pool, including concurrent first checkouts."""
    global _sync_engine
    with _sync_engine_lock:
        if _sync_engine is None:
            settings = get_settings()
            _sync_engine = create_engine(
                settings.database_url,
                pool_size=settings.database_pool_size,
                max_overflow=settings.database_max_overflow,
                pool_timeout=settings.database_pool_timeout_seconds,
                pool_pre_ping=True,
                connect_args=_connect_args(),
            )
        return _sync_engine


@lru_cache
def get_async_engine() -> AsyncEngine:
    """The unpooled engine under async sessions: a pooled connection must not cross event loops."""
    settings = get_settings()
    return create_async_engine(
        settings.database_url, poolclass=NullPool, connect_args=_connect_args()
    )
