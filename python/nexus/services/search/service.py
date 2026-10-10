"""Search entry points: discovery pages, multi-scope chat search and reopen by identity.

The transaction law lives in ``read_snapshot``: the query embedding is computed first,
outside any transaction, then one REPEATABLE READ, READ ONLY snapshot is opened, read and
ended. A caller arriving with an open transaction gets a RuntimeError, never lost writes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.search import SearchPageInfo, SearchResponse, SearchResultOut
from nexus.schemas.search_types import VALID_RESULT_TYPES
from nexus.services.contributors import resolve_contributor_ids_by_handles
from nexus.services.search.project import family_of, project
from nexus.services.search.query import (
    FORMAT_STORAGE,
    MAX_LIMIT,
    SearchQuery,
    SearchScope,
    decode_offset,
    encode_cursor,
    is_offset,
)
from nexus.services.search.scope import authorize_scope
from nexus.services.search.semantic import Embedding, embed_text
from nexus.services.search.sources import Hit, Retrieval, merge, rank

_SEMANTIC = frozenset({"content_chunk", "note_block"})


def read_snapshot[T](db: Session, read: Callable[[Session], T]) -> T:
    """``read`` inside one strict read-only snapshot that is ended before returning."""
    get_repeatable_read_db(db)  # raises on a session that already holds a transaction
    try:
        return read(db)
    finally:
        db.rollback()


def _families(query: SearchQuery) -> list[str] | None:
    """The families serving the query; None when it has neither usable text nor a filter."""
    if not (query.terms or query.formats or query.authors or query.roles):
        return None
    families = {family_of(result_type) for result_type in query.effective_result_types}
    return sorted(families | ({"note_block"} if query.highlight_notes_only else set()))


def _page(
    db: Session,
    viewer_id: UUID,
    query: SearchQuery,
    families: list[str],
    scopes: Sequence[SearchScope],
    embedding: Embedding | None,
    offset: int,
    limit: int,
) -> tuple[list[SearchResultOut], bool]:
    """One page of the merged order over the union of ``scopes`` (authorized even when no
    family serves the query), and whether more follow."""
    for scope in scopes:
        authorize_scope(db, viewer_id, scope)
    authors = resolve_contributor_ids_by_handles(db, query.authors) if query.authors else None
    r = Retrieval(
        viewer_id=viewer_id,
        terms=query.terms,
        k=offset + limit + 1,
        scopes=tuple(scopes),
        frozen=query.frozen_context_refs,
        content_kinds=tuple(FORMAT_STORAGE[f] for f in query.formats),
        contributor_ids=None if authors is None else list(authors.values()),
        roles=query.roles,
        embedding=embedding,
        highlight_notes_only=query.highlight_notes_only,
    )
    hits = merge(hit for family in families for hit in rank(db, r, family))
    page = hits[offset : offset + limit + 1]
    more = len(page) > limit and is_offset(offset + limit)
    return project(db, viewer_id, page[:limit], r.terms), more


def search(db: Session, viewer_id: UUID, query: SearchQuery) -> SearchResponse:
    """One ranked page of everything the viewer may read in ``query.scope``.

    Requires a session without an open transaction. 404 for an unreadable scope once the
    query has text or a filter.
    """
    offset = decode_offset(query.cursor)
    limit = min(query.limit, MAX_LIMIT)
    families = _families(query)
    if families is None:
        return SearchResponse(results=[], page=SearchPageInfo(next_cursor=None))
    embedding = embed_text(query.terms) if query.terms and _SEMANTIC & set(families) else None
    results, more = read_snapshot(
        db, lambda s: _page(s, viewer_id, query, families, (query.scope,), embedding, offset, limit)
    )
    cursor = encode_cursor({"offset": offset + limit}) if more else None
    return SearchResponse(results=results, page=SearchPageInfo(has_more=more, next_cursor=cursor))


async def search_scopes_async(
    database: AsyncSession, viewer_id: UUID, base: SearchQuery, scopes: Sequence[SearchScope]
) -> SearchResponse:
    """The first page over the union of ``scopes`` in one pass; ``has_more`` is real."""
    families = _families(base)
    if families is None:
        return SearchResponse(results=[], page=SearchPageInfo(next_cursor=None))
    embedding = (
        await asyncio.to_thread(embed_text, base.terms)
        if base.terms and _SEMANTIC & set(families)
        else None
    )
    limit = min(base.limit, MAX_LIMIT)
    results, more = await database.run_sync(
        lambda db: read_snapshot(
            db, lambda s: _page(s, viewer_id, base, families, scopes, embedding, 0, limit)
        )
    )
    return SearchResponse(results=results, page=SearchPageInfo(has_more=more, next_cursor=None))


def get_search_result(
    db: Session,
    viewer_id: UUID,
    result_type: str,
    result_id: str,
    evidence_span_ids: list[UUID] | None = None,
) -> SearchResultOut:
    """Reopen one visible row by durable identity, in the caller's transaction.

    Every type reopens through its family; a media id reopens as media, episode or video
    by its kind, whatever was asked.
    """
    if result_type not in VALID_RESULT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}"
        )
    try:
        identity = UUID(result_id)
    except ValueError:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from None
    hit = Hit(result_type, identity, "", 1.0)
    found = project(db, viewer_id, [hit], "", evidence_span_ids=evidence_span_ids)
    if not found:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    return found[0]
