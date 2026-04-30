"""Search service layer.

Implements keyword search across all user-visible content using PostgreSQL
full-text search.

Search enforces strict s4 visibility guarantees:
- Media/fragments: visible via s4 provenance (non-default membership, default
  intrinsic, or active closure edge with source membership)
- Annotations: visible if anchor media readable AND viewer/author share a
  library containing that media (s4 highlight visibility)
- Messages: visible if conversation is visible (owner, public, or library-shared
  with active dual membership)

Key design decisions:
- Visibility filtering occurs inside SQL via CTEs, not post-filter
- Snippet generation happens only on filtered rows
- No raw queries logged (only hash for debugging)
- Ranking uses ts_rank_cd with type-specific multipliers
- Library-scope message search is constrained to conversations actively shared
  to the target library (sharing='library' + share row)
"""

import base64
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlencode
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_media,
    is_library_member,
    visible_media_ids_cte_sql,
)
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultAnnotationOut,
    SearchResultContextRefOut,
    SearchResultFragmentOut,
    SearchResultHighlightOut,
    SearchResultMediaOut,
    SearchResultMessageOut,
    SearchResultOut,
    SearchResultPodcastOut,
    SearchResultSourceOut,
    SearchResultTranscriptChunkOut,
)
from nexus.services.semantic_chunks import (
    build_text_embedding,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)
from nexus.services.transcript_media import transcript_media_searchable_sql

logger = get_logger(__name__)

# =============================================================================
# Constants
# =============================================================================

# Pagination defaults
DEFAULT_LIMIT = 20
MAX_LIMIT = 50
MIN_QUERY_LENGTH = 2

# Number of candidates to fetch per type before merging
CANDIDATES_PER_TYPE = 200
TRANSCRIPT_CHUNK_MIN_ANN_CANDIDATES = 200
TRANSCRIPT_CHUNK_ANN_CANDIDATE_MULTIPLIER = 20

# Supported search result types (ordered for deterministic behavior).
# Omitted type filters must mean "search everything the caller can ask for".
ALL_RESULT_TYPES = ("media", "podcast", "fragment", "annotation", "message", "transcript_chunk")
VALID_RESULT_TYPES = frozenset(ALL_RESULT_TYPES)

# Type weight multipliers (applied post-rank)
TYPE_WEIGHTS = {
    "media": 1.3,
    "podcast": 1.15,
    "annotation": 1.2,
    "message": 1.0,
    "fragment": 0.9,
    "transcript_chunk": 1.1,
}

# Maximum snippet length
MAX_SNIPPET_LENGTH = 300


@dataclass(slots=True)
class _SearchScore:
    raw: float
    weighted: float = 0.0
    normalized: float = 0.0


@dataclass(slots=True)
class _RankedMediaResult:
    id: UUID
    snippet: str
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["media"] = "media"


@dataclass(slots=True)
class _RankedPodcastResult:
    id: UUID
    title: str
    author: str | None
    snippet: str
    score: _SearchScore
    result_type: Literal["podcast"] = "podcast"


@dataclass(slots=True)
class _RankedFragmentResult:
    id: UUID
    snippet: str
    fragment_idx: int
    section_id: str | None
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["fragment"] = "fragment"


@dataclass(slots=True)
class _RankedAnnotationResult:
    id: UUID
    snippet: str
    highlight_id: UUID
    fragment_id: UUID
    fragment_idx: int
    section_id: str | None
    annotation_body: str
    highlight: SearchResultHighlightOut
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["annotation"] = "annotation"


@dataclass(slots=True)
class _RankedMessageResult:
    id: UUID
    snippet: str
    conversation_id: UUID
    seq: int
    score: _SearchScore
    result_type: Literal["message"] = "message"


@dataclass(slots=True)
class _RankedTranscriptChunkResult:
    id: UUID
    snippet: str
    t_start_ms: int
    t_end_ms: int
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["transcript_chunk"] = "transcript_chunk"


InternalSearchResult = (
    _RankedMediaResult
    | _RankedPodcastResult
    | _RankedFragmentResult
    | _RankedAnnotationResult
    | _RankedMessageResult
    | _RankedTranscriptChunkResult
)


def _build_search_score(raw_score: Any) -> _SearchScore:
    return _SearchScore(raw=float(raw_score) if raw_score else 0.0)


def _build_search_source(
    media_id: UUID,
    media_kind: str,
    title: str,
    authors: Any,
    published_date: Any,
) -> SearchResultSourceOut:
    return SearchResultSourceOut(
        media_id=media_id,
        media_kind=media_kind,
        title=title,
        authors=list(authors) if authors else [],
        published_date=str(published_date) if published_date is not None else None,
    )


# =============================================================================
# Cursor Encoding/Decoding
# =============================================================================


def encode_search_cursor(offset: int) -> str:
    """Encode a cursor for search pagination.

    Cursor payload: {"offset": <int>}
    Encoding: base64url without padding
    """
    payload = {"offset": offset}
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def decode_search_cursor(cursor: str) -> int:
    """Decode a cursor for search pagination.

    Returns:
        offset value

    Raises:
        InvalidRequestError: If cursor is malformed or unparseable.
    """
    try:
        # Add padding if needed
        padding = 4 - len(cursor) % 4
        if padding != 4:
            cursor += "=" * padding

        json_bytes = base64.urlsafe_b64decode(cursor)
        payload = json.loads(json_bytes.decode("utf-8"))

        offset = int(payload["offset"])
        if offset < 0:
            raise ValueError("Offset must be non-negative")
        return offset
    except Exception:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from None


# =============================================================================
# Query Logging Helpers (Privacy-Safe)
# =============================================================================


def hash_query(q: str) -> str:
    """Hash a normalized query for logging (privacy-safe).

    Never log raw queries - only the hash for debugging.
    """
    q_normalized = q.strip().lower()
    return hashlib.sha256(q_normalized.encode("utf-8")).hexdigest()[:16]


# =============================================================================
# Scope Parsing and Authorization
# =============================================================================


def parse_scope(scope: str) -> tuple[str, UUID | None]:
    """Parse scope string into (scope_type, scope_id).

    Valid scopes:
    - "all" -> ("all", None)
    - "media:<uuid>" -> ("media", UUID)
    - "library:<uuid>" -> ("library", UUID)
    - "conversation:<uuid>" -> ("conversation", UUID)

    Raises:
        InvalidRequestError: If scope format is invalid.
    """
    if scope == "all":
        return ("all", None)

    for prefix in ("media:", "library:", "conversation:"):
        if scope.startswith(prefix):
            try:
                scope_id = UUID(scope[len(prefix) :])
                return (prefix[:-1], scope_id)
            except ValueError:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, f"Invalid {prefix[:-1]} ID in scope"
                ) from None

    # Unknown scope format - treat as invalid
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")


def authorize_scope(
    db: Session,
    viewer_id: UUID,
    scope_type: str,
    scope_id: UUID | None,
) -> None:
    """Authorize viewer for the given scope.

    Raises:
        NotFoundError: If scope object is not visible to viewer.
    """
    if scope_type == "all":
        return

    if scope_id is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Scope ID is required")

    if scope_type == "media":
        if not can_read_media(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")
    elif scope_type == "library":
        if not is_library_member(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library not found")
    elif scope_type == "conversation":
        if not can_read_conversation(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")


def _normalize_result_types(types: list[str] | None) -> list[str]:
    if types is None:
        return list(ALL_RESULT_TYPES)

    normalized_types: list[str] = []
    seen_types: set[str] = set()
    invalid_types: list[str] = []
    seen_invalid_types: set[str] = set()
    for result_type in types:
        if result_type in VALID_RESULT_TYPES:
            if result_type not in seen_types:
                normalized_types.append(result_type)
                seen_types.add(result_type)
            continue
        if result_type not in seen_invalid_types:
            invalid_types.append(result_type)
            seen_invalid_types.add(result_type)

    if invalid_types:
        invalid_type_list = ", ".join(invalid_types)
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid search type: {invalid_type_list}",
        )

    return normalized_types


def visible_conversation_ids_cte_sql() -> str:
    """Return SQL for CTE that selects conversation IDs visible to viewer.

    Requires :viewer_id parameter.
    Returns conversation_id column.

    A conversation is visible iff:
    - owner_user_id = viewer_id, OR
    - sharing = 'public', OR
    - sharing = 'library' AND exists conversation_share to a library where
      both viewer AND owner are current members (dual membership check).
    """
    return """
        SELECT c.id AS conversation_id
        FROM conversations c
        WHERE c.owner_user_id = :viewer_id

        UNION

        SELECT c.id AS conversation_id
        FROM conversations c
        WHERE c.sharing = 'public'

        UNION

        SELECT c.id AS conversation_id
        FROM conversations c
        JOIN conversation_shares cs ON cs.conversation_id = c.id
        JOIN memberships vm ON vm.library_id = cs.library_id
                            AND vm.user_id = :viewer_id
        JOIN memberships om ON om.library_id = cs.library_id
                            AND om.user_id = c.owner_user_id
        WHERE c.sharing = 'library'
    """


def media_authors_rollup_cte_sql() -> str:
    """Return SQL for CTE that pre-aggregates media authors per media row."""
    return """
        SELECT
            ma.media_id,
            array_agg(ma.name ORDER BY ma.sort_order ASC, ma.created_at ASC, ma.id ASC) AS source_authors
        FROM media_authors ma
        GROUP BY ma.media_id
    """


# =============================================================================
# Search Implementation
# =============================================================================


def search(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope: str = "all",
    types: list[str] | None = None,
    semantic: bool = False,
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> SearchResponse:
    """Execute keyword search across all visible content.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        q: Search query string.
        scope: Search scope ("all", "media:<id>", "library:<id>", "conversation:<id>").
        types: List of types to search (media, fragment, annotation, message, transcript_chunk).
        cursor: Pagination cursor.
        limit: Maximum results per page (default 20, max 50).

    Returns:
        SearchResponse with typed results and pagination info.

    Raises:
        NotFoundError: If scope object is not visible to viewer.
        InvalidRequestError: If cursor is invalid.
    """
    start_time = time.time()

    # Clamp limit
    limit = min(max(1, limit), MAX_LIMIT)

    # Validate and normalize query
    q = q.strip()
    if len(q) < MIN_QUERY_LENGTH:
        _log_search(viewer_id, q, scope, types, 0, start_time)
        return SearchResponse()

    # Parse and authorize scope
    scope_type, scope_id = parse_scope(scope)
    authorize_scope(db, viewer_id, scope_type, scope_id)

    normalized_types = _normalize_result_types(types)

    if len(normalized_types) == 0:
        _log_search(viewer_id, q, scope, normalized_types, 0, start_time)
        return SearchResponse()

    # Decode cursor
    offset = 0
    if cursor:
        offset = decode_search_cursor(cursor)

    # Execute search queries per type and collect results
    all_results: list[InternalSearchResult] = []

    for result_type in normalized_types:
        type_results = _search_type(
            db,
            viewer_id,
            q,
            result_type,
            semantic,
            scope_type,
            scope_id,
            CANDIDATES_PER_TYPE,
        )
        all_results.extend(type_results)

    # Compute weighted scores
    for result in all_results:
        result.score.weighted = result.score.raw * TYPE_WEIGHTS[result.result_type]

    # Normalize scores within each type to [0, 1]
    _normalize_scores_by_type(all_results)

    # Sort by normalized_score DESC, then by id ASC for determinism
    all_results.sort(key=lambda result: (-result.score.normalized, str(result.id)))

    # Apply offset pagination
    paginated = all_results[offset : offset + limit + 1]  # +1 to check has_more

    has_more = len(paginated) > limit
    if has_more:
        paginated = paginated[:limit]

    # Convert to response objects
    results = [_result_to_out(r) for r in paginated]

    # Build page info
    next_cursor = None
    if has_more:
        next_cursor = encode_search_cursor(offset + limit)

    _log_search(viewer_id, q, scope, normalized_types, len(results), start_time)

    return SearchResponse(
        results=results,
        page=SearchPageInfo(has_more=has_more, next_cursor=next_cursor),
    )


def _search_type(
    db: Session,
    viewer_id: UUID,
    q: str,
    result_type: str,
    semantic: bool,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search a specific content type with visibility filtering.

    Returns list of dicts with raw results (not yet normalized).
    """
    if result_type == "media":
        return _search_media(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "podcast":
        return _search_podcasts(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "fragment":
        if semantic:
            return _search_fragment_chunks(db, viewer_id, q, scope_type, scope_id, limit)
        return _search_fragments(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "annotation":
        return _search_annotations(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "message":
        return _search_messages(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "transcript_chunk":
        if not semantic:
            return []
        return _search_transcript_chunks(db, viewer_id, q, scope_type, scope_id, limit)
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}")


def _search_media(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search media titles with visibility filtering."""
    # Build scope filter
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = "AND m.id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND m.id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND m.id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_authors_agg AS ({media_authors_rollup_cte_sql()})
        SELECT
            m.id,
            m.title,
            m.kind,
            m.published_date,
            maa.source_authors,
            ts_rank_cd(m.title_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', m.title, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
        WHERE m.title_tsv @@ websearch_to_tsquery('english', :query)
        {scope_filter}
        ORDER BY score DESC, m.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedMediaResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[6] or row[1])),
            source=_build_search_source(row[0], row[2], row[1], row[4], row[3]),
            score=_build_search_score(row[5]),
        )
        for row in rows
    ]


def _search_podcasts(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search visible podcast metadata."""
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        return []
    elif scope_type == "library":
        scope_filter = """
            AND p.id IN (
                SELECT podcast_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND podcast_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND EXISTS (
                SELECT 1
                FROM conversation_media cm
                JOIN podcast_episodes pe ON pe.media_id = cm.media_id
                WHERE cm.conversation_id = :scope_id
                  AND pe.podcast_id = p.id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH visible_podcasts AS (
            SELECT ps.podcast_id
            FROM podcast_subscriptions ps
            WHERE ps.user_id = :viewer_id
              AND ps.status = 'active'

            UNION

            SELECT le.podcast_id
            FROM library_entries le
            JOIN memberships m ON m.library_id = le.library_id
                              AND m.user_id = :viewer_id
            WHERE le.podcast_id IS NOT NULL
        )
        SELECT
            p.id,
            p.title,
            p.author,
            ts_rank_cd(
                to_tsvector(
                    'english',
                    concat_ws(' ', p.title, COALESCE(p.author, ''), COALESCE(p.description, ''))
                ),
                websearch_to_tsquery('english', :query)
            ) AS score,
            ts_headline(
                'english',
                concat_ws(' ', p.title, COALESCE(p.author, ''), COALESCE(p.description, '')),
                websearch_to_tsquery('english', :query),
                'MaxWords=50, MinWords=10, MaxFragments=1'
            ) AS snippet
        FROM podcasts p
        JOIN visible_podcasts vp ON vp.podcast_id = p.id
        WHERE to_tsvector(
                'english',
                concat_ws(' ', p.title, COALESCE(p.author, ''), COALESCE(p.description, ''))
            ) @@ websearch_to_tsquery('english', :query)
        {scope_filter}
        ORDER BY score DESC, p.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedPodcastResult(
            id=row[0],
            title=row[1],
            author=row[2],
            snippet=_truncate_snippet(str(row[4] or row[1])),
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]


def _search_fragments(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search fragment canonical_text with visibility filtering."""
    # Build scope filter
    scope_filter = ""
    transcript_media_filter = transcript_media_searchable_sql("m", "mts")
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = "AND f.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND f.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND f.media_id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_authors_agg AS ({media_authors_rollup_cte_sql()})
        SELECT
            f.id,
            f.media_id,
            f.idx,
            nav.location_id AS section_id,
            m.kind,
            m.title,
            m.published_date,
            maa.source_authors,
            ts_rank_cd(f.canonical_text_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', f.canonical_text, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM fragments f
        JOIN media m ON m.id = f.media_id
        JOIN visible_media vm ON vm.media_id = f.media_id
        LEFT JOIN media_transcript_states mts ON mts.media_id = f.media_id
        LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
        LEFT JOIN LATERAL (
            SELECT location_id
            FROM epub_nav_locations
            WHERE media_id = f.media_id
              AND fragment_idx = f.idx
            ORDER BY ordinal ASC
            LIMIT 1
        ) nav ON m.kind = 'epub'
        WHERE f.canonical_text_tsv @@ websearch_to_tsquery('english', :query)
          AND (
              f.transcript_version_id IS NULL
              OR mts.active_transcript_version_id IS NULL
              OR f.transcript_version_id = mts.active_transcript_version_id
          )
          AND {transcript_media_filter}
        {scope_filter}
        ORDER BY score DESC, f.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedFragmentResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[9] or "")),
            fragment_idx=row[2],
            section_id=row[3],
            source=_build_search_source(row[1], row[4], row[5], row[7], row[6]),
            score=_build_search_score(row[8]),
        )
        for row in rows
    ]


def _search_fragment_chunks(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Semantic fragment search over persisted content_chunks."""
    scope_filter = ""
    embedding_dims = transcript_embedding_dimensions()
    ann_limit = max(
        TRANSCRIPT_CHUNK_MIN_ANN_CANDIDATES,
        int(limit) * TRANSCRIPT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    )

    try:
        embedding_model, query_embedding = build_text_embedding(q)
    except Exception as exc:
        logger.warning(
            "semantic_query_embedding_failed",
            error=str(exc),
            query_hash=hash_query(q),
            user_id=str(viewer_id),
        )
        return []

    if len(query_embedding) != embedding_dims:
        logger.warning(
            "semantic_query_embedding_dimension_mismatch",
            expected_dimensions=embedding_dims,
            actual_dimensions=len(query_embedding),
            embedding_model=embedding_model,
            query_hash=hash_query(q),
            user_id=str(viewer_id),
        )
        return []

    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "query": q,
        "limit": limit,
        "ann_limit": ann_limit,
        "query_embedding": to_pgvector_literal(query_embedding),
        "embedding_model": embedding_model,
    }

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = "AND cc.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND cc.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND cc.media_id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_authors_agg AS ({media_authors_rollup_cte_sql()}),
            query_embedding AS (
                SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
            ),
            ann_candidates AS (
                SELECT
                    f.id,
                    f.media_id,
                    f.idx,
                    nav.location_id AS section_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    maa.source_authors,
                    cc.chunk_text,
                    cc.created_at,
                    (1 - (cc.embedding_vector <=> qe.embedding)) AS semantic_similarity,
                    ts_rank_cd(
                        to_tsvector('english', cc.chunk_text),
                        websearch_to_tsquery('english', :query)
                    ) AS lexical_score
                FROM content_chunks cc
                JOIN fragments f ON f.id = cc.fragment_id
                JOIN media m ON m.id = cc.media_id
                JOIN visible_media vm ON vm.media_id = cc.media_id
                LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
                LEFT JOIN LATERAL (
                    SELECT location_id
                    FROM epub_nav_locations
                    WHERE media_id = f.media_id
                      AND fragment_idx = f.idx
                    ORDER BY ordinal ASC
                    LIMIT 1
                ) nav ON m.kind = 'epub'
                CROSS JOIN query_embedding qe
                WHERE cc.source_kind = 'fragment'
                  AND cc.embedding_vector IS NOT NULL
                  AND cc.embedding_model = :embedding_model
                {scope_filter}
                ORDER BY cc.embedding_vector <=> qe.embedding ASC, cc.id ASC
                LIMIT :ann_limit
            )
        SELECT
            id,
            media_id,
            idx,
            section_id,
            kind,
            title,
            published_date,
            source_authors,
            chunk_text,
            (
                (0.75 * GREATEST(semantic_similarity, 0.0))
                + (0.20 * GREATEST(lexical_score, 0.0))
                + (
                    0.05 * GREATEST(
                        0.0,
                        1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                    )
                )
            ) AS raw_score
        FROM ann_candidates
        WHERE semantic_similarity > 0.0 OR lexical_score > 0.0
        ORDER BY raw_score DESC, id ASC
        LIMIT :limit
    """
    probes = max(10, min(100, ann_limit))
    try:
        db.execute(text(f"SET LOCAL ivfflat.probes = {probes}"))
    except Exception:
        db.rollback()
    rows = db.execute(text(query), params).fetchall()
    return [
        _RankedFragmentResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[8] or "")),
            fragment_idx=row[2],
            section_id=row[3],
            source=_build_search_source(row[1], row[4], row[5], row[7], row[6]),
            score=_build_search_score(row[9]),
        )
        for row in rows
    ]


def _search_annotations(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search annotation body with s4 highlight visibility filtering.

    An annotation is visible iff:
    - Anchor media is in the visible-media CTE (s4 provenance), AND
    - Viewer and highlight author share at least one library containing
      the anchor media (library intersection check).
    """
    scope_filter = ""
    transcript_media_filter = transcript_media_searchable_sql("m", "mts")
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = "AND f.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND f.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND f.media_id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_authors_agg AS ({media_authors_rollup_cte_sql()})
        SELECT
            a.id,
            a.highlight_id,
            f.media_id,
            f.id AS fragment_id,
            f.idx AS fragment_idx,
            nav.location_id AS section_id,
            h.exact,
            h.prefix,
            h.suffix,
            a.body,
            m.kind,
            m.title,
            m.published_date,
            maa.source_authors,
            ts_rank_cd(a.body_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', a.body, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM annotations a
        JOIN highlights h ON h.id = a.highlight_id
        JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
        JOIN fragments f ON f.id = hfa.fragment_id
        JOIN media m ON m.id = f.media_id
        JOIN visible_media vm ON vm.media_id = f.media_id
        LEFT JOIN media_transcript_states mts ON mts.media_id = f.media_id
        LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
        LEFT JOIN LATERAL (
            SELECT location_id
            FROM epub_nav_locations
            WHERE media_id = f.media_id
              AND fragment_idx = f.idx
            ORDER BY ordinal ASC
            LIMIT 1
        ) nav ON m.kind = 'epub'
        WHERE a.body_tsv @@ websearch_to_tsquery('english', :query)
          AND {transcript_media_filter}
          AND EXISTS (
              SELECT 1
              FROM library_entries lm_ann
              JOIN memberships vm_ann ON vm_ann.library_id = lm_ann.library_id
                                      AND vm_ann.user_id = :viewer_id
              JOIN memberships am_ann ON am_ann.library_id = lm_ann.library_id
                                      AND am_ann.user_id = h.user_id
              WHERE lm_ann.media_id = f.media_id
                AND lm_ann.media_id IS NOT NULL
          )
        {scope_filter}
        ORDER BY score DESC, a.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedAnnotationResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[15] or "")),
            highlight_id=row[1],
            fragment_id=row[3],
            fragment_idx=row[4],
            section_id=row[5],
            annotation_body=row[9],
            highlight=SearchResultHighlightOut(
                exact=row[6],
                prefix=row[7] or "",
                suffix=row[8] or "",
            ),
            source=_build_search_source(row[2], row[10], row[11], row[13], row[12]),
            score=_build_search_score(row[14]),
        )
        for row in rows
    ]


def _search_messages(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search message content with visibility filtering.

    Message visibility follows conversation visibility (canonical s4 CTE).
    Pending messages are never searchable.

    Library scope includes only messages from conversations actively shared
    to the target library (sharing='library' + share row to scope library).
    Owner/public conversations not shared to the target library are excluded.
    """
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        return []
    elif scope_type == "library":
        scope_filter = """
            AND m.conversation_id IN (
                SELECT cs.conversation_id
                FROM conversation_shares cs
                JOIN conversations conv ON conv.id = cs.conversation_id
                WHERE cs.library_id = :scope_id
                  AND conv.sharing = 'library'
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = "AND m.conversation_id = :scope_id"
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
        SELECT
            m.id,
            m.conversation_id,
            m.seq,
            ts_rank_cd(m.content_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', m.content, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM messages m
        JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
        WHERE m.content_tsv @@ websearch_to_tsquery('english', :query)
          AND m.status != 'pending'  -- Pending messages never searchable
        {scope_filter}
        ORDER BY score DESC, m.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedMessageResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[4] or "")),
            conversation_id=row[1],
            seq=row[2],
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]


def _search_transcript_chunks(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Semantic transcript-chunk search using pgvector ANN + hybrid reranking."""
    scope_filter = ""
    transcript_media_filter = transcript_media_searchable_sql("m", "mts")
    embedding_dims = transcript_embedding_dimensions()
    ann_limit = max(
        TRANSCRIPT_CHUNK_MIN_ANN_CANDIDATES,
        int(limit) * TRANSCRIPT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    )

    try:
        embedding_model, query_embedding = build_text_embedding(q)
    except Exception as exc:
        logger.warning(
            "semantic_query_embedding_failed",
            error=str(exc),
            query_hash=hash_query(q),
            user_id=str(viewer_id),
        )
        return []

    if len(query_embedding) != embedding_dims:
        logger.warning(
            "semantic_query_embedding_dimension_mismatch",
            expected_dimensions=embedding_dims,
            actual_dimensions=len(query_embedding),
            embedding_model=embedding_model,
            query_hash=hash_query(q),
            user_id=str(viewer_id),
        )
        return []

    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "query": q,
        "limit": limit,
        "ann_limit": ann_limit,
        "query_embedding": to_pgvector_literal(query_embedding),
        "embedding_model": embedding_model,
    }

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = "AND tc.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND tc.media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND tc.media_id IN (
                SELECT media_id
                FROM conversation_media
                WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_authors_agg AS ({media_authors_rollup_cte_sql()}),
            query_embedding AS (
                SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
            ),
            ann_candidates AS (
                SELECT
                    tc.id,
                    tc.media_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    maa.source_authors,
                    tc.chunk_text,
                    tc.t_start_ms,
                    tc.t_end_ms,
                    tc.created_at,
                    (1 - (tc.embedding_vector <=> qe.embedding)) AS semantic_similarity,
                    ts_rank_cd(
                        to_tsvector('english', tc.chunk_text),
                        websearch_to_tsquery('english', :query)
                    ) AS lexical_score
                FROM content_chunks tc
                JOIN media m ON m.id = tc.media_id
                JOIN visible_media vm ON vm.media_id = tc.media_id
                JOIN media_transcript_states mts ON mts.media_id = tc.media_id
                LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
                CROSS JOIN query_embedding qe
                WHERE mts.semantic_status = 'ready'
                  AND tc.source_kind = 'transcript'
                  AND mts.active_transcript_version_id = tc.transcript_version_id
                  AND mts.transcript_state IN ('ready', 'partial')
                  AND tc.embedding_vector IS NOT NULL
                  AND tc.embedding_model = :embedding_model
                  AND {transcript_media_filter}
                {scope_filter}
                ORDER BY tc.embedding_vector <=> qe.embedding ASC, tc.id ASC
                LIMIT :ann_limit
            )
        SELECT
            id,
            media_id,
            kind,
            title,
            published_date,
            source_authors,
            chunk_text,
            t_start_ms,
            t_end_ms,
            (
                (0.70 * GREATEST(semantic_similarity, 0.0))
                + (0.25 * GREATEST(lexical_score, 0.0))
                + (
                    0.05 * GREATEST(
                        0.0,
                        1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                    )
                )
            ) AS raw_score
        FROM ann_candidates
        WHERE semantic_similarity > 0.0 OR lexical_score > 0.0
        ORDER BY raw_score DESC, id ASC
        LIMIT :limit
    """
    probes = max(10, min(100, ann_limit))
    try:
        db.execute(text(f"SET LOCAL ivfflat.probes = {probes}"))
    except Exception:
        # Non-pgvector engines or unsupported settings should still run search.
        db.rollback()
    result = db.execute(text(query), params)
    rows = result.fetchall()
    return [
        _RankedTranscriptChunkResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[6] or "")),
            t_start_ms=int(row[7]),
            t_end_ms=int(row[8]),
            source=_build_search_source(row[1], row[2], row[3], row[5], row[4]),
            score=_build_search_score(row[9]),
        )
        for row in rows
    ]


def _normalize_scores_by_type(results: list[InternalSearchResult]) -> None:
    """Normalize weighted scores within each type to [0, 1] range.

    Modifies results in place.
    """
    # Group by type
    by_type: dict[str, list[InternalSearchResult]] = {}
    for result in results:
        by_type.setdefault(result.result_type, []).append(result)

    # Normalize each type
    for type_results in by_type.values():
        if not type_results:
            continue

        max_score = max(result.score.weighted for result in type_results)
        min_score = min(result.score.weighted for result in type_results)

        if max_score == min_score:
            # All same score -> all get 1.0 (or 0.5 if zero)
            norm_value = 1.0 if max_score > 0 else 0.5
            for result in type_results:
                result.score.normalized = norm_value
        else:
            for result in type_results:
                result.score.normalized = (result.score.weighted - min_score) / (
                    max_score - min_score
                )


def _truncate_snippet(snippet: str) -> str:
    """Truncate snippet to max length, preserving word boundaries."""
    if len(snippet) <= MAX_SNIPPET_LENGTH:
        return snippet

    # Find last space before limit
    truncated = snippet[:MAX_SNIPPET_LENGTH]
    last_space = truncated.rfind(" ")
    if last_space > MAX_SNIPPET_LENGTH // 2:
        truncated = truncated[:last_space]

    return truncated + "..."


def _build_source_label(source: SearchResultSourceOut) -> str:
    parts = [source.title]
    if source.authors:
        parts.append(", ".join(source.authors))
    if source.published_date:
        parts.append(source.published_date)
    if source.media_kind:
        parts.append(source.media_kind.replace("_", " "))
    return " - ".join(part for part in parts if part)


def _result_context_ref(result: InternalSearchResult) -> SearchResultContextRefOut:
    return SearchResultContextRefOut(type=result.result_type, id=result.id)


def _result_deep_link(result: InternalSearchResult) -> str:
    if isinstance(result, _RankedMediaResult):
        return f"/media/{result.id}"
    if isinstance(result, _RankedPodcastResult):
        return f"/podcasts/{result.id}"
    if isinstance(result, _RankedFragmentResult):
        params: dict[str, str] = {}
        if result.source.media_kind == "epub" and result.section_id:
            params["loc"] = result.section_id
        params["fragment"] = str(result.id)
        return f"/media/{result.source.media_id}?{urlencode(params)}"
    if isinstance(result, _RankedAnnotationResult):
        params: dict[str, str] = {}
        if result.source.media_kind == "epub" and result.section_id:
            params["loc"] = result.section_id
        params["fragment"] = str(result.fragment_id)
        params["highlight"] = str(result.highlight_id)
        return f"/media/{result.source.media_id}?{urlencode(params)}"
    if isinstance(result, _RankedMessageResult):
        return f"/conversations/{result.conversation_id}"
    if isinstance(result, _RankedTranscriptChunkResult):
        return f"/media/{result.source.media_id}?t_start_ms={result.t_start_ms}"
    raise AssertionError(f"Unknown search result type: {type(result).__name__}")


def _result_model_fields(result: InternalSearchResult) -> dict[str, Any]:
    context_ref = _result_context_ref(result)
    deep_link = _result_deep_link(result)

    if isinstance(result, _RankedPodcastResult):
        source_parts = [result.title]
        if result.author:
            source_parts.append(result.author)
        return {
            "title": result.title,
            "source_label": " - ".join(source_parts),
            "media_id": None,
            "media_kind": None,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    if isinstance(result, _RankedMessageResult):
        return {
            "title": f"Conversation message #{result.seq}",
            "source_label": f"message #{result.seq}",
            "media_id": None,
            "media_kind": None,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    source = result.source
    return {
        "title": source.title,
        "source_label": _build_source_label(source),
        "media_id": source.media_id,
        "media_kind": source.media_kind,
        "deep_link": deep_link,
        "context_ref": context_ref,
    }


def _result_to_out(result: InternalSearchResult) -> SearchResultOut:
    """Convert an internal ranked result into the strict response union."""
    base_payload = {
        "id": result.id,
        "score": round(result.score.normalized, 4),
        "snippet": result.snippet,
        **_result_model_fields(result),
    }

    if isinstance(result, _RankedMediaResult):
        return SearchResultMediaOut(
            type="media",
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedPodcastResult):
        return SearchResultPodcastOut(
            type="podcast",
            author=result.author,
            **base_payload,
        )

    if isinstance(result, _RankedFragmentResult):
        return SearchResultFragmentOut(
            type="fragment",
            fragment_idx=result.fragment_idx,
            section_id=result.section_id,
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedAnnotationResult):
        return SearchResultAnnotationOut(
            type="annotation",
            highlight_id=result.highlight_id,
            fragment_id=result.fragment_id,
            fragment_idx=result.fragment_idx,
            section_id=result.section_id,
            annotation_body=result.annotation_body,
            highlight=result.highlight,
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedMessageResult):
        return SearchResultMessageOut(
            type="message",
            conversation_id=result.conversation_id,
            seq=result.seq,
            **base_payload,
        )

    if isinstance(result, _RankedTranscriptChunkResult):
        return SearchResultTranscriptChunkOut(
            type="transcript_chunk",
            t_start_ms=result.t_start_ms,
            t_end_ms=result.t_end_ms,
            source=result.source,
            **base_payload,
        )

    raise AssertionError(f"Unknown search result type: {type(result).__name__}")


def _log_search(
    viewer_id: UUID,
    q: str,
    scope: str,
    types: list[str] | None,
    results_count: int,
    start_time: float,
) -> None:
    """Log search metrics (privacy-safe - no raw query).

    Per spec: Do NOT log raw search queries.
    Log only hash, length, and aggregate metrics.
    """
    latency_ms = int((time.time() - start_time) * 1000)
    logger.info(
        "search_executed",
        query_len=len(q),
        query_hash=hash_query(q),
        scope=scope,
        types_count=len(types) if types is not None else len(ALL_RESULT_TYPES),
        results_count=results_count,
        latency_ms=latency_ms,
        user_id=str(viewer_id),
    )
