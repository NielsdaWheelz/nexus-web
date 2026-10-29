"""One HTTP search operation owns its absolute deadline and disconnect join.

Routes supply their existing phase allowance. Provider waits, admission and reads
share that deadline; cancellation joins the owner before an HTTP outcome returns.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import timedelta

from fastapi import Request
from sqlalchemy.exc import DBAPIError
from sqlalchemy.exc import TimeoutError as PoolTimeout

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.search.admission import SearchAdmissionBusy

logger = get_logger(__name__)


async def run_search_operation[T](
    request: Request,
    *,
    phase: str,
    allowance: timedelta,
    read: Callable[[float], Awaitable[T]],
) -> T:
    deadline = asyncio.get_running_loop().time() + allowance.total_seconds()
    budget = asyncio.timeout_at(deadline)
    logger.info(
        "search.budget.begin",
        phase=phase,
        budget_ms=allowance.total_seconds() * 1000,
        deadline_mono_ns=int(deadline * 1_000_000_000),
        mono_ns=time.monotonic_ns(),
    )

    async def operation() -> T:
        return await read(deadline)

    async def disconnected() -> None:
        while (await request.receive())["type"] != "http.disconnect":
            pass

    running = asyncio.create_task(operation())
    disconnect = asyncio.create_task(disconnected())
    try:
        try:
            async with budget:
                finished, _ = await asyncio.wait(
                    (running, disconnect), return_when=asyncio.FIRST_COMPLETED
                )
                if disconnect in finished:
                    disconnect.result()
                    logger.info("search.client_disconnected", mono_ns=time.monotonic_ns())
                    raise ApiError(ApiErrorCode.E_CLIENT_DISCONNECT, "Client disconnected")
                return running.result()
        except TimeoutError:
            if budget.expired():
                logger.info("search.timer_fired", mono_ns=time.monotonic_ns())
            raise
        except asyncio.CancelledError:
            logger.info(
                "search.operation.cancelled",
                budget_expired=budget.expired(),
                mono_ns=time.monotonic_ns(),
            )
            raise
        finally:
            logger.info(
                "search.cancel_join.begin",
                operation_pending=not running.done(),
                disconnect_pending=not disconnect.done(),
                mono_ns=time.monotonic_ns(),
            )
            for task in (running, disconnect):
                if not task.done():
                    task.cancel()
            joined = asyncio.gather(running, disconnect, return_exceptions=True)
            cancelled = False
            while not joined.done():
                try:
                    await asyncio.shield(joined)
                except asyncio.CancelledError:
                    cancelled = True
            joined.result()
            logger.info("search.cancel_join.end", mono_ns=time.monotonic_ns())
            if cancelled:
                raise asyncio.CancelledError()
    except SearchAdmissionBusy:
        raise ApiError(
            ApiErrorCode.E_DATABASE_BUSY, "nexus is busy. wait a moment, then retry."
        ) from None
    except PoolTimeout:
        raise ApiError(ApiErrorCode.E_APP_SEARCH_FAILED, "Search could not be completed") from None
    except TimeoutError:
        if not budget.expired() and asyncio.get_running_loop().time() < deadline:
            raise
        logger.info("search.budget.expired", mono_ns=time.monotonic_ns())
        raise ApiError(ApiErrorCode.E_SEARCH_TIMEOUT, "Search timed out") from None
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) != "57014":
            raise
        diagnostic = getattr(exc.orig, "diag", None)
        logger.info(
            "search.database.cancelled",
            sqlstate="57014",
            pg_message_primary=getattr(diagnostic, "message_primary", None),
            pg_severity=getattr(diagnostic, "severity_nonlocalized", None),
            mono_ns=time.monotonic_ns(),
        )
        if (
            getattr(diagnostic, "message_primary", None)
            == "canceling statement due to statement timeout"
            and asyncio.get_running_loop().time() >= deadline
        ):
            raise ApiError(ApiErrorCode.E_SEARCH_TIMEOUT, "Search timed out") from exc
        raise
    finally:
        logger.info("search.budget.end", mono_ns=time.monotonic_ns())
