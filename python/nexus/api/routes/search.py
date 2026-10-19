"""Browser search routes: shared filters, fixed previews and discriminated result pages."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.schemas.search import PreviewPhase, SearchPreviewResponse, SearchResponse, SearchView
from nexus.services.search import discovery
from nexus.services.search.query import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DiscoveryQuery,
    build_discovery_query,
    scope_from_uri,
)

router = APIRouter(tags=["search"])


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
def search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    query: Annotated[DiscoveryQuery, Depends(_query)],
    view: SearchView = "resources",
    cursor: str | None = None,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> SearchResponse:
    return discovery.search(db, viewer.user_id, query, view=view, cursor=cursor, limit=limit)


@router.get("/search/preview")
def search_preview(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    query: Annotated[DiscoveryQuery, Depends(_query)],
    phase: PreviewPhase,
) -> SearchPreviewResponse:
    return discovery.preview(db, viewer.user_id, query, phase=phase)
