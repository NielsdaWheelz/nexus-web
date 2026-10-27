"""Finite physical pools for one explicitly bound process role.

Sync construction is serialized even on concurrent first checkout. Async pools belong
only to the current async_database_scope and its loop: callers join owned work and
close sessions before scope exit disposes them. Search alone has no pool wait timer;
its caller's finite absolute deadline owns checkout, admission and retirement.
Connections disable prepared statements and JIT. Control has a short independent
statement deadline, never the worker's long domain-query allowance. Bound parameters
are hidden in SQLAlchemy exception rendering and logs.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from threading import Lock
from typing import Literal

from anyio import CancelScope
from sqlalchemy import Engine, create_engine
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from nexus.config import CONNECTION_CAPACITIES, DatabaseRole, get_settings

_role: DatabaseRole | None = None
_sync_engines: dict[bool, Engine] = {}
_sync_engine_lock = Lock()
_scope: _AsyncDatabaseScope | None = None


class _AsyncDatabaseScope:
    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.engines: dict[str, AsyncEngine] = {}


def bind_database_role(role: DatabaseRole) -> None:
    """Select a role before any engine; a process cannot switch topology later."""
    global _role
    with _sync_engine_lock:
        if role not in CONNECTION_CAPACITIES:
            raise ValueError("unknown database role")
        if _role is not None and _role != role:
            raise RuntimeError("database role is already bound")
        _role = role


def _allowance(kind: str) -> int:
    if _role is None:
        raise RuntimeError("bind a database role before using the database")
    count = getattr(CONNECTION_CAPACITIES[_role], kind)
    if count == 0:
        raise RuntimeError(f"database capability {kind} is disabled for {_role}")
    return count


def _connect_args(kind: str) -> dict[str, object]:
    settings = get_settings()
    control = kind.startswith("control")
    timeouts = (
        ("statement_timeout", 1000 if control else settings.database_statement_timeout_ms),
        ("lock_timeout", 1000 if control else 10_000),
        (
            "idle_in_transaction_session_timeout",
            1000 if control else settings.database_idle_in_tx_timeout_ms,
        ),
    )
    options = "-c jit=off " + " ".join(f"-c {key}={value}" for key, value in timeouts if value)
    return {
        "prepare_threshold": None,
        "options": options,
        "application_name": f"nexus:{_role}:{kind}",
    }


def _sync_engine(*, control: bool) -> Engine:
    kind = "control_sync" if control else "ordinary_sync"
    with _sync_engine_lock:
        count = _allowance(kind)
        if control not in _sync_engines:
            settings = get_settings()
            _sync_engines[control] = create_engine(
                settings.database_url,
                pool_size=count,
                max_overflow=0,
                pool_timeout=settings.database_pool_timeout_seconds,
                pool_pre_ping=True,
                hide_parameters=True,
                connect_args=_connect_args(kind),
            )
        return _sync_engines[control]


def get_engine() -> Engine:
    """The role's finite ordinary sync pool."""
    return _sync_engine(control=False)


def get_control_engine() -> Engine:
    """The role's finite short-transaction control sync pool."""
    return _sync_engine(control=True)


def require_async_database_scope() -> None:
    """Refuse async resources outside the single active owning loop."""
    if _scope is None or _scope.loop is not asyncio.get_running_loop():
        raise RuntimeError("async database access requires its owning loop scope")


def _async_engine(kind: Literal["ordinary_async", "control_async", "search_async"]) -> AsyncEngine:
    count = _allowance(kind)
    require_async_database_scope()
    scope = _scope
    assert scope is not None
    if kind not in scope.engines:
        scope.engines[kind] = create_async_engine(
            get_settings().database_url,
            pool_size=count,
            max_overflow=0,
            pool_timeout=None
            if kind == "search_async"
            else get_settings().database_pool_timeout_seconds,
            pool_pre_ping=True,
            hide_parameters=True,
            connect_args=_connect_args(kind),
        )
    return scope.engines[kind]


def get_async_engine() -> AsyncEngine:
    """The active scope's ordinary async pool."""
    return _async_engine("ordinary_async")


def get_control_async_engine() -> AsyncEngine:
    """The active scope's short-transaction control async pool."""
    return _async_engine("control_async")


def get_search_async_engine() -> AsyncEngine:
    """Dedicated to deadline-owned search admission; no ordinary consumers."""
    return _async_engine("search_async")


@asynccontextmanager
async def async_database_scope() -> AsyncIterator[None]:
    """Own one loop's pools. The caller closes sessions and joins its tasks first."""
    global _scope
    if _role is None:
        raise RuntimeError("bind a database role before opening its async scope")
    with _sync_engine_lock:
        if _scope is not None:
            raise RuntimeError("an async database scope is already active")
        scope = _AsyncDatabaseScope()
        _scope = scope
    try:
        yield
    finally:
        try:
            with CancelScope(shield=True):
                from nexus.db.listen import close_listeners

                async with AsyncExitStack() as cleanup:
                    for engine in scope.engines.values():
                        cleanup.push_async_callback(engine.dispose)
                    cleanup.push_async_callback(close_listeners)
        finally:
            _scope = None
