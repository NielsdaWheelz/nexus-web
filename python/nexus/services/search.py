"""Search service layer.

Implements keyword search across all user-visible content using PostgreSQL
full-text search for Slice 3, PR-06.

Search enforces strict visibility guarantees:
- Media/fragments: visible if in any library where viewer is a member
- Annotations: owner-only in S3 + media visible via library membership
- Messages: visible if conversation is visible (owner, public, or library-shared)

Key design decisions:
- Visibility filtering occurs inside SQL via CTEs, not post-filter
- Snippet generation happens only on filtered rows
- No raw queries logged (only hash for debugging)
- Ranking uses ts_rank_cd with type-specific multipliers
"""

import base64
import hashlib
import json
import time
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, is_library_member
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.search import SearchPageInfo, SearchResponse, SearchResultOut
from nexus.services.conversations import get_conversation_for_owner_write_or_404

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
        # Uses owner-write helper for scope auth (behavior change deferred to pr-08)
        get_conversation_for_owner_write_or_404(db, viewer_id, scope_id)


# =============================================================================
# Visibility CTEs
# =============================================================================


def visible_media_ids_cte_sql() -> str:
    """Return SQL for CTE that selects media IDs visible to viewer.

    Requires :viewer_id parameter.
    Returns media_id column.
    """
    return """
        SELECT DISTINCT lm.media_id
        FROM library_media lm
        JOIN memberships m ON m.library_id = lm.library_id
        WHERE m.user_id = :viewer_id
    """


def visible_conversation_ids_cte_sql() -> str:
    """Return SQL for CTE that selects conversation IDs visible to viewer.

    Requires :viewer_id parameter.
    Returns conversation_id column.

    A conversation is visible iff:
    - owner_user_id = viewer_id, OR
    - sharing = 'public', OR
    - sharing = 'library' AND exists conversation_share to a library
      where viewer is a member
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
        JOIN memberships m ON m.library_id = cs.library_id
        WHERE c.sharing = 'library' AND m.user_id = :viewer_id
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

    # Normalize types (filter unknowns, use all if empty)
    valid_types = {"media", "fragment", "annotation", "message"}
    if types:
        types = [t for t in types if t in valid_types]
    if not types:
        types = list(valid_types)

    # Decode cursor
    offset = 0
    if cursor:
        offset = decode_search_cursor(cursor)

    # Execute search queries per type and collect results
    all_results: list[dict] = []

    for result_type in types:
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

    _log_search(viewer_id, q, scope, types, len(results), start_time)

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
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT
            m.id,
            m.title,
            ts_rank_cd(m.title_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', m.title, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        WHERE m.title_tsv @@ websearch_to_tsquery('english', :query)
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
            "title": row[1],
            "raw_score": float(row[2]) if row[2] else 0.0,
            "snippet": _truncate_snippet(row[3] or row[1]),
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
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT
            f.id,
            f.media_id,
            f.idx,
            ts_rank_cd(f.canonical_text_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', f.canonical_text, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM fragments f
        JOIN visible_media vm ON vm.media_id = f.media_id
        WHERE f.canonical_text_tsv @@ websearch_to_tsquery('english', :query)
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
            "media_id": row[1],
            "idx": row[2],
            "raw_score": float(row[3]) if row[3] else 0.0,
            "snippet": _truncate_snippet(row[4] or ""),
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
    """Search annotation body with visibility filtering.

    In S3, annotations are owner-only: annotation.user_id = viewer_user_id
    AND media is visible via library membership.
    """
    # Build scope filter
    scope_filter = ""
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
        # Annotation search doesn't apply to conversation scope
        return []

    query = f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT
            a.id,
            a.highlight_id,
            f.media_id,
            ts_rank_cd(a.body_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', a.body, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM annotations a
        JOIN highlights h ON h.id = a.highlight_id
        JOIN fragments f ON f.id = h.fragment_id
        JOIN visible_media vm ON vm.media_id = f.media_id
        WHERE a.body_tsv @@ websearch_to_tsquery('english', :query)
          AND h.user_id = :viewer_id  -- Owner-only in S3
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
            "media_id": row[2],
            "raw_score": float(row[3]) if row[3] else 0.0,
            "snippet": _truncate_snippet(row[4] or ""),
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

    Message visibility follows conversation visibility.
    Pending messages are never searchable.
    """
    # Build scope filter
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "media":
        # Message search doesn't apply to media scope
        return []
    elif scope_type == "library":
        # Message search doesn't apply to library scope in S3
        # (conversations are not shared to libraries via search in S3)
        return []
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
    """Convert internal result dict to SearchResultOut schema."""
    return SearchResultOut(
        type=result["type"],
        id=result["id"],
        score=round(result["normalized_score"], 4),
        snippet=result["snippet"],
        title=result.get("title"),
        media_id=result.get("media_id"),
        idx=result.get("idx"),
        highlight_id=result.get("highlight_id"),
        conversation_id=result.get("conversation_id"),
        seq=result.get("seq"),
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
        types_count=len(types) if types else 4,
        results_count=results_count,
        latency_ms=latency_ms,
        user_id=str(viewer_id),
    )
