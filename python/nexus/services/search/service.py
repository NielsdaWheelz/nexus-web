"""Public search orchestration: gates, retrieval, paging, projection, reopen."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from uuid import UUID

from provider_runtime.errors import NonGenerationCallFailed
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.schemas.search import SearchPageInfo, SearchResponse, SearchResultOut
from nexus.schemas.search_types import VALID_RESULT_TYPES
from nexus.services.contributors import resolve_contributor_ids_by_handles
from nexus.services.search.chunks import (
    resolve_content_chunk,
    resolve_evidence_span_result,
    resolve_note_block,
    search_note_chunks,
)
from nexus.services.search.projection import _result_to_out
from nexus.services.search.query import (
    CANDIDATES_PER_TYPE,
    MAX_LIMIT,
    MIN_QUERY_LENGTH,
    SEMANTIC_RESULT_TYPES,
    SearchQuery,
    SearchScope,
    decode_search_cursor,
    encode_search_cursor,
)
from nexus.services.search.results import InternalSearchResult, _SearchScore, rank_candidates
from nexus.services.search.retrievers import reopen, retrieve
from nexus.services.search.scope import authorize_scope
from nexus.services.semantic_chunks import (
    build_text_embedding,
    build_text_embedding_async,
    transcript_embedding_dimensions,
)

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class PreparedSearchEmbedding:
    """A completed external query preparation, including a classified failure."""

    query: str
    value: tuple[str, list[float]] | None


def _query_has_full_text_terms(db: Session, q: str) -> bool:
    return bool(
        db.scalar(text("SELECT numnode(websearch_to_tsquery('english', :query)) > 0"), {"query": q})
    )


def _checked_embedding(embedding: tuple[str, list[float]]) -> tuple[str, list[float]]:
    if len(embedding[1]) != transcript_embedding_dimensions():
        raise ApiError(
            ApiErrorCode.E_APP_SEARCH_FAILED, "Embedding provider returned an invalid response."
        )
    return embedding


def _lexical_fallback(exc: NonGenerationCallFailed, result_types: Sequence[str]) -> None:
    logger.warning(
        "search_semantic_embedding_unavailable_lexical_fallback",
        error=type(exc.failure).__name__,
        result_types=",".join(result_types),
    )


async def prepare_search_embedding(q: str, result_types: list[str]) -> PreparedSearchEmbedding:
    """Await query preparation outside any retrieval transaction."""
    try:
        embedding = await build_text_embedding_async(q)
    except NonGenerationCallFailed as exc:
        _lexical_fallback(exc, result_types)
        return PreparedSearchEmbedding(q, None)
    return PreparedSearchEmbedding(q, _checked_embedding(embedding))


def build_query_embedding(
    db: Session, q: str, result_types: list[str], *, transaction_active_at_entry: bool
) -> tuple[str, list[float]] | None:
    """Build the one query embedding, or None for lexical-only retrieval.

    Rolls back a transaction this call did not open so the embedding HTTP call
    never holds one. An expected provider failure degrades to lexical-only with
    one warning; a wrong-dimension response or missing credential stays fatal.
    """
    if not transaction_active_at_entry and db.in_transaction():
        db.rollback()
    try:
        embedding = build_text_embedding(q)
    except NonGenerationCallFailed as exc:
        _lexical_fallback(exc, result_types)
        return None
    return _checked_embedding(embedding)


def search(
    db: Session,
    viewer_id: UUID,
    query: SearchQuery,
    *,
    prepared_embedding: PreparedSearchEmbedding | None = None,
) -> SearchResponse:
    """Hybrid search across everything the viewer may see, as one ranked page.

    Raises NotFoundError for a scope the viewer cannot read (404, never 403, so
    existence does not leak) and InvalidRequestError for a malformed cursor.
    """
    transaction_active_at_entry = db.in_transaction()
    limit = min(max(1, query.limit), MAX_LIMIT)
    q = query.text.strip()
    offset = decode_search_cursor(query.cursor) if query.cursor else 0
    result_types = query.effective_result_types
    content_kinds = query.content_kinds

    has_query = len(q) >= MIN_QUERY_LENGTH
    if not has_query and not (query.authors or query.roles or content_kinds):
        return SearchResponse()
    authorize_scope(db, viewer_id, query.scope.kind, query.scope.id)
    if not result_types:
        return SearchResponse()
    if has_query and not _query_has_full_text_terms(db, q):
        return SearchResponse()

    # Hybrid retrieval is an invariant: the embedding is built once for any
    # semantic-capable kind, independent of the structured filters.
    semantic_types = list(result_types)
    if query.highlight_notes_only and "note_block" not in semantic_types:
        semantic_types.append("note_block")
    embedding: tuple[str, list[float]] | None = None
    if prepared_embedding is not None:
        if prepared_embedding.query != q:
            raise ValueError("prepared search embedding belongs to another query")
        embedding = prepared_embedding.value
    elif has_query and any(kind in SEMANTIC_RESULT_TYPES for kind in semantic_types):
        embedding = build_query_embedding(
            db, q, semantic_types, transaction_active_at_entry=transaction_active_at_entry
        )

    # None = no contributor filter; an empty list = requested handles resolved to
    # nothing, which matches nothing.
    contributor_ids = (
        list(resolve_contributor_ids_by_handles(db, list(query.authors)).values())
        if query.authors
        else None
    )
    candidates: list[InternalSearchResult] = []
    for result_type in result_types:
        candidates.extend(
            retrieve(
                db,
                viewer_id,
                result_type=result_type,
                q=q,
                has_query=has_query,
                semantic_embedding=embedding,
                scope_type=query.scope.kind,
                scope_id=query.scope.id,
                contributor_ids=contributor_ids,
                roles=query.roles,
                content_kinds=content_kinds,
                limit=CANDIDATES_PER_TYPE,
            )
        )
    if query.highlight_notes_only:
        # A highlight's attached note stays findable when Notes is not selected.
        candidates.extend(
            search_note_chunks(
                db,
                viewer_id,
                q=q,
                semantic_embedding=embedding,
                scope_type=query.scope.kind,
                scope_id=query.scope.id,
                limit=CANDIDATES_PER_TYPE,
                highlight_notes_only=True,
            )
        )
    rank_candidates(candidates)

    page = candidates[offset : offset + limit + 1]
    has_more = len(page) > limit
    return SearchResponse(
        results=[_result_to_out(db, viewer_id, result) for result in page[:limit]],
        page=SearchPageInfo(
            has_more=has_more,
            next_cursor=encode_search_cursor(offset + limit) if has_more else None,
        ),
    )


def search_scopes(
    db: Session,
    viewer_id: UUID,
    base: SearchQuery,
    scopes: Sequence[SearchScope],
    *,
    prepared_embedding: PreparedSearchEmbedding | None = None,
) -> SearchResponse:
    """Run ``base`` against each scope; union, dedupe on (type, id), keep the max."""
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
    database: AsyncSession, viewer_id: UUID, base: SearchQuery, scopes: Sequence[SearchScope]
) -> SearchResponse:
    """The same authorized retrieval with the provider call between two syncs.

    Authorization is checked before the provider call and again during
    retrieval; no transaction or connection survives the network await.
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

    prepared = (
        await prepare_search_embedding(query, result_types)
        if await database.run_sync(requires_embedding)
        else PreparedSearchEmbedding(query, None)
    )
    return await database.run_sync(
        lambda db: search_scopes(db, viewer_id, base, scopes, prepared_embedding=prepared)
    )


def get_search_result(
    db: Session,
    viewer_id: UUID,
    result_type: str,
    result_id: str,
    evidence_span_ids: list[UUID] | None = None,
) -> SearchResultOut:
    """Reopen one visible search result from its durable object reference."""
    if result_type not in VALID_RESULT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}"
        )
    try:
        identity = UUID(result_id)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from exc

    score = _SearchScore(raw=1.0, normalized=1.0)
    if result_type == "content_chunk":
        result = resolve_content_chunk(
            db,
            viewer_id=viewer_id,
            result_id=identity,
            score=score,
            evidence_span_ids=evidence_span_ids,
        )
    elif result_type == "note_block":
        result = resolve_note_block(db, viewer_id=viewer_id, result_id=identity, score=score)
    elif result_type == "evidence_span":
        result = resolve_evidence_span_result(
            db, viewer_id=viewer_id, result_id=identity, score=score
        )
    else:
        # podcast, contributor, conversation and artifact are discovery-only:
        # they carry no id_column and fall out of `reopen` as 404.
        result = reopen(db, viewer_id, result_type=result_type, result_id=identity, score=score)
    return _result_to_out(db, viewer_id, result)
