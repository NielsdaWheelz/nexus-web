"""The search route: parse query params, call one service function, dump."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.query_params import parse_comma_list
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.schemas.search import SearchResponse
from nexus.services.search.query import DEFAULT_LIMIT, MAX_LIMIT, build_search_query
from nexus.services.search.scope import scope_from_uri
from nexus.services.search.service import search as search_service

router = APIRouter(tags=["search"])


@router.get("/search", response_model=SearchResponse, response_model_by_alias=True)
def search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(default="", min_length=0, description="Search query string"),
    scope: str = Query(
        default="all", description="Search scope (all, media:<id>, library:<id>, conversation:<id>)"
    ),
    kinds: str | None = Query(
        default=None,
        description=(
            "Comma-separated user kinds (documents, notes, highlights, conversations, "
            "people, web). Omitted ⇒ all kinds; explicitly empty ⇒ no results."
        ),
    ),
    formats: str | None = Query(
        default=None,
        description="Comma-separated document formats (article, pdf, epub, video, episode, podcast).",
    ),
    authors: str | None = Query(
        default=None, description="Comma-separated contributor handles to filter credited content."
    ),
    roles: str | None = Query(
        default=None, description="Comma-separated contributor credit roles to filter content."
    ),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(
        default=DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=f"Maximum results per page (default {DEFAULT_LIMIT}, max {MAX_LIMIT})",
    ),
) -> dict:
    """Hybrid search (full text ∪ vector ANN) across everything the viewer may see.

    Returns 404 for a scope the viewer cannot read — never 403, so existence
    does not leak — and 200 with no results when there is neither a usable
    full-text query nor a structured filter.
    """
    query = build_search_query(
        text=q,
        raw_kinds=parse_comma_list(kinds),
        raw_formats=parse_comma_list(formats),
        raw_authors=parse_comma_list(authors),
        raw_roles=parse_comma_list(roles),
        scope=scope_from_uri(scope),
        cursor=cursor,
        limit=limit,
    )
    return search_service(db=db, viewer_id=viewer.user_id, query=query).model_dump(
        mode="json", by_alias=True
    )
