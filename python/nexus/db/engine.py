"""Finite physical pools for one explicitly bound process role.

Sync construction is serialized even on concurrent first checkout. Async pools belong
only to the current async_database_scope and its loop: callers join owned work and
close sessions before scope exit disposes them. Search alone has no pool wait timer;
its caller's finite absolute deadline owns checkout, admission and retirement.
A scope-owned search lease also retains that same capacity until known backend
retirement: SQLAlchemy invalidation itself returns a pool record too early.
Unconfirmed known retirement fails search closed for this scope and requires live
runtime repair. Ordinary/control sessions have no lifetime semaphore.
Ordinary checkout uses the configured finite wait (five seconds by default);
control checkout keeps its independent 250 ms wait. These are operational queue
safeguards, not successful latency targets.
Native connection setup uses a two-second timeout per resolved address for the
single local Postgres endpoint, separately from pool queue waits and SQL limits.
Async callers retain their original aggregate deadline; this is not a total
checkout or DNS-resolution deadline.
Connections disable prepared statements and JIT. Control has a short independent
statement deadline, never the worker's long domain-query allowance. Bound parameters
are hidden in SQLAlchemy exception rendering and logs.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from importlib import import_module
from threading import Lock
from typing import Literal

from anyio import CancelScope
from sqlalchemy import Engine, create_engine
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from nexus.config import CONNECTION_CAPACITIES, DatabaseRole, get_settings

_CONTROL_POOL_TIMEOUT_SECONDS = 0.25
_CONNECT_TIMEOUT_SECONDS = 2
_role: DatabaseRole | None = None
_sync_engines: dict[bool, Engine] = {}
_sync_engine_lock = Lock()
_scope: _AsyncDatabaseScope | None = None


class _AsyncDatabaseScope:
    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.engines: dict[str, AsyncEngine] = {}
        self.search_capacity: asyncio.BoundedSemaphore | None = None
        self.search_failed = False


class SearchDatabaseLease:
    """One search capacity owner; only actual backend absence confirms retirement."""

    def __init__(self) -> None:
        self._retirement_required = False
        self._retired = False

    def require_retirement(self) -> None:
        """The gate has acquired a connection with an identified server PID."""
        self._retirement_required = True

    def confirm_retired(self) -> None:
        """The gate observed that PID absent; its search capacity may be released."""
        self._retired = True


@asynccontextmanager
async def search_database_capacity(*, wait: bool) -> AsyncIterator[SearchDatabaseLease | None]:
    """Hold source-owned search capacity beyond pool invalidation through retirement.

    Acquisition belongs inside the gate's original absolute deadline. A canceled
    checkout that never returned an identified connection releases after local join;
    this boundary does not claim positive startup-backend retirement evidence.
    Known-unconfirmed retirement withholds its slot and refuses future checkouts.
    Already-waiting callers keep their original deadline, without a wakeup registry.
    A nonwaiting caller observes contention, including queued waiters, as absence.
    """
    require_async_database_scope()
    scope = _scope
    assert scope is not None
    count = _allowance("search_async")
    if scope.search_failed:
        raise RuntimeError("search retirement unconfirmed; runtime repair required")
    if scope.search_capacity is None:
        scope.search_capacity = asyncio.BoundedSemaphore(count)
    if not wait and scope.search_capacity.locked():
        yield None
        return
    await scope.search_capacity.acquire()
    lease = SearchDatabaseLease()
    try:
        if scope.search_failed:
            raise RuntimeError("search retirement unconfirmed; runtime repair required")
        yield lease
    finally:
        if lease._retirement_required and not lease._retired:
            scope.search_failed = True
        else:
            scope.search_capacity.release()


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
        "connect_timeout": _CONNECT_TIMEOUT_SECONDS,
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
                pool_timeout=(
                    _CONTROL_POOL_TIMEOUT_SECONDS
                    if control
                    else settings.database_pool_timeout_seconds
                ),
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
            else _CONTROL_POOL_TIMEOUT_SECONDS
            if kind == "control_async"
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
    # Driver import is CPU-only scope setup; engines and physical checkout stay lazy.
    import_module("psycopg")
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
