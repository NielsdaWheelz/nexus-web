"""Scoped async sessions over the process-owned PostgreSQL engine identity.

The worker and MCP listener have different event loops. NullPool keeps their
connections scoped to the invocation instead of moving pooled async connections
between loops. Sync domain functions run only through AsyncSession.run_sync;
its greenlet bridge awaits psycopg I/O on the owning loop without threads.
"""

from collections.abc import Mapping
from threading import Lock
from weakref import WeakKeyDictionary

from sqlalchemy import Engine
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

_engines: WeakKeyDictionary[Engine, AsyncEngine] = WeakKeyDictionary()
_engine_lock = Lock()


def open_async_session(factory: sessionmaker[Session]) -> AsyncSession:
    """Open one independently owned session at a committed operation boundary."""

    bind = factory.kw.get("bind")
    if not isinstance(bind, Engine) or bind.url.drivername != "postgresql+psycopg":
        raise TypeError("async operation requires a PostgreSQL psycopg Engine")
    options = bind.get_execution_options()
    connect_args = options.get("nexus_connect_args")
    if not isinstance(connect_args, Mapping):
        raise TypeError("async operation requires a Nexus-configured Engine")
    with _engine_lock:
        engine = _engines.get(bind)
        if engine is None:
            engine = create_async_engine(
                bind.url,
                poolclass=NullPool,
                connect_args=dict(connect_args),
                execution_options=options,
            )
            _engines[bind] = engine
    return AsyncSession(engine, autoflush=False, expire_on_commit=False)
