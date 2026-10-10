"""``GET /search``: parse the query params, run one search, return the page (not Data-wrapped)."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.schemas.search import SearchResponse
from nexus.services.search.query import DEFAULT_LIMIT, MAX_LIMIT, build_search_query, scope_from_uri
from nexus.services.search.service import search as search_service

router = APIRouter(tags=["search"])


def _csv(value: str | None) -> list[str] | None:
    return None if value is None else [item.strip() for item in value.split(",") if item.strip()]


@router.get("/search", response_model=SearchResponse, response_model_by_alias=True)
def search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
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
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Results per page"),
) -> SearchResponse:
    """Everything the viewer may read, ranked by one rule; 404 (never 403) for unreadable scopes."""
    query = build_search_query(
        text=q,
        raw_kinds=_csv(kinds),
        raw_formats=_csv(formats),
        raw_authors=_csv(authors),
        raw_roles=_csv(roles),
        scope=scope_from_uri(scope),
        cursor=cursor,
        limit=limit,
    )
    return search_service(db, viewer.user_id, query)
