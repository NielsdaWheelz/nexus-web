"""Browser phases own one cancellable read, session and aggregate deadline.

The operation alone releases its session. Deadline or disconnect cancels and joins it;
provider waits and async PostgreSQL I/O share the phase budget without worker threads.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.exc import DBAPIError

from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.search import (
    PreviewPhase,
    SearchPhase,
    SearchPreviewResponse,
    SearchResponse,
    SearchView,
)
from nexus.services.search import discovery
from nexus.services.search.query import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DiscoveryQuery,
    build_discovery_query,
    scope_from_uri,
)

router = APIRouter(tags=["search"])
logger = get_logger(__name__)
_PHASE_CAPS = {
    "direct": timedelta(milliseconds=400),
    "lexical": timedelta(milliseconds=1500),
    "hybrid": timedelta(milliseconds=5000),
}


async def _run[T](
    request: Request,
    phase: PreviewPhase,
    read: Callable[[float], Awaitable[T]],
) -> T:
    deadline = asyncio.get_running_loop().time() + _PHASE_CAPS[phase].total_seconds()
    budget = asyncio.timeout_at(deadline)
    logger.info(
        "search.budget.begin",
        phase=phase,
        budget_ms=_PHASE_CAPS[phase].total_seconds() * 1000,
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
            await asyncio.gather(running, disconnect, return_exceptions=True)
            logger.info("search.cancel_join.end", mono_ns=time.monotonic_ns())
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
        raise ApiError(ApiErrorCode.E_SEARCH_TIMEOUT, "Search timed out") from exc
    finally:
        logger.info("search.budget.end", mono_ns=time.monotonic_ns())


def _csv(value: str | None) -> list[str] | None:
    return None if value is None else [item.strip() for item in value.split(",") if item.strip()]


def _query(
    q: str = Query(default="", description="Search query string"),
    scope: str = Query(
        default="all", description="all, media:<id>, library:<id> or conversation:<id>"
    ),
    kinds: str | None = Query(
        default=None, description="Comma-separated kinds; omitted means all, empty means none"
    ),
    formats: str | None = Query(default=None, description="Comma-separated document formats"),
    authors: str | None = Query(default=None, description="Comma-separated contributor handles"),
    roles: str | None = Query(default=None, description="Comma-separated contributor credit roles"),
) -> DiscoveryQuery:
    return build_discovery_query(
        text=q,
        raw_kinds=_csv(kinds),
        raw_formats=_csv(formats),
        raw_authors=_csv(authors),
        raw_roles=_csv(roles),
        scope=scope_from_uri(scope),
    )


@router.get("/search")
async def search(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    query: Annotated[DiscoveryQuery, Depends(_query)],
    phase: SearchPhase,
    view: SearchView = "resources",
    cursor: str | None = None,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> SearchResponse:
    return await _run(
        request,
        phase,
        lambda deadline: discovery.search(
            viewer.user_id,
            query,
            phase=phase,
            deadline=deadline,
            view=view,
            cursor=cursor,
            limit=limit,
        ),
    )


@router.get("/search/preview")
async def search_preview(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    query: Annotated[DiscoveryQuery, Depends(_query)],
    phase: PreviewPhase,
) -> SearchPreviewResponse:
    return await _run(
        request,
        phase,
        lambda deadline: discovery.preview(viewer.user_id, query, phase=phase, deadline=deadline),
    )
