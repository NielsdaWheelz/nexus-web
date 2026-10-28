"""One deadline-bound expensive read, through confirmed backend retirement.

The dedicated search connection owns the database-wide session advisory lock.
Admission rolls back before the caller starts its read-only snapshot. Retirement
closes local owners, invalidates that physical connection, then confirms its PID
is absent through short control transactions. No explicit unlock admits a second
read ahead of server cleanup. A failed confirmation never returns a read result.
A scope-owned search permit remains held through confirmation even if SQLAlchemy
returns its pool slot early. Confirmed retirement has no elapsed-time failure;
unconfirmed retirement withholds the permit. Cleanup preserves the primary failure.
"""

import asyncio
import math
import time
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Literal

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlalchemy.orm import Session

from nexus.db.engine import SearchDatabaseLease, get_search_async_engine, search_database_capacity
from nexus.db.session import open_control_async_session
from nexus.logging import get_logger

logger = get_logger(__name__)
_RETIREMENT_POLL_SECONDS = 0.005
BACKGROUND_COMPUTATION_SECONDS = 0.400
_RETIREMENT_CONFIRMATION_SECONDS = 10.0


class SearchAdmissionBusy(Exception):
    """Background admission refused without waiting behind another read."""


class SearchBudgetExpired(TimeoutError):
    """This operation's absolute computation deadline or its SQL backstop expired."""

    def __init__(self, phase: str = "read") -> None:
        super().__init__("Search computation deadline expired")
        self.phase = phase


def remaining_milliseconds(deadline: float) -> int:
    """An expired caller budget never starts another read."""
    remaining = math.ceil((deadline - asyncio.get_running_loop().time()) * 1000)
    if remaining <= 0:
        raise SearchBudgetExpired()
    return remaining


def _admit(db: Session, deadline: float, purpose: Literal["foreground", "background"]) -> None:
    db.execute(text("SET LOCAL lock_timeout = '0'"))
    db.execute(
        text("SELECT set_config('statement_timeout', :timeout, true)"),
        {"timeout": str(remaining_milliseconds(deadline))},
    )
    function = "pg_try_advisory_lock" if purpose == "background" else "pg_advisory_lock"
    granted = db.scalar(
        text(f"SELECT {function}(hashtextextended(:key, 0))"),
        {"key": "nexus:expensive-search"},
    )
    if purpose == "background" and not granted:
        raise SearchAdmissionBusy()
    db.rollback()  # the session lock survives; the admission snapshot does not
    remaining_milliseconds(deadline)


async def _retire(
    connection: AsyncConnection,
    database: AsyncSession | None,
    pid: int | None,
    lease: SearchDatabaseLease,
) -> None:
    try:
        if database is not None:
            await database.close()
    finally:
        try:
            await connection.invalidate()
        finally:
            await connection.close()
    if pid is None:
        # Checkout failed before an identified backend: local cleanup only.
        return
    deadline = asyncio.get_running_loop().time() + _RETIREMENT_CONFIRMATION_SECONDS
    try:
        while True:
            control = open_control_async_session()
            try:
                async with asyncio.timeout_at(deadline):
                    present = await control.scalar(
                        text("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=:pid)"),
                        {"pid": pid},
                    )
            finally:
                await control.close()  # each probe ends its activity snapshot
            if not present:
                lease.confirm_retired()
                logger.info(
                    "search.backend.retired",
                    backend_pid=pid,
                    mono_ns=time.monotonic_ns(),
                )
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError("Search backend retirement remains unconfirmed")
            await asyncio.sleep(_RETIREMENT_POLL_SECONDS)
    except BaseException:
        logger.error("search.retirement_unconfirmed", backend_pid=pid, mono_ns=time.monotonic_ns())
        raise


async def _join_retirement(task: asyncio.Task[None]) -> None:
    """Repeated cancellation cannot abandon the operation's local cleanup task."""
    cancelled: asyncio.CancelledError | None = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as error:
            if cancelled is None:
                cancelled = error
        except BaseException:
            break  # retrieve the joined task's failure without masking cancellation
    try:
        task.result()
    except BaseException as error:
        if cancelled is None:
            raise
        # justify-ignore-error: retain the joined cleanup failure on the primary cancellation.
        cancelled.add_note(f"Search retirement also failed: {type(error).__name__}: {error}")
        logger.error("search.retirement_cleanup_failed", error_type=type(error).__name__)
    if cancelled is not None:
        raise cancelled


@asynccontextmanager
async def search_session_async(
    *, deadline: float, purpose: Literal["foreground", "background"]
) -> AsyncIterator[AsyncSession]:
    """One owned checkout/admission/read deadline; cleanup is joined outside it."""
    loop = asyncio.get_running_loop()
    began = loop.time()
    if began >= deadline:
        raise SearchBudgetExpired("checkout")
    budget = asyncio.timeout_at(deadline)
    lease: SearchDatabaseLease | None = None
    connection = None
    database = None
    pid = None
    admission_began = None
    phase = "checkout"
    outcome = "failed"
    primary_error: BaseException | None = None
    logger.info(
        "search.connection.begin",
        purpose=purpose,
        deadline_mono_ns=int(deadline * 1e9),
        mono_ns=time.monotonic_ns(),
    )
    async with AsyncExitStack() as ownership:
        try:
            try:
                async with budget:
                    lease = await ownership.enter_async_context(
                        search_database_capacity(wait=purpose == "foreground")
                    )
                    if lease is None:
                        raise SearchAdmissionBusy()
                    connection = await get_search_async_engine().connect()
                    raw = await connection.get_raw_connection()
                    driver = raw.driver_connection
                    assert driver is not None  # the successful owned checkout is still open
                    pid = driver.info.backend_pid
                    lease.require_retirement()
                    logger.info(
                        "search.connection.end",
                        backend_pid=pid,
                        purpose=purpose,
                        checkout_ms=(loop.time() - began) * 1000,
                        mono_ns=time.monotonic_ns(),
                    )
                    database = AsyncSession(
                        bind=connection, autoflush=False, expire_on_commit=False
                    )
                    phase = "admission"
                    admission_began = loop.time()
                    logger.info(
                        "search.admission.begin",
                        backend_pid=pid,
                        purpose=purpose,
                        mono_ns=time.monotonic_ns(),
                    )
                    await database.run_sync(lambda db: _admit(db, deadline, purpose))
                    logger.info(
                        "search.admission.admitted",
                        backend_pid=pid,
                        purpose=purpose,
                        admission_ms=(loop.time() - admission_began) * 1000,
                        mono_ns=time.monotonic_ns(),
                    )
                    phase = "read"
                    yield database
                    remaining_milliseconds(deadline)
                    outcome = "complete"
            except SearchAdmissionBusy:
                outcome = "admission_busy"
                raise
            except SearchBudgetExpired as exc:
                outcome = "computation_budget"
                raise SearchBudgetExpired(phase) from exc
            except TimeoutError as exc:
                if budget.expired():
                    outcome = "computation_budget"
                    raise SearchBudgetExpired(phase) from exc
                raise
            except DBAPIError as exc:
                if (
                    getattr(exc.orig, "sqlstate", None) == "57014"
                    and getattr(getattr(exc.orig, "diag", None), "message_primary", None)
                    == "canceling statement due to statement timeout"
                    and loop.time() >= deadline
                ):
                    outcome = "computation_budget"
                    raise SearchBudgetExpired(phase) from exc
                raise
            except asyncio.CancelledError:
                outcome = "cancelled"
                raise
        except BaseException as error:
            primary_error = error
            raise
        finally:
            if connection is not None:
                assert lease is not None  # capacity was acquired before this owned checkout
                cleanup_began = loop.time()
                logger.info(
                    "search.connection_cleanup.begin",
                    backend_pid=pid,
                    purpose=purpose,
                    phase=phase,
                    outcome=outcome,
                    mono_ns=time.monotonic_ns(),
                )
                try:
                    await _join_retirement(
                        asyncio.create_task(_retire(connection, database, pid, lease))
                    )
                except asyncio.CancelledError as error:
                    outcome = "cancelled"
                    if isinstance(primary_error, asyncio.CancelledError):
                        if error is not primary_error:
                            for note in getattr(error, "__notes__", ()):
                                primary_error.add_note(note)
                        raise primary_error from None
                    if primary_error is not None:
                        error.add_note(
                            f"Search read also failed: {type(primary_error).__name__}: {primary_error}"
                        )
                    raise
                except BaseException as error:
                    outcome = "retirement_unconfirmed"
                    if primary_error is None:
                        raise
                    # justify-ignore-error: retain secondary cleanup failure; never mask the read.
                    primary_error.add_note(
                        f"Search retirement also failed: {type(error).__name__}: {error}"
                    )
                    logger.error(
                        "search.retirement_cleanup_failed",
                        backend_pid=pid,
                        error_type=type(error).__name__,
                        primary_error_type=type(primary_error).__name__,
                    )
                finally:
                    logger.info(
                        "search.connection_cleanup.end",
                        backend_pid=pid,
                        purpose=purpose,
                        phase=phase,
                        outcome=outcome,
                        cleanup_ms=(loop.time() - cleanup_began) * 1000,
                        hold_ms=None
                        if admission_began is None
                        else (loop.time() - admission_began) * 1000,
                        mono_ns=time.monotonic_ns(),
                    )
                if primary_error is None and outcome == "complete":
                    try:
                        remaining_milliseconds(deadline)
                    except SearchBudgetExpired as error:
                        raise SearchBudgetExpired(phase) from error
