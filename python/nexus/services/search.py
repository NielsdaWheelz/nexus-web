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
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation, can_read_media, is_library_member
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultAnnotationOut,
    SearchResultFragmentOut,
    SearchResultHighlightOut,
    SearchResultMediaOut,
    SearchResultMessageOut,
    SearchResultOut,
    SearchResultSourceOut,
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

# Supported search result types (ordered for deterministic behavior)
ALL_RESULT_TYPES = ("media", "fragment", "annotation", "message")
VALID_RESULT_TYPES = set(ALL_RESULT_TYPES)

# Type weight multipliers (applied post-rank)
TYPE_WEIGHTS = {
    "media": 1.3,
    "annotation": 1.2,
    "message": 1.0,
    "fragment": 0.9,
}

# Maximum snippet length
MAX_SNIPPET_LENGTH = 300


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
        return  # Always authorized

    if scope_type == "media":
        if not can_read_media(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Media not found")

    elif scope_type == "library":
        if not is_library_member(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Library not found")

    elif scope_type == "conversation":
        if not can_read_conversation(db, viewer_id, scope_id):
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")


# =============================================================================
# Visibility CTEs
# =============================================================================


def visible_media_ids_cte_sql() -> str:
    """Return SQL for CTE that selects media IDs visible to viewer under s4 provenance.

    Three paths (UNION):
    1. Non-default library membership: viewer is member of non-default library containing media.
    2. Default intrinsic: viewer owns default library with intrinsic row for media.
    3. Default closure: viewer owns default library with closure edge, and viewer is
       currently a member of the source library.

    Raw presence in library_media for a default library is NOT sufficient without
    intrinsic or active closure-edge justification.

    Requires :viewer_id parameter.
    Returns media_id column.
    """
    return """
        SELECT lm.media_id
        FROM library_media lm
        JOIN memberships m ON m.library_id = lm.library_id
        JOIN libraries l ON l.id = lm.library_id
        WHERE m.user_id = :viewer_id AND l.is_default = false

        UNION

        SELECT dli.media_id
        FROM default_library_intrinsics dli
        JOIN libraries l ON l.id = dli.default_library_id
        WHERE l.owner_user_id = :viewer_id AND l.is_default = true

        UNION

        SELECT dlce.media_id
        FROM default_library_closure_edges dlce
        JOIN libraries l ON l.id = dlce.default_library_id
        JOIN memberships m ON m.library_id = dlce.source_library_id
                           AND m.user_id = :viewer_id
        WHERE l.owner_user_id = :viewer_id AND l.is_default = true
    """


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
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> SearchResponse:
    """Execute keyword search across all visible content.

    Args:
        db: Database session.
        viewer_id: The ID of the viewer.
        q: Search query string.
        scope: Search scope ("all", "media:<id>", "library:<id>", "conversation:<id>").
        types: List of types to search (media, fragment, annotation, message).
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

    # Normalize types:
    # - None means caller omitted type filtering -> search all types
    # - [] means caller explicitly selected no types -> return no results
    if types is None:
        normalized_types = list(ALL_RESULT_TYPES)
    else:
        normalized_types: list[str] = []
        seen_types: set[str] = set()
        for result_type in types:
            if result_type in VALID_RESULT_TYPES and result_type not in seen_types:
                normalized_types.append(result_type)
                seen_types.add(result_type)

    if len(normalized_types) == 0:
        _log_search(viewer_id, q, scope, normalized_types, 0, start_time)
        return SearchResponse()

    # Decode cursor
    offset = 0
    if cursor:
        offset = decode_search_cursor(cursor)

    # Execute search queries per type and collect results
    all_results: list[dict] = []

    for result_type in normalized_types:
        type_results = _search_type(
            db,
            viewer_id,
            q,
            result_type,
            scope_type,
            scope_id,
            CANDIDATES_PER_TYPE,
        )
        all_results.extend(type_results)

    # Compute weighted scores
    for result in all_results:
        result["weighted_score"] = result["raw_score"] * TYPE_WEIGHTS.get(result["type"], 1.0)

    # Normalize scores within each type to [0, 1]
    _normalize_scores_by_type(all_results)

    # Sort by normalized_score DESC, then by id ASC for determinism
    all_results.sort(key=lambda r: (-r["normalized_score"], str(r["id"])))

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
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[dict]:
    """Search a specific content type with visibility filtering.

    Returns list of dicts with raw results (not yet normalized).
    """
    if result_type == "media":
        return _search_media(db, viewer_id, q, scope_type, scope_id, limit)
    elif result_type == "fragment":
        return _search_fragments(db, viewer_id, q, scope_type, scope_id, limit)
    elif result_type == "annotation":
        return _search_annotations(db, viewer_id, q, scope_type, scope_id, limit)
    elif result_type == "message":
        return _search_messages(db, viewer_id, q, scope_type, scope_id, limit)
    return []


def _search_media(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[dict]:
    """Search media titles with visibility filtering."""
    # Build scope filter
    scope_filter = ""
    transcript_media_filter = transcript_media_searchable_sql("m")
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "media":
        scope_filter = "AND m.id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND m.id IN (
                SELECT media_id FROM library_media WHERE library_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        # Media search doesn't apply to conversation scope
        return []

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
          AND {transcript_media_filter}
        {scope_filter}
        ORDER BY score DESC, m.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        {
            "type": "media",
            "id": row[0],
            "source": {
                "media_id": row[0],
                "media_kind": row[2],
                "title": row[1],
                "authors": list(row[4]) if row[4] else [],
                "published_date": row[3],
            },
            "raw_score": float(row[5]) if row[5] else 0.0,
            "snippet": _truncate_snippet(row[6] or row[1]),
        }
        for row in rows
    ]


def _search_fragments(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[dict]:
    """Search fragment canonical_text with visibility filtering."""
    # Build scope filter
    scope_filter = ""
    transcript_media_filter = transcript_media_searchable_sql("m")
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "media":
        scope_filter = "AND f.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND f.media_id IN (
                SELECT media_id FROM library_media WHERE library_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        # Fragment search doesn't apply to conversation scope
        return []

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_authors_agg AS ({media_authors_rollup_cte_sql()})
        SELECT
            f.id,
            f.media_id,
            f.idx,
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
        LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
        WHERE f.canonical_text_tsv @@ websearch_to_tsquery('english', :query)
          AND {transcript_media_filter}
        {scope_filter}
        ORDER BY score DESC, f.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        {
            "type": "fragment",
            "id": row[0],
            "fragment_idx": row[2],
            "source": {
                "media_id": row[1],
                "media_kind": row[3],
                "title": row[4],
                "authors": list(row[6]) if row[6] else [],
                "published_date": row[5],
            },
            "raw_score": float(row[7]) if row[7] else 0.0,
            "snippet": _truncate_snippet(row[8] or ""),
        }
        for row in rows
    ]


def _search_annotations(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[dict]:
    """Search annotation body with s4 highlight visibility filtering.

    An annotation is visible iff:
    - Anchor media is in the visible-media CTE (s4 provenance), AND
    - Viewer and highlight author share at least one library containing
      the anchor media (library intersection check).
    """
    scope_filter = ""
    transcript_media_filter = transcript_media_searchable_sql("m")
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "media":
        scope_filter = "AND f.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND f.media_id IN (
                SELECT media_id FROM library_media WHERE library_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        return []

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
        JOIN fragments f ON f.id = h.fragment_id
        JOIN media m ON m.id = f.media_id
        JOIN visible_media vm ON vm.media_id = f.media_id
        LEFT JOIN media_authors_agg maa ON maa.media_id = m.id
        WHERE a.body_tsv @@ websearch_to_tsquery('english', :query)
          AND {transcript_media_filter}
          AND EXISTS (
              SELECT 1
              FROM library_media lm_ann
              JOIN memberships vm_ann ON vm_ann.library_id = lm_ann.library_id
                                      AND vm_ann.user_id = :viewer_id
              JOIN memberships am_ann ON am_ann.library_id = lm_ann.library_id
                                      AND am_ann.user_id = h.user_id
              WHERE lm_ann.media_id = f.media_id
          )
        {scope_filter}
        ORDER BY score DESC, a.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        {
            "type": "annotation",
            "id": row[0],
            "highlight_id": row[1],
            "fragment_id": row[3],
            "fragment_idx": row[4],
            "highlight": {
                "exact": row[5],
                "prefix": row[6],
                "suffix": row[7],
            },
            "annotation_body": row[8],
            "source": {
                "media_id": row[2],
                "media_kind": row[9],
                "title": row[10],
                "authors": list(row[12]) if row[12] else [],
                "published_date": row[11],
            },
            "raw_score": float(row[13]) if row[13] else 0.0,
            "snippet": _truncate_snippet(row[14] or ""),
        }
        for row in rows
    ]


def _search_messages(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[dict]:
    """Search message content with visibility filtering.

    Message visibility follows conversation visibility (canonical s4 CTE).
    Pending messages are never searchable.

    Library scope includes only messages from conversations actively shared
    to the target library (sharing='library' + share row to scope library).
    Owner/public conversations not shared to the target library are excluded.
    """
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "media":
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
        {
            "type": "message",
            "id": row[0],
            "conversation_id": row[1],
            "seq": row[2],
            "raw_score": float(row[3]) if row[3] else 0.0,
            "snippet": _truncate_snippet(row[4] or ""),
        }
        for row in rows
    ]


def _normalize_scores_by_type(results: list[dict]) -> None:
    """Normalize weighted scores within each type to [0, 1] range.

    Modifies results in place, adding 'normalized_score' field.
    """
    # Group by type
    by_type: dict[str, list[dict]] = {}
    for r in results:
        by_type.setdefault(r["type"], []).append(r)

    # Normalize each type
    for type_results in by_type.values():
        if not type_results:
            continue

        max_score = max(r["weighted_score"] for r in type_results)
        min_score = min(r["weighted_score"] for r in type_results)

        if max_score == min_score:
            # All same score -> all get 1.0 (or 0.5 if zero)
            norm_value = 1.0 if max_score > 0 else 0.5
            for r in type_results:
                r["normalized_score"] = norm_value
        else:
            for r in type_results:
                r["normalized_score"] = (r["weighted_score"] - min_score) / (max_score - min_score)


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


def _result_to_out(result: dict) -> SearchResultOut:
    """Convert internal result dict to a strict v2 discriminated union result."""
    base_payload = {
        "id": result["id"],
        "score": round(result["normalized_score"], 4),
        "snippet": result["snippet"],
    }
    result_type = result["type"]

    if result_type == "media":
        return SearchResultMediaOut(
            type="media",
            source=SearchResultSourceOut.model_validate(result["source"]),
            **base_payload,
        )

    if result_type == "fragment":
        return SearchResultFragmentOut(
            type="fragment",
            fragment_idx=result["fragment_idx"],
            source=SearchResultSourceOut.model_validate(result["source"]),
            **base_payload,
        )

    if result_type == "annotation":
        return SearchResultAnnotationOut(
            type="annotation",
            highlight_id=result["highlight_id"],
            fragment_id=result["fragment_id"],
            fragment_idx=result["fragment_idx"],
            annotation_body=result["annotation_body"],
            highlight=SearchResultHighlightOut.model_validate(result["highlight"]),
            source=SearchResultSourceOut.model_validate(result["source"]),
            **base_payload,
        )

    if result_type == "message":
        return SearchResultMessageOut(
            type="message",
            conversation_id=result["conversation_id"],
            seq=result["seq"],
            **base_payload,
        )

    raise InvalidRequestError(
        ApiErrorCode.E_INVALID_REQUEST, f"Unknown search result type: {result_type}"
    )


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
