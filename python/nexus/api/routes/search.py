"""Browser phases own one cancellable read, session and aggregate deadline.

The operation alone releases its session. Deadline or disconnect cancels and joins it;
provider waits and async PostgreSQL I/O share the phase budget without worker threads.
"""

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from nexus.api.search_operation import run_search_operation
from nexus.auth.middleware import Viewer, get_viewer
from nexus.schemas.search import (
    PreviewPhase,
    SearchPhase,
    SearchPreviewResponse,
    SearchResponse,
    SearchView,
)
from nexus.services.search import discovery
from nexus.services.search.policy import FOREGROUND_SEARCH_SECONDS
from nexus.services.search.query import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DiscoveryQuery,
    build_discovery_query,
    scope_from_uri,
)

router = APIRouter(tags=["search"])
_PHASE_CAPS = {
    "direct": timedelta(seconds=5),
    "lexical": timedelta(seconds=FOREGROUND_SEARCH_SECONDS),
    "hybrid": timedelta(seconds=FOREGROUND_SEARCH_SECONDS),
}


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
    return await run_search_operation(
        request,
        phase=phase,
        allowance=_PHASE_CAPS[phase],
        read=lambda deadline: discovery.search(
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
    return await run_search_operation(
        request,
        phase=phase,
        allowance=_PHASE_CAPS[phase],
        read=lambda deadline: discovery.preview(
            viewer.user_id, query, phase=phase, deadline=deadline
        ),
    )
