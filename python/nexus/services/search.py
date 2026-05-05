"""Search service layer.

Implements keyword search across all user-visible content using PostgreSQL
full-text search.

Search enforces strict s4 visibility guarantees:
- Media/content chunks: visible via s4 provenance (non-default membership, default
  intrinsic, or active closure edge with source membership)
- Note blocks: visible if owned by the viewer
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
from nexus.schemas.contributors import ContributorCreditOut, ContributorOut
from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultContentChunkOut,
    SearchResultContextRefOut,
    SearchResultContributorOut,
    SearchResultMediaOut,
    SearchResultMessageOut,
    SearchResultNoteBlockOut,
    SearchResultOut,
    SearchResultPageOut,
    SearchResultPodcastOut,
    SearchResultResolverOut,
    SearchResultSourceOut,
)
from nexus.services.contributor_credits import normalize_contributor_role
from nexus.services.locator_resolver import resolve_evidence_span
from nexus.services.semantic_chunks import (
    build_text_embedding,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)

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
CONTENT_CHUNK_MIN_ANN_CANDIDATES = 200
CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER = 20

# Supported search result types (ordered for deterministic behavior).
# Omitted type filters must mean "search everything the caller can ask for".
ALL_RESULT_TYPES = (
    "media",
    "podcast",
    "content_chunk",
    "contributor",
    "page",
    "note_block",
    "message",
)
VALID_RESULT_TYPES = frozenset(ALL_RESULT_TYPES)

# Type weight multipliers (applied post-rank)
TYPE_WEIGHTS = {
    "media": 1.3,
    "podcast": 1.15,
    "content_chunk": 1.1,
    "contributor": 1.25,
    "page": 1.2,
    "note_block": 1.2,
    "message": 1.0,
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
    contributors: list[ContributorCreditOut]
    snippet: str
    score: _SearchScore
    result_type: Literal["podcast"] = "podcast"


@dataclass(slots=True)
class _RankedNoteBlockResult:
    id: UUID
    snippet: str
    page_id: UUID
    page_title: str
    body_text: str
    score: _SearchScore
    result_type: Literal["note_block"] = "note_block"


@dataclass(slots=True)
class _RankedPageResult:
    id: UUID
    title: str
    description: str | None
    snippet: str
    score: _SearchScore
    result_type: Literal["page"] = "page"


@dataclass(slots=True)
class _RankedMessageResult:
    id: UUID
    snippet: str
    conversation_id: UUID
    seq: int
    score: _SearchScore
    result_type: Literal["message"] = "message"


@dataclass(slots=True)
class _RankedContentChunkResult:
    id: UUID
    snippet: str
    source_kind: str
    evidence_span_ids: list[UUID]
    citation_label: str
    resolver: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["content_chunk"] = "content_chunk"


@dataclass(slots=True)
class _RankedContributorResult:
    id: str
    handle: str
    contributor: ContributorOut
    snippet: str
    score: _SearchScore
    result_type: Literal["contributor"] = "contributor"


InternalSearchResult = (
    _RankedMediaResult
    | _RankedPodcastResult
    | _RankedContentChunkResult
    | _RankedContributorResult
    | _RankedPageResult
    | _RankedNoteBlockResult
    | _RankedMessageResult
)


def _build_search_score(raw_score: Any) -> _SearchScore:
    return _SearchScore(raw=float(raw_score) if raw_score else 0.0)


def _build_search_source(
    media_id: UUID,
    media_kind: str,
    title: str,
    contributors: Any,
    published_date: Any,
) -> SearchResultSourceOut:
    parsed_contributors = _parse_contributor_credits(contributors)
    return SearchResultSourceOut(
        media_id=media_id,
        media_kind=media_kind,
        title=title,
        contributors=parsed_contributors,
        published_date=str(published_date) if published_date is not None else None,
    )


def _parse_contributor_credits(value: Any) -> list[ContributorCreditOut]:
    if not value:
        return []
    return [ContributorCreditOut.model_validate(item) for item in list(value)]


def _parse_contributor(value: Any) -> ContributorOut:
    return ContributorOut.model_validate(dict(value or {}))


def _credited_names(contributors: list[ContributorCreditOut]) -> list[str]:
    names: list[str] = []
    for credit in contributors:
        credited_name = getattr(credit, "credited_name", None)
        if isinstance(credited_name, str) and credited_name:
            names.append(credited_name)
            continue
        contributor = getattr(credit, "contributor", None)
        display_name = getattr(contributor, "display_name", None)
        if isinstance(display_name, str) and display_name:
            names.append(display_name)
    return names


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


def _normalize_contributor_handles(contributor_handles: list[str] | None) -> list[str]:
    if contributor_handles is None:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_handle in contributor_handles:
        handle = str(raw_handle or "").strip()
        if not handle or handle in seen:
            continue
        normalized.append(handle)
        seen.add(handle)
    return normalized


def _normalize_credit_roles(roles: list[str] | None) -> list[str]:
    if roles is None:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_role in roles:
        role_text = str(raw_role or "").strip()
        if not role_text:
            continue
        role = normalize_contributor_role(role_text)
        if role not in seen:
            normalized.append(role)
            seen.add(role)
    return normalized


def _normalize_content_kinds(content_kinds: list[str] | None) -> list[str]:
    if content_kinds is None:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_kind in content_kinds:
        kind = str(raw_kind or "").strip()
        if not kind or kind in seen:
            continue
        normalized.append(kind)
        seen.add(kind)
    return normalized


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


def media_contributor_credits_rollup_cte_sql() -> str:
    """Return SQL for CTE that pre-aggregates contributor credits per media row."""
    return """
        SELECT
            cc.media_id,
            jsonb_agg(
                jsonb_build_object(
                    'id', cc.id,
                    'credited_name', cc.credited_name,
                    'role', cc.role,
                    'raw_role', cc.raw_role,
                    'ordinal', cc.ordinal,
                    'source', cc.source,
                    'contributor_handle', c.handle,
                    'contributor_display_name', c.display_name,
                    'href', '/authors/' || c.handle,
                    'contributor', jsonb_build_object(
                        'handle', c.handle,
                        'display_name', c.display_name,
                        'sort_name', c.sort_name,
                        'kind', c.kind,
                        'status', c.status,
                        'disambiguation', c.disambiguation
                    )
                )
                ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_credits,
            string_agg(
                concat_ws(
                    ' ',
                    cc.credited_name,
                    c.display_name,
                    COALESCE(alias_text.aliases, ''),
                    COALESCE(external_id_text.external_ids, '')
                ),
                ' '
            ) AS contributor_search_text
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN (
            SELECT contributor_id, string_agg(alias, ' ') AS aliases
            FROM contributor_aliases
            GROUP BY contributor_id
        ) alias_text ON alias_text.contributor_id = c.id
        LEFT JOIN (
            SELECT contributor_id, string_agg(external_key, ' ') AS external_ids
            FROM contributor_external_ids
            GROUP BY contributor_id
        ) external_id_text ON external_id_text.contributor_id = c.id
        WHERE cc.media_id IS NOT NULL
          AND c.status NOT IN ('merged', 'tombstoned')
        GROUP BY cc.media_id
    """


def podcast_contributor_credits_rollup_cte_sql() -> str:
    """Return SQL for CTE that pre-aggregates contributor credits per podcast row."""
    return """
        SELECT
            cc.podcast_id,
            jsonb_agg(
                jsonb_build_object(
                    'id', cc.id,
                    'credited_name', cc.credited_name,
                    'role', cc.role,
                    'raw_role', cc.raw_role,
                    'ordinal', cc.ordinal,
                    'source', cc.source,
                    'contributor_handle', c.handle,
                    'contributor_display_name', c.display_name,
                    'href', '/authors/' || c.handle,
                    'contributor', jsonb_build_object(
                        'handle', c.handle,
                        'display_name', c.display_name,
                        'sort_name', c.sort_name,
                        'kind', c.kind,
                        'status', c.status,
                        'disambiguation', c.disambiguation
                    )
                )
                ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_credits,
            string_agg(
                concat_ws(
                    ' ',
                    cc.credited_name,
                    c.display_name,
                    COALESCE(alias_text.aliases, ''),
                    COALESCE(external_id_text.external_ids, '')
                ),
                ' '
            ) AS contributor_search_text
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN (
            SELECT contributor_id, string_agg(alias, ' ') AS aliases
            FROM contributor_aliases
            GROUP BY contributor_id
        ) alias_text ON alias_text.contributor_id = c.id
        LEFT JOIN (
            SELECT contributor_id, string_agg(external_key, ' ') AS external_ids
            FROM contributor_external_ids
            GROUP BY contributor_id
        ) external_id_text ON external_id_text.contributor_id = c.id
        WHERE cc.podcast_id IS NOT NULL
          AND c.status NOT IN ('merged', 'tombstoned')
        GROUP BY cc.podcast_id
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
    contributor_handles: list[str] | None = None,
    roles: list[str] | None = None,
    content_kinds: list[str] | None = None,
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
        types: List of types to search.
        contributor_handles: Contributor handles used to filter credited content.
        roles: Contributor credit roles used to filter credited content.
        content_kinds: Media/content kinds used to filter credited content.
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

    q = q.strip()
    normalized_types = _normalize_result_types(types)
    normalized_contributor_handles = _normalize_contributor_handles(contributor_handles)
    normalized_roles = _normalize_credit_roles(roles)
    normalized_content_kinds = _normalize_content_kinds(content_kinds)
    has_query = len(q) >= MIN_QUERY_LENGTH
    has_structured_filter = bool(
        normalized_contributor_handles or normalized_roles or normalized_content_kinds
    )
    if not has_query and not has_structured_filter:
        _log_search(viewer_id, q, scope, types, 0, start_time)
        return SearchResponse()

    # Parse and authorize scope
    scope_type, scope_id = parse_scope(scope)
    authorize_scope(db, viewer_id, scope_type, scope_id)

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
            has_query,
            result_type,
            semantic,
            scope_type,
            scope_id,
            normalized_contributor_handles,
            normalized_roles,
            normalized_content_kinds,
            CANDIDATES_PER_TYPE,
        )
        all_results.extend(type_results)

    # Compute weighted scores
    for result in all_results:
        result.score.weighted = result.score.raw * TYPE_WEIGHTS[result.result_type]

    # Normalize scores within each type to [0, 1]
    _normalize_scores_by_type(all_results)

    # Sort by normalized_score DESC, then by id ASC for determinism
    all_results.sort(
        key=lambda result: (
            -result.score.normalized,
            result.handle if isinstance(result, _RankedContributorResult) else str(result.id),
        )
    )

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
    has_query: bool,
    result_type: str,
    semantic: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search a specific content type with visibility filtering.

    Returns list of dicts with raw results (not yet normalized).
    """
    if result_type == "media":
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "podcast":
        return _search_podcasts(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "content_chunk":
        return _search_content_chunks(
            db,
            viewer_id,
            q,
            semantic,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "contributor":
        return _search_contributors(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "page":
        if contributor_handles or roles or content_kinds:
            return []
        return _search_pages(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "note_block":
        if contributor_handles or roles or content_kinds:
            return []
        return _search_note_blocks(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "message":
        if contributor_handles or roles or content_kinds:
            return []
        return _search_messages(db, viewer_id, q, scope_type, scope_id, limit)
    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}")


def _search_media(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search media titles with visibility filtering."""
    # Build scope filter
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "has_query": has_query, "limit": limit}
    content_kind_filter = ""
    contributor_credit_filter = ""

    if content_kinds:
        content_kind_filter = "AND m.kind = ANY(:content_kinds)"
        params["content_kinds"] = content_kinds

    if contributor_handles or roles:
        credit_clauses = ["cc_filter.media_id = m.id"]
        if contributor_handles:
            credit_clauses.append("c_filter.handle = ANY(:contributor_handles)")
            params["contributor_handles"] = contributor_handles
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                JOIN contributors c_filter ON c_filter.id = cc_filter.contributor_id
                WHERE {" AND ".join(credit_clauses)}
                  AND c_filter.status NOT IN ('merged', 'tombstoned')
            )
        """

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
            media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
        SELECT
            m.id,
            m.title,
            m.kind,
            m.published_date,
            mcc.contributor_credits,
            CASE WHEN :has_query THEN ts_rank_cd(
                to_tsvector(
                    'english',
                    concat_ws(
                        ' ',
                        m.title,
                        COALESCE(m.description, ''),
                        COALESCE(m.publisher, ''),
                        COALESCE(mcc.contributor_search_text, '')
                    )
                ),
                websearch_to_tsquery('english', :query)
            ) ELSE 0.0 END AS score,
            CASE WHEN :has_query THEN ts_headline('english',
                        concat_ws(
                            ' ',
                            m.title,
                            COALESCE(m.description, ''),
                            COALESCE(m.publisher, ''),
                            COALESCE(mcc.contributor_search_text, '')
                        ),
                        websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1')
                 ELSE m.title END AS snippet
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
        WHERE (:has_query IS FALSE OR to_tsvector(
                'english',
                concat_ws(
                    ' ',
                    m.title,
                    COALESCE(m.description, ''),
                    COALESCE(m.publisher, ''),
                    COALESCE(mcc.contributor_search_text, '')
                )
            ) @@ websearch_to_tsquery('english', :query))
        {scope_filter}
        {content_kind_filter}
        {contributor_credit_filter}
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
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search visible podcast metadata."""
    if content_kinds and "podcast" not in content_kinds and "podcasts" not in content_kinds:
        return []

    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "has_query": has_query, "limit": limit}
    contributor_credit_filter = ""

    if contributor_handles or roles:
        credit_clauses = ["cc_filter.podcast_id = p.id"]
        if contributor_handles:
            credit_clauses.append("c_filter.handle = ANY(:contributor_handles)")
            params["contributor_handles"] = contributor_handles
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                JOIN contributors c_filter ON c_filter.id = cc_filter.contributor_id
                WHERE {" AND ".join(credit_clauses)}
                  AND c_filter.status NOT IN ('merged', 'tombstoned')
            )
        """

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
        ),
        podcast_contributor_credits AS ({podcast_contributor_credits_rollup_cte_sql()})
        SELECT
            p.id,
            p.title,
            pcc.contributor_credits,
            CASE WHEN :has_query THEN ts_rank_cd(
                to_tsvector(
                    'english',
                    concat_ws(
                        ' ',
                        p.title,
                        COALESCE(p.description, ''),
                        COALESCE(pcc.contributor_search_text, '')
                    )
                ),
                websearch_to_tsquery('english', :query)
            ) ELSE 0.0 END AS score,
            CASE WHEN :has_query THEN ts_headline(
                'english',
                concat_ws(
                    ' ',
                    p.title,
                    COALESCE(p.description, ''),
                    COALESCE(pcc.contributor_search_text, '')
                ),
                websearch_to_tsquery('english', :query),
                'MaxWords=50, MinWords=10, MaxFragments=1'
            ) ELSE p.title END AS snippet
        FROM podcasts p
        JOIN visible_podcasts vp ON vp.podcast_id = p.id
        LEFT JOIN podcast_contributor_credits pcc ON pcc.podcast_id = p.id
        WHERE (:has_query IS FALSE OR to_tsvector(
                'english',
                concat_ws(
                    ' ',
                    p.title,
                    COALESCE(p.description, ''),
                    COALESCE(pcc.contributor_search_text, '')
                )
            ) @@ websearch_to_tsquery('english', :query))
        {scope_filter}
        {contributor_credit_filter}
        ORDER BY score DESC, p.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    results: list[InternalSearchResult] = []
    for row in rows:
        contributors = _parse_contributor_credits(row[2])
        results.append(
            _RankedPodcastResult(
                id=row[0],
                title=row[1],
                contributors=contributors,
                snippet=_truncate_snippet(str(row[4] or row[1])),
                score=_build_search_score(row[3]),
            )
        )
    return results


def _search_content_chunks(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic: bool,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search active content chunks with lexical or hybrid semantic ranking."""
    semantic = semantic and has_query
    scope_filter = ""
    embedding_dims = transcript_embedding_dimensions()
    ann_limit = max(
        CONTENT_CHUNK_MIN_ANN_CANDIDATES,
        int(limit) * CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    )
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "query": q,
        "has_query": has_query,
        "limit": limit,
        "ann_limit": ann_limit,
    }
    content_kind_filter = ""
    contributor_credit_filter = ""
    if content_kinds:
        content_kind_filter = "AND m.kind = ANY(:content_kinds)"
        params["content_kinds"] = content_kinds
    if contributor_handles or roles:
        credit_clauses = ["cc_filter.media_id = m.id"]
        if contributor_handles:
            credit_clauses.append("c_filter.handle = ANY(:contributor_handles)")
            params["contributor_handles"] = contributor_handles
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                JOIN contributors c_filter ON c_filter.id = cc_filter.contributor_id
                WHERE {" AND ".join(credit_clauses)}
                  AND c_filter.status NOT IN ('merged', 'tombstoned')
            )
        """
    semantic_select = "0.0 AS semantic_similarity"
    semantic_join = ""
    semantic_order = "lexical_score DESC, cc.id ASC"
    semantic_where = (
        "(:has_query IS FALSE OR cc.chunk_text_tsv @@ websearch_to_tsquery('english', :query))"
    )
    if semantic:
        try:
            embedding_model, query_embedding = build_text_embedding(q)
        except Exception as exc:
            logger.warning(
                "semantic_query_embedding_failed",
                error=str(exc),
                query_hash=hash_query(q),
                user_id=str(viewer_id),
            )
            semantic = False
        else:
            if len(query_embedding) != embedding_dims:
                logger.warning(
                    "semantic_query_embedding_dimension_mismatch",
                    expected_dimensions=embedding_dims,
                    actual_dimensions=len(query_embedding),
                    embedding_model=embedding_model,
                    query_hash=hash_query(q),
                    user_id=str(viewer_id),
                )
                semantic = False
    if semantic:
        params["query_embedding"] = to_pgvector_literal(query_embedding)
        semantic_join = f"""
            JOIN query_embedding qe ON true
            JOIN content_embeddings ce ON ce.chunk_id = cc.id
                AND ce.embedding_provider = mcis.active_embedding_provider
                AND ce.embedding_model = mcis.active_embedding_model
                AND ce.embedding_version = mcis.active_embedding_version
                AND ce.embedding_config_hash = mcis.active_embedding_config_hash
                AND ce.embedding_dimensions = {embedding_dims}
        """
        semantic_select = "(1 - (ce.embedding_vector <=> qe.embedding)) AS semantic_similarity"
        semantic_order = "ce.embedding_vector <=> qe.embedding ASC, cc.id ASC"
        semantic_where = "TRUE"

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

    query_embedding_cte = ""
    if semantic:
        query_embedding_cte = f"""
            query_embedding AS (
                SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
            ),
        """

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()}),
            {query_embedding_cte}
            ann_candidates AS (
                SELECT
                    cc.id,
                    cc.media_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    cc.chunk_text,
                    CASE WHEN :has_query THEN ts_headline(
                        'english',
                        cc.chunk_text,
                        websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1'
                    ) ELSE left(cc.chunk_text, 300) END AS snippet,
                    cc.source_kind,
                    cc.primary_evidence_span_id,
                    cc.index_run_id,
                    cc.summary_locator,
                    cc.created_at,
                    {semantic_select},
                    CASE WHEN :has_query THEN
                        ts_rank_cd(cc.chunk_text_tsv, websearch_to_tsquery('english', :query))
                    ELSE 0.0 END AS lexical_score
                FROM content_chunks cc
                JOIN media m ON m.id = cc.media_id
                JOIN visible_media vm ON vm.media_id = cc.media_id
                JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                    AND mcis.active_run_id = cc.index_run_id
                JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                    AND active_run.state = 'ready'
                    AND active_run.deactivated_at IS NULL
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                {semantic_join}
                WHERE {semantic_where}
                {scope_filter}
                {content_kind_filter}
                {contributor_credit_filter}
                ORDER BY {semantic_order}
                LIMIT :ann_limit
            )
        SELECT
            id,
            media_id,
            kind,
            title,
            published_date,
            contributor_credits,
            chunk_text,
            snippet,
            source_kind,
            primary_evidence_span_id,
            index_run_id,
            summary_locator,
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
        WHERE :has_query IS FALSE OR semantic_similarity > 0.0 OR lexical_score > 0.0
        ORDER BY raw_score DESC, id ASC
        LIMIT :limit
    """
    if semantic:
        probes = max(10, min(100, ann_limit))
        try:
            db.execute(text(f"SET LOCAL ivfflat.probes = {probes}"))
        except Exception:
            db.rollback()
    rows = db.execute(text(query), params).fetchall()
    if semantic and not rows:
        return _search_content_chunks(
            db,
            viewer_id,
            q,
            False,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            content_kinds,
            limit,
        )
    results: list[InternalSearchResult] = []
    for row in rows:
        if row[9] is None:
            continue
        try:
            resolution = resolve_evidence_span(
                db,
                viewer_id=viewer_id,
                media_id=row[1],
                evidence_span_id=row[9],
                index_run_id=row[10],
            )
        except NotFoundError:
            continue
        evidence_span_ids = [row[9]] if row[9] is not None else []
        results.append(
            _RankedContentChunkResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[7] or row[6] or "")),
                source_kind=str(row[8]),
                evidence_span_ids=evidence_span_ids,
                citation_label=str(resolution["citation_label"]),
                resolver=dict(resolution["resolver"]),
                source=_build_search_source(row[1], row[2], row[3], row[5], row[4]),
                score=_build_search_score(row[12]),
            )
        )
    return results


def _search_contributors(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search contributor identities by display name, aliases, credits, and external IDs."""
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "query": q,
        "has_query": has_query,
        "limit": limit,
    }
    handle_filter = ""
    credit_filter = ""
    scope_credit_filter = ""

    if contributor_handles:
        handle_filter = "AND c.handle = ANY(:contributor_handles)"
        params["contributor_handles"] = contributor_handles

    if roles or content_kinds:
        credit_clauses = ["cc_filter.contributor_id = c.id"]
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        if content_kinds:
            credit_clauses.append(
                """
                (
                    EXISTS (
                        SELECT 1
                        FROM media m_filter
                        WHERE m_filter.id = cc_filter.media_id
                          AND m_filter.kind = ANY(:content_kinds)
                    )
                    OR (
                        ('podcast' = ANY(:content_kinds) OR 'podcasts' = ANY(:content_kinds))
                        AND cc_filter.podcast_id IS NOT NULL
                    )
                    OR (
                        (
                            'project_gutenberg' = ANY(:content_kinds)
                            OR 'gutenberg' = ANY(:content_kinds)
                        )
                        AND cc_filter.project_gutenberg_catalog_ebook_id IS NOT NULL
                    )
                )
                """
            )
            params["content_kinds"] = content_kinds
        credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM visible_scoped_credits cc_filter
                WHERE {" AND ".join(credit_clauses)}
            )
        """

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_credit_filter = "AND cc.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_credit_filter = """
            AND (
                cc.media_id IN (
                    SELECT media_id
                    FROM library_entries
                    WHERE library_id = :scope_id
                      AND media_id IS NOT NULL
                )
                OR cc.podcast_id IN (
                    SELECT podcast_id
                    FROM library_entries
                    WHERE library_id = :scope_id
                      AND podcast_id IS NOT NULL
                )
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_credit_filter = """
            AND (
                cc.media_id IN (
                    SELECT media_id
                    FROM conversation_media
                    WHERE conversation_id = :scope_id
                )
                OR cc.podcast_id IN (
                    SELECT pe.podcast_id
                    FROM conversation_media cm
                    JOIN podcast_episodes pe ON pe.media_id = cm.media_id
                    WHERE cm.conversation_id = :scope_id
                )
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            visible_podcasts AS (
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
            ),
            alias_text AS (
                SELECT contributor_id, string_agg(alias, ' ') AS aliases
                FROM contributor_aliases
                GROUP BY contributor_id
            ),
            external_id_text AS (
                SELECT contributor_id, string_agg(external_key, ' ') AS external_ids
                FROM contributor_external_ids
                GROUP BY contributor_id
            ),
            visible_scoped_credits AS (
                SELECT cc.*
                FROM contributor_credits cc
                WHERE (
                        EXISTS (
                            SELECT 1
                            FROM visible_media vm
                            WHERE vm.media_id = cc.media_id
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM visible_podcasts vp
                            WHERE vp.podcast_id = cc.podcast_id
                        )
                        OR cc.project_gutenberg_catalog_ebook_id IS NOT NULL
                  )
                {scope_credit_filter}
            ),
            visible_contributors AS (
                SELECT DISTINCT contributor_id
                FROM visible_scoped_credits
            ),
            credit_text AS (
                SELECT contributor_id, string_agg(credited_name, ' ') AS credited_names
                FROM visible_scoped_credits
                GROUP BY contributor_id
            )
        SELECT
            c.handle,
            jsonb_build_object(
                'handle', c.handle,
                'display_name', c.display_name,
                'sort_name', c.sort_name,
                'kind', c.kind,
                'status', c.status,
                'disambiguation', c.disambiguation
            ) AS contributor,
            CASE WHEN :has_query THEN ts_rank_cd(
                to_tsvector(
                    'english',
                    concat_ws(
                        ' ',
                        c.display_name,
                        COALESCE(c.sort_name, ''),
                        COALESCE(c.disambiguation, ''),
                        COALESCE(alias_text.aliases, ''),
                        COALESCE(external_id_text.external_ids, ''),
                        COALESCE(credit_text.credited_names, '')
                    )
                ),
                websearch_to_tsquery('english', :query)
            ) ELSE 0.0 END AS score,
            CASE WHEN :has_query THEN ts_headline(
                'english',
                concat_ws(
                    ' ',
                    c.display_name,
                    COALESCE(c.sort_name, ''),
                    COALESCE(c.disambiguation, ''),
                    COALESCE(alias_text.aliases, ''),
                    COALESCE(external_id_text.external_ids, ''),
                    COALESCE(credit_text.credited_names, '')
                ),
                websearch_to_tsquery('english', :query),
                'MaxWords=50, MinWords=10, MaxFragments=1'
            ) ELSE c.display_name END AS snippet
        FROM contributors c
        LEFT JOIN alias_text ON alias_text.contributor_id = c.id
        LEFT JOIN external_id_text ON external_id_text.contributor_id = c.id
        LEFT JOIN credit_text ON credit_text.contributor_id = c.id
        JOIN visible_contributors vc ON vc.contributor_id = c.id
        WHERE c.status NOT IN ('merged', 'tombstoned')
          AND (:has_query IS FALSE OR to_tsvector(
                'english',
                concat_ws(
                    ' ',
                    c.display_name,
                    COALESCE(c.sort_name, ''),
                    COALESCE(c.disambiguation, ''),
                    COALESCE(alias_text.aliases, ''),
                    COALESCE(external_id_text.external_ids, ''),
                    COALESCE(credit_text.credited_names, '')
                )
            ) @@ websearch_to_tsquery('english', :query))
        {handle_filter}
        {credit_filter}
        ORDER BY score DESC, c.handle ASC
        LIMIT :limit
    """

    rows = db.execute(text(query), params).fetchall()
    return [
        _RankedContributorResult(
            id=str(row[0]),
            handle=str(row[0]),
            contributor=_parse_contributor(row[1]),
            snippet=_truncate_snippet(str(row[3] or row[0])),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _search_pages(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = """
            AND EXISTS (
                SELECT 1
                FROM object_links ol
                LEFT JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                WHERE (
                        (ol.a_type = 'page' AND ol.a_id = p.id)
                     OR (ol.b_type = 'page' AND ol.b_id = p.id)
                )
                  AND (
                        (ol.a_type = 'media' AND ol.a_id = :scope_id)
                     OR (ol.b_type = 'media' AND ol.b_id = :scope_id)
                     OR h.anchor_media_id = :scope_id
                  )
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND EXISTS (
                SELECT 1
                FROM object_links ol
                LEFT JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                JOIN library_entries le
                  ON le.library_id = :scope_id
                 AND le.media_id IS NOT NULL
                 AND (
                        (ol.a_type = 'media' AND le.media_id = ol.a_id)
                     OR (ol.b_type = 'media' AND le.media_id = ol.b_id)
                     OR le.media_id = h.anchor_media_id
                 )
                WHERE (ol.a_type = 'page' AND ol.a_id = p.id)
                   OR (ol.b_type = 'page' AND ol.b_id = p.id)
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND (
                EXISTS (
                    SELECT 1
                    FROM message_context_items mci
                    JOIN messages msg ON msg.id = mci.message_id
                    WHERE mci.object_type = 'page'
                      AND mci.object_id = p.id
                      AND msg.conversation_id = :scope_id
                )
                OR EXISTS (
                    SELECT 1
                    FROM object_links ol
                    JOIN messages msg
                      ON (
                            (ol.a_type = 'message' AND msg.id = ol.a_id)
                         OR (ol.b_type = 'message' AND msg.id = ol.b_id)
                      )
                    WHERE ol.relation_type = 'used_as_context'
                      AND (
                            (ol.a_type = 'page' AND ol.a_id = p.id)
                         OR (ol.b_type = 'page' AND ol.b_id = p.id)
                      )
                      AND msg.conversation_id = :scope_id
                )
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        SELECT
            p.id,
            p.title,
            p.description,
            ts_rank_cd(
                to_tsvector('english', concat_ws(' ', p.title, COALESCE(p.description, ''))),
                websearch_to_tsquery('english', :query)
            ) AS score,
            ts_headline(
                'english',
                concat_ws(' ', p.title, COALESCE(p.description, '')),
                websearch_to_tsquery('english', :query),
                'MaxWords=50, MinWords=5, MaxFragments=1'
            ) AS snippet
        FROM pages p
        WHERE p.user_id = :viewer_id
          AND to_tsvector('english', concat_ws(' ', p.title, COALESCE(p.description, '')))
              @@ websearch_to_tsquery('english', :query)
        {scope_filter}
        ORDER BY score DESC, p.id ASC
        LIMIT :limit
    """
    rows = db.execute(text(query), params).fetchall()
    return [
        _RankedPageResult(
            id=row[0],
            title=row[1],
            description=row[2],
            snippet=_truncate_snippet(str(row[4] or row[1])),
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]


def _search_note_blocks(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search user-owned note blocks."""
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    if scope_type == "all":
        pass
    elif scope_type == "media":
        scope_filter = """
            AND EXISTS (
                SELECT 1
                FROM object_links ol
                LEFT JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                WHERE (
                        (ol.a_type = 'note_block' AND ol.a_id = nb.id)
                     OR (ol.b_type = 'note_block' AND ol.b_id = nb.id)
                  )
                  AND (
                        (ol.a_type = 'media' AND ol.a_id = :scope_id)
                        OR (ol.b_type = 'media' AND ol.b_id = :scope_id)
                        OR h.anchor_media_id = :scope_id
                  )
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND EXISTS (
                SELECT 1
                FROM object_links ol
                LEFT JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                JOIN library_entries le ON le.library_id = :scope_id
                                       AND le.media_id IS NOT NULL
                                       AND (
                                            (ol.a_type = 'media' AND le.media_id = ol.a_id)
                                            OR (ol.b_type = 'media' AND le.media_id = ol.b_id)
                                            OR le.media_id = h.anchor_media_id
                                       )
                WHERE (ol.a_type = 'note_block' AND ol.a_id = nb.id)
                   OR (ol.b_type = 'note_block' AND ol.b_id = nb.id)
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND (
                EXISTS (
                    SELECT 1
                    FROM message_context_items mci
                    JOIN messages msg ON msg.id = mci.message_id
                    WHERE mci.object_type = 'note_block'
                      AND mci.object_id = nb.id
                      AND msg.conversation_id = :scope_id
                )
                OR EXISTS (
                    SELECT 1
                    FROM object_links ol
                    JOIN messages msg
                      ON (
                            (ol.a_type = 'message' AND msg.id = ol.a_id)
                         OR (ol.b_type = 'message' AND msg.id = ol.b_id)
                      )
                    WHERE ol.relation_type = 'used_as_context'
                      AND (
                            (ol.a_type = 'note_block' AND ol.a_id = nb.id)
                         OR (ol.b_type = 'note_block' AND ol.b_id = nb.id)
                      )
                      AND msg.conversation_id = :scope_id
                )
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    query = f"""
        SELECT
            nb.id,
            nb.page_id,
            p.title,
            nb.body_text,
            ts_rank_cd(to_tsvector('english', nb.body_text), websearch_to_tsquery('english', :query)) AS score,
            COALESCE(
                (
                    SELECT NULLIF(h.exact, '')
                    FROM object_links ol
                    JOIN highlights h
                      ON (
                            (ol.a_type = 'highlight' AND h.id = ol.a_id)
                         OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                      )
                    WHERE (
                            (ol.a_type = 'note_block' AND ol.a_id = nb.id)
                         OR (ol.b_type = 'note_block' AND ol.b_id = nb.id)
                    )
                      AND ol.relation_type = 'note_about'
                    ORDER BY ol.created_at ASC, ol.id ASC
                    LIMIT 1
                ),
                ts_headline('english', nb.body_text, websearch_to_tsquery('english', :query),
                            'MaxWords=50, MinWords=10, MaxFragments=1')
            ) AS snippet
        FROM note_blocks nb
        JOIN pages p ON p.id = nb.page_id
        WHERE nb.user_id = :viewer_id
          AND to_tsvector('english', nb.body_text) @@ websearch_to_tsquery('english', :query)
        {scope_filter}
        ORDER BY score DESC, nb.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedNoteBlockResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[5] or "")),
            page_id=row[1],
            page_title=row[2],
            body_text=row[3],
            score=_build_search_score(row[4]),
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
    credited_names = _credited_names(source.contributors)
    if credited_names:
        parts.append(", ".join(credited_names))
    if source.published_date:
        parts.append(source.published_date)
    if source.media_kind:
        parts.append(source.media_kind.replace("_", " "))
    return " - ".join(part for part in parts if part)


def _result_context_ref(result: InternalSearchResult) -> SearchResultContextRefOut:
    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContextRefOut(
            type=result.result_type,
            id=result.id,
            evidence_span_ids=result.evidence_span_ids,
        )
    if isinstance(result, _RankedContributorResult):
        return SearchResultContextRefOut(type=result.result_type, id=result.handle)
    return SearchResultContextRefOut(type=result.result_type, id=result.id)


def _result_deep_link(result: InternalSearchResult) -> str:
    if isinstance(result, _RankedMediaResult):
        return f"/media/{result.id}"
    if isinstance(result, _RankedPodcastResult):
        return f"/podcasts/{result.id}"
    if isinstance(result, _RankedContributorResult):
        return f"/authors/{result.handle}"
    if isinstance(result, _RankedPageResult):
        return f"/pages/{result.id}"
    if isinstance(result, _RankedContentChunkResult):
        params = result.resolver.get("params")
        if not isinstance(params, dict):
            return str(result.resolver.get("route") or f"/media/{result.source.media_id}")
        query = urlencode(params)
        route = str(result.resolver.get("route") or f"/media/{result.source.media_id}")
        return f"{route}?{query}" if query else route
    if isinstance(result, _RankedNoteBlockResult):
        return f"/notes/{result.id}"
    if isinstance(result, _RankedMessageResult):
        return f"/conversations/{result.conversation_id}"
    raise AssertionError(f"Unknown search result type: {type(result).__name__}")


def _result_model_fields(result: InternalSearchResult) -> dict[str, Any]:
    context_ref = _result_context_ref(result)
    deep_link = _result_deep_link(result)

    if isinstance(result, _RankedPodcastResult):
        source_parts = [result.title]
        source_parts.extend(_credited_names(result.contributors))
        return {
            "title": result.title,
            "source_label": " - ".join(source_parts),
            "media_id": None,
            "media_kind": None,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    if isinstance(result, _RankedContributorResult):
        return {
            "title": getattr(result.contributor, "display_name", result.handle),
            "source_label": "contributor",
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

    if isinstance(result, _RankedNoteBlockResult):
        return {
            "title": result.page_title,
            "source_label": "note",
            "media_id": None,
            "media_kind": None,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    if isinstance(result, _RankedPageResult):
        return {
            "title": result.title,
            "source_label": "page",
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
    result_id = result.handle if isinstance(result, _RankedContributorResult) else result.id
    base_payload = {
        "id": result_id,
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
            contributors=result.contributors,
            **base_payload,
        )

    if isinstance(result, _RankedContributorResult):
        return SearchResultContributorOut(
            type="contributor",
            contributor_handle=result.handle,
            contributor=result.contributor,
            **base_payload,
        )

    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContentChunkOut(
            type="content_chunk",
            source_kind=result.source_kind,
            evidence_span_ids=result.evidence_span_ids,
            citation_label=result.citation_label,
            resolver=SearchResultResolverOut.model_validate(result.resolver),
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedPageResult):
        return SearchResultPageOut(
            type="page",
            description=result.description,
            **base_payload,
        )

    if isinstance(result, _RankedNoteBlockResult):
        return SearchResultNoteBlockOut(
            type="note_block",
            page_id=result.page_id,
            page_title=result.page_title,
            body_text=result.body_text,
            **base_payload,
        )

    if isinstance(result, _RankedMessageResult):
        return SearchResultMessageOut(
            type="message",
            conversation_id=result.conversation_id,
            seq=result.seq,
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
