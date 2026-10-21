"""Browser phases own one cancellable read, session and aggregate deadline.

The operation alone releases its session. Deadline or disconnect cancels and joins it;
provider waits and async PostgreSQL I/O share the phase budget without worker threads.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import open_async_session
from nexus.errors import ApiError, ApiErrorCode
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
_PHASE_CAPS = {
    "direct": timedelta(milliseconds=400),
    "lexical": timedelta(milliseconds=1000),
    "hybrid": timedelta(milliseconds=1800),
}


async def _run[T](
    request: Request,
    phase: PreviewPhase,
    read: Callable[[AsyncSession, float], Awaitable[T]],
) -> T:
    deadline = asyncio.get_running_loop().time() + _PHASE_CAPS[phase].total_seconds()
    budget = asyncio.timeout_at(deadline)

    async def operation() -> T:
        async with open_async_session() as database:
            return await read(database, deadline)

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
                    raise ApiError(ApiErrorCode.E_CLIENT_DISCONNECT, "Client disconnected")
                return running.result()
        finally:
            for task in (running, disconnect):
                if not task.done():
                    task.cancel()
            await asyncio.gather(running, disconnect, return_exceptions=True)
    except TimeoutError:
        if not budget.expired():
            raise
        raise ApiError(ApiErrorCode.E_SEARCH_TIMEOUT, "Search timed out") from None
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) != "57014":
            raise
        raise ApiError(ApiErrorCode.E_SEARCH_TIMEOUT, "Search timed out") from exc


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
        lambda database, deadline: discovery.search(
            database,
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
        lambda database, deadline: discovery.preview(
            database, viewer.user_id, query, phase=phase, deadline=deadline
        ),
    )
