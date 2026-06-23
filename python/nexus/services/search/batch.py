"""Multi-scope search execution (spec §5.6).

Owns the per-scope loop, union, dedupe by ``(result_type, id)`` keeping the max
score, sort, and cap — the search-domain capability the chat app_search tool
consumes. Moved out of ``agent_tools.app_search`` so chat keeps only its domain
concerns (conversation-ref resolution + empty-status).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.schemas.search import SearchPageInfo, SearchResponse, SearchResultOut
from nexus.services.search.constants import MAX_LIMIT
from nexus.services.search.query import SearchQuery, SearchScope
from nexus.services.search.service import search


def search_scopes(
    db: Session,
    viewer_id: UUID,
    base: SearchQuery,
    scopes: Sequence[SearchScope],
) -> SearchResponse:
    """Run ``base`` against each scope; union, dedupe by (type, id) keeping max score."""
    limit = min(max(1, base.limit), MAX_LIMIT)
    merged: dict[tuple[str, str], SearchResultOut] = {}
    for scope in scopes:
        response = search(db, viewer_id, replace(base, scope=scope))
        for result in response.results:
            key = (result.type, str(result.id))
            existing = merged.get(key)
            if existing is None or result.score > existing.score:
                merged[key] = result
    ordered = sorted(merged.values(), key=lambda result: (-result.score, str(result.id)))
    return SearchResponse(results=ordered[:limit], page=SearchPageInfo())
