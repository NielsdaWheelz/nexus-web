"""Search routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Parse query params → SearchQuery at the boundary
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.

This endpoint implements hybrid search across all user-visible content using
PostgreSQL full-text search plus vector ANN. Visibility follows canonical predicates.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from nexus.api.query_params import parse_comma_list
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.search import SearchResponse
from nexus.services.search import search as search_service
from nexus.services.search.constants import DEFAULT_LIMIT, MAX_LIMIT
from nexus.services.search.query import build_search_query
from nexus.services.search.scope import scope_from_uri

router = APIRouter(tags=["search"])

# Params removed by the search intent-model cutover. Stale links carrying any of
# these must fail loud (400) rather than silently broaden to an all-kinds search.
_DELETED_SEARCH_PARAMS = (
    "types",
    "content_kinds",
    "contributor_handles",
    "semantic",
    "result_types",
    "storage_kinds",
    "planned_types",
    "planned_filters",
)


@router.get("/search", response_model=SearchResponse, response_model_by_alias=False)
def search(
    request: Request,
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
        default=None,
        description="Comma-separated contributor handles to filter credited content.",
    ),
    roles: str | None = Query(
        default=None,
        description="Comma-separated contributor credit roles to filter credited content.",
    ),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(
        default=DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=f"Maximum results per page (default {DEFAULT_LIMIT}, max {MAX_LIMIT})",
    ),
) -> dict:
    """Search across all visible content.

    Hybrid retrieval (full-text ∪ vector ANN) across documents, notes, highlights,
    conversations, people, and web results. Refinement is by kind, format, author,
    and role filters; retrieval mode is never user-controlled.

    **Scopes:**
    - `all` - All visible content
    - `media:<id>` - Content anchored to specific media
    - `library:<id>` - Content anchored to media in that library
    - `conversation:<id>` - Messages within that conversation

    Returns 400 for removed legacy params (`types`, `content_kinds`,
    `contributor_handles`, `semantic`, `result_types`, `storage_kinds`), 404 for
    unauthorized scope (prevents existence leakage), and 200 with empty results
    when there is neither a usable full-text query nor a structured filter.
    """
    present_deleted = [param for param in _DELETED_SEARCH_PARAMS if param in request.query_params]
    if present_deleted:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Unsupported search params: {', '.join(present_deleted)}. "
            "Use kinds/formats/authors/roles.",
        )

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
    result = search_service(db=db, viewer_id=viewer.user_id, query=query)
    return result.model_dump(mode="json")
