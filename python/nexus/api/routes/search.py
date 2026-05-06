"""Search routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.

This endpoint implements keyword search across all user-visible content
using PostgreSQL full-text search. Visibility follows s4 canonical predicates.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.schemas.search import SearchResponse
from nexus.services import search as search_service

router = APIRouter()


@router.get("/search", response_model=SearchResponse, response_model_by_alias=False)
def search(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(default="", min_length=0, description="Search query string"),
    scope: str = Query(
        default="all", description="Search scope (all, media:<id>, library:<id>, conversation:<id>)"
    ),
    types: str | None = Query(
        default=None,
        description=(
            "Comma-separated list of types to search "
            "(media, podcast, content_chunk, contributor, page, note_block, message)"
        ),
    ),
    contributor_handles: str | None = Query(
        default=None,
        description="Comma-separated contributor handles to filter credited content.",
    ),
    roles: str | None = Query(
        default=None,
        description="Comma-separated contributor credit roles to filter credited content.",
    ),
    content_kinds: str | None = Query(
        default=None,
        description="Comma-separated media/content kinds to filter credited content.",
    ),
    semantic: bool = Query(
        default=True,
        description="Enable hybrid semantic ranking for searchable content.",
    ),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(
        default=20, ge=1, le=50, description="Maximum results per page (default 20, max 50)"
    ),
) -> dict:
    """Search across all visible content.

    Keyword search using PostgreSQL full-text search. Returns mixed typed
    results from media titles, podcast metadata, content chunks, notes,
    and messages.

    **Scopes:**
    - `all` - All visible content
    - `media:<id>` - Content anchored to specific media
    - `library:<id>` - Content anchored to media in that library
    - `conversation:<id>` - Messages within that conversation

    **Types:**
    - `media` - Search media titles
    - `podcast` - Search visible podcast metadata
    - `content_chunk` - Search indexed document and transcript chunks
    - `page` - Search note pages
    - `note_block` - Search note blocks
    - `message` - Search conversation messages

    **Visibility:**
    - Search never returns invisible content
    - Media/content chunks visible via s4 provenance (non-default membership, intrinsic, closure)
    - Notes visible when owned by the viewer
    - Messages visible via conversation visibility (owner, public, or library-shared dual membership)
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
    if types is not None:
        type_list = [t.strip() for t in types.split(",") if t.strip()]

    contributor_handle_list = None
    if contributor_handles is not None:
        contributor_handle_list = [
            handle.strip() for handle in contributor_handles.split(",") if handle.strip()
        ]

    role_list = None
    if roles is not None:
        role_list = [role.strip() for role in roles.split(",") if role.strip()]

    content_kind_list = None
    if content_kinds is not None:
        content_kind_list = [
            content_kind.strip()
            for content_kind in content_kinds.split(",")
            if content_kind.strip()
        ]

    result = search_service.search(
        db=db,
        viewer_id=viewer.user_id,
        q=q,
        scope=scope,
        types=type_list,
        contributor_handles=contributor_handle_list,
        roles=role_list,
        content_kinds=content_kind_list,
        semantic=semantic,
        cursor=cursor,
        limit=limit,
    )
    return result.model_dump(mode="json")
