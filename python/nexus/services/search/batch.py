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

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from nexus.schemas.search import SearchPageInfo, SearchResponse, SearchResultOut
from nexus.services.search.embedding import (
    SEMANTIC_RESULT_TYPES,
    PreparedSearchEmbedding,
    _query_has_full_text_terms,
    prepare_search_embedding,
)
from nexus.services.search.query import SearchQuery, SearchScope
from nexus.services.search.scope import authorize_scope
from nexus.services.search.service import MIN_QUERY_LENGTH, search


def search_scopes(
    db: Session,
    viewer_id: UUID,
    base: SearchQuery,
    scopes: Sequence[SearchScope],
    *,
    prepared_embedding: PreparedSearchEmbedding | None = None,
) -> SearchResponse:
    """Run ``base`` against each scope; union, dedupe by (type, id) keeping max score."""
    merged: dict[tuple[str, str], SearchResultOut] = {}
    for scope in scopes:
        response = search(
            db, viewer_id, replace(base, scope=scope), prepared_embedding=prepared_embedding
        )
        for result in response.results:
            key = (result.type, str(result.id))
            existing = merged.get(key)
            if existing is None or result.score > existing.score:
                merged[key] = result
    ordered = sorted(merged.values(), key=lambda result: (-result.score, str(result.id)))
    return SearchResponse(results=ordered[: base.limit], page=SearchPageInfo())


async def search_scopes_async(
    database: AsyncSession,
    viewer_id: UUID,
    base: SearchQuery,
    scopes: Sequence[SearchScope],
) -> SearchResponse:
    """Prepare external query data once, then perform the same authorized retrieval.

    Authorization is checked before the provider call and again by search during
    retrieval. No database transaction or connection survives the network await.
    """
    query = base.text.strip()
    result_types = list(base.effective_result_types)
    if base.highlight_notes_only and "note_block" not in result_types:
        result_types.append("note_block")

    def requires_embedding(db: Session) -> bool:
        with db.begin():
            for scope in scopes:
                authorize_scope(db, viewer_id, scope.kind, scope.id)
            return (
                len(query) >= MIN_QUERY_LENGTH
                and any(kind in SEMANTIC_RESULT_TYPES for kind in result_types)
                and _query_has_full_text_terms(db, query)
            )

    needed = await database.run_sync(requires_embedding)
    prepared = (
        await prepare_search_embedding(query, result_types)
        if needed
        else PreparedSearchEmbedding(query, None)
    )
    return await database.run_sync(
        lambda db: search_scopes(db, viewer_id, base, scopes, prepared_embedding=prepared)
    )
