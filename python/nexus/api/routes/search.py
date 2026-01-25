"""Search routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.

This endpoint implements keyword search across all user-visible content
using PostgreSQL full-text search as specified in PR-06.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.services import search as search_service

router = APIRouter()


@router.get("/search")
def search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(..., min_length=1, description="Search query string"),
    scope: str = Query(
        default="all", description="Search scope (all, media:<id>, library:<id>, conversation:<id>)"
    ),
    types: str | None = Query(
        default=None,
        description="Comma-separated list of types to search (media, fragment, annotation, message)",
    ),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(
        default=20, ge=1, le=50, description="Maximum results per page (default 20, max 50)"
    ),
) -> dict:
    """Search across all visible content.

    Keyword search using PostgreSQL full-text search. Returns mixed typed
    results from media titles, fragment text, annotations, and messages.

    **Scopes:**
    - `all` - All visible content
    - `media:<id>` - Content anchored to specific media
    - `library:<id>` - Content anchored to media in that library
    - `conversation:<id>` - Messages within that conversation

    **Types:**
    - `media` - Search media titles
    - `fragment` - Search document fragments
    - `annotation` - Search user annotations
    - `message` - Search conversation messages

    **Visibility:**
    - Search never returns invisible content
    - Media/fragments visible via library membership
    - Annotations are owner-only in S3
    - Messages visible via conversation ownership/sharing
    - Pending messages are never searchable

    **Query Parsing:**
    - Uses `websearch_to_tsquery` for natural query syntax
    - Supports quoted phrases, `-` exclusions, implicit AND
    - Queries < 2 chars return empty results
    - All-stopword queries return empty results

    **Pagination:**
    - Offset-based cursor encoded as base64url JSON
    - Page size configurable (default 20, max 50)

    Returns 404 for unauthorized scope (prevents existence leakage).
    Returns 200 with empty results for short or all-stopword queries.
    """
    # Parse types from comma-separated string
    type_list = None
    if types:
        type_list = [t.strip() for t in types.split(",") if t.strip()]

    result = search_service.search(
        db=db,
        viewer_id=viewer.user_id,
        q=q,
        scope=scope,
        types=type_list,
        cursor=cursor,
        limit=limit,
    )

    # Return response with results and page info
    return {
        "results": [r.model_dump(mode="json") for r in result.results],
        "page": result.page.model_dump(mode="json"),
    }
