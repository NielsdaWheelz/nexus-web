"""Search service layer.

Implements keyword search across all user-visible content using PostgreSQL
full-text search.

Search enforces strict canonical visibility guarantees:
- Media/content chunks: visible via canonical provenance (non-default membership, default
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
import re
import time
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_conversation,
    can_read_media,
    is_library_member,
    visible_media_ids_cte_sql,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.contributors import ContributorCreditOut, ContributorOut
from nexus.schemas.retrieval import (
    RetrievalLocator,
    retrieval_locator_json,
    retrieval_result_ref_json,
)
from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultContentChunkOut,
    SearchResultContextRefOut,
    SearchResultContributorOut,
    SearchResultConversationOut,
    SearchResultEpisodeOut,
    SearchResultEvidenceSpanOut,
    SearchResultFragmentOut,
    SearchResultHighlightOut,
    SearchResultMediaOut,
    SearchResultMessageOut,
    SearchResultNoteBlockOut,
    SearchResultOut,
    SearchResultPageOut,
    SearchResultPodcastOut,
    SearchResultSourceOut,
    SearchResultVideoOut,
    SearchResultWebOut,
)
from nexus.services import object_search
from nexus.services.contributor_credits import normalize_contributor_role
from nexus.services.locator_resolver import resolve_evidence_span
from nexus.services.semantic_chunks import (
    build_text_embedding,
    to_pgvector_literal,
    transcript_embedding_dimensions,
)

logger = get_logger(__name__)
RETRIEVAL_LOCATOR_ADAPTER = TypeAdapter(RetrievalLocator)

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
# Cosine similarity must clear a relevance floor; ANN nearest neighbors alone are not matches.
CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY = 0.50

# Supported search result types (ordered for deterministic behavior).
# Omitted type filters must mean "search everything the caller can ask for".
ALL_RESULT_TYPES = (
    "media",
    "podcast",
    "episode",
    "video",
    "content_chunk",
    "fragment",
    "contributor",
    "page",
    "note_block",
    "highlight",
    "message",
    "evidence_span",
    "conversation",
    "web_result",
)
VALID_RESULT_TYPES = frozenset(ALL_RESULT_TYPES)

# Type weight multipliers (applied post-rank)
TYPE_WEIGHTS = {
    "media": 1.3,
    "podcast": 1.15,
    "episode": 1.15,
    "video": 1.15,
    "content_chunk": 1.1,
    "fragment": 1.1,
    "contributor": 1.25,
    "page": 1.2,
    "note_block": 1.2,
    "highlight": 1.25,
    "message": 1.0,
    "evidence_span": 1.15,
    "conversation": 0.95,
    "web_result": 0.9,
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
    result_type: Literal["media", "episode", "video"] = "media"


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
    highlight_excerpt: str | None = None
    source_version: str | None = None
    locator: dict[str, Any] | None = None
    result_type: Literal["note_block"] = "note_block"


@dataclass(slots=True)
class _RankedHighlightResult:
    id: UUID
    snippet: str
    exact: str
    color: str
    source: SearchResultSourceOut
    score: _SearchScore
    source_version: str | None = None
    citation_label: str | None = None
    locator: dict[str, Any] | None = None
    result_type: Literal["highlight"] = "highlight"


@dataclass(slots=True)
class _RankedPageResult:
    id: UUID
    title: str
    description: str | None
    snippet: str
    score: _SearchScore
    source_version: str | None = None
    result_type: Literal["page"] = "page"


@dataclass(slots=True)
class _RankedMessageResult:
    id: UUID
    snippet: str
    conversation_id: UUID
    seq: int
    score: _SearchScore
    source_version: str | None = None
    locator: dict[str, Any] | None = None
    result_type: Literal["message"] = "message"


@dataclass(slots=True)
class _RankedContentChunkResult:
    id: UUID
    snippet: str
    source_kind: str
    source_version: str
    evidence_span_ids: list[UUID]
    citation_label: str
    locator: dict[str, Any]
    resolver: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["content_chunk"] = "content_chunk"


@dataclass(slots=True)
class _RankedEvidenceSpanResult:
    id: UUID
    snippet: str
    source_version: str
    citation_label: str
    locator: dict[str, Any]
    source: SearchResultSourceOut
    score: _SearchScore
    result_type: Literal["evidence_span"] = "evidence_span"


@dataclass(slots=True)
class _RankedFragmentResult:
    id: UUID
    idx: int
    snippet: str
    source: SearchResultSourceOut
    score: _SearchScore
    source_version: str | None = None
    citation_label: str | None = None
    locator: dict[str, Any] | None = None
    result_type: Literal["fragment"] = "fragment"


@dataclass(slots=True)
class _RankedContributorResult:
    id: UUID
    handle: str
    contributor: ContributorOut
    snippet: str
    score: _SearchScore
    result_type: Literal["contributor"] = "contributor"


@dataclass(slots=True)
class _RankedConversationResult:
    id: UUID
    title: str
    snippet: str
    score: _SearchScore
    result_type: Literal["conversation"] = "conversation"


@dataclass(slots=True)
class _RankedWebResult:
    id: str
    source_id: str
    result_ref: str
    title: str
    url: str
    display_url: str | None
    extra_snippets: list[str]
    published_at: str | None
    source_name: str | None
    rank: int | None
    provider: str | None
    provider_request_id: str | None
    snippet: str
    source_version: str
    locator: dict[str, Any]
    selected: bool
    score: _SearchScore
    result_type: Literal["web_result"] = "web_result"


def _web_result_ref_json(raw_result_ref: Any) -> dict[str, Any]:
    if not isinstance(raw_result_ref, dict):
        raise ValueError("web_result result_ref must be a JSON object")
    return retrieval_result_ref_json(raw_result_ref)


InternalSearchResult = (
    _RankedMediaResult
    | _RankedPodcastResult
    | _RankedContentChunkResult
    | _RankedEvidenceSpanResult
    | _RankedFragmentResult
    | _RankedContributorResult
    | _RankedPageResult
    | _RankedNoteBlockResult
    | _RankedHighlightResult
    | _RankedMessageResult
    | _RankedConversationResult
    | _RankedWebResult
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

        if not isinstance(payload, dict):
            raise ValueError("Cursor payload must be an object")
        offset = payload["offset"]
        if type(offset) is not int:
            raise ValueError("Cursor offset must be an integer")
        if offset < 0:
            raise ValueError("Offset must be non-negative")
        return offset
    except (KeyError, ValueError):
        # justify-ignore-error: malformed cursor decode path. ValueError covers
        # binascii.Error, json.JSONDecodeError, UnicodeDecodeError, and the
        # explicit shape/offset raises; KeyError covers a missing offset key.
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


def _query_has_full_text_terms(db: Session, q: str) -> bool:
    return bool(
        db.scalar(
            text("SELECT numnode(websearch_to_tsquery('english', :query)) > 0"),
            {"query": q},
        )
    )


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


def _dedup_strings(values: list[str] | None) -> list[str]:
    """Trim and dedup a list of strings, preserving first-seen order. None → []."""
    if values is None:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in values:
        text = str(raw or "").strip()
        if not text or text in seen:
            continue
        normalized.append(text)
        seen.add(text)
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
    semantic: bool = True,
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
    transaction_active_at_entry = db.in_transaction()

    # Clamp limit
    limit = min(max(1, limit), MAX_LIMIT)

    q = q.strip()
    offset = decode_search_cursor(cursor) if cursor else 0
    normalized_types = _normalize_result_types(types)
    normalized_contributor_handles = _dedup_strings(contributor_handles)
    normalized_roles = _normalize_credit_roles(roles)
    normalized_content_kinds = _dedup_strings(content_kinds)
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

    if has_query and not _query_has_full_text_terms(db, q):
        _log_search(viewer_id, q, scope, normalized_types, 0, start_time)
        return SearchResponse()

    semantic_query_embedding: tuple[str, list[float]] | None = None
    if (
        semantic
        and has_query
        and (
            "content_chunk" in normalized_types
            or (
                not normalized_contributor_handles
                and not normalized_roles
                and not normalized_content_kinds
                and ("page" in normalized_types or "note_block" in normalized_types)
            )
        )
    ):
        if not transaction_active_at_entry and db.in_transaction():
            db.rollback()
        semantic_query_embedding = build_text_embedding(q)
        if len(semantic_query_embedding[1]) != transcript_embedding_dimensions():
            raise ApiError(
                ApiErrorCode.E_LLM_PROVIDER_DOWN,
                "Embedding provider returned an invalid response.",
            )

    # Execute search queries per type and collect results
    all_results: list[InternalSearchResult] = []

    for result_type in normalized_types:
        type_results = _search_type(
            db,
            viewer_id,
            q,
            has_query,
            result_type,
            semantic_query_embedding,
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


def get_search_result(
    db: Session,
    viewer_id: UUID,
    result_type: str,
    result_id: str,
    evidence_span_ids: list[UUID] | None = None,
) -> SearchResultOut:
    """Resolve one typed search result by durable object ref."""
    if result_type not in VALID_RESULT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}"
        )

    score = _SearchScore(raw=1.0, weighted=1.0, normalized=1.0)

    if result_type in {"media", "episode", "video"}:
        media_id = _uuid_from_search_id(result_id)
        kind_filter = ""
        if result_type == "media":
            kind_filter = "AND m.kind NOT IN ('podcast_episode', 'video')"
        elif result_type == "episode":
            kind_filter = "AND m.kind = 'podcast_episode'"
        else:
            kind_filter = "AND m.kind = 'video'"
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
                SELECT m.id, m.title, m.kind, m.published_date, mcc.contributor_credits
                FROM media m
                JOIN visible_media vm ON vm.media_id = m.id
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE m.id = :id
                {kind_filter}
                """
            ),
            {"viewer_id": viewer_id, "id": media_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        media_result_type: Literal["media", "episode", "video"] = (
            "episode"
            if result_type == "episode"
            else "video"
            if result_type == "video"
            else "media"
        )
        return _result_to_out(
            _RankedMediaResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[1])),
                source=_build_search_source(row[0], row[2], row[1], row[4], row[3]),
                score=score,
                result_type=media_result_type,
            )
        )

    if result_type == "podcast":
        podcast_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
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
                    podcast_contributor_credits AS ({podcast_contributor_credits_rollup_cte_sql()})
                SELECT p.id, p.title, pcc.contributor_credits
                FROM podcasts p
                JOIN visible_podcasts vp ON vp.podcast_id = p.id
                LEFT JOIN podcast_contributor_credits pcc ON pcc.podcast_id = p.id
                WHERE p.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": podcast_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedPodcastResult(
                id=row[0],
                title=row[1],
                contributors=_parse_contributor_credits(row[2]),
                snippet=_truncate_snippet(str(row[1])),
                score=score,
            )
        )

    if result_type == "contributor":
        matches = _search_contributors(
            db,
            viewer_id,
            "",
            False,
            "all",
            None,
            [result_id],
            [],
            [],
            1,
        )
        if not matches:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        matches[0].score = score
        return _result_to_out(matches[0])

    if result_type == "content_chunk":
        chunk_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
                SELECT
                    cc.id,
                    cc.media_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    cc.chunk_text,
                    cc.source_kind,
                    cc.primary_evidence_span_id,
                    cc.index_run_id,
                    active_run.source_version
                FROM content_chunks cc
                JOIN media m ON m.id = cc.media_id
                JOIN visible_media vm ON vm.media_id = cc.media_id
                JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                    AND mcis.active_run_id = cc.index_run_id
                JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                    AND active_run.state = 'ready'
                    AND active_run.deactivated_at IS NULL
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE cc.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": chunk_id},
        ).first()
        if row is None or row[8] is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if evidence_span_ids and row[8] not in evidence_span_ids:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=row[1],
            evidence_span_id=row[8],
            index_run_id=row[9],
        )
        _require_resolved_evidence(resolution)
        return _result_to_out(
            _RankedContentChunkResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[6] or "")),
                source_kind=str(row[7]),
                source_version=str(resolution.get("source_version") or row[10] or ""),
                evidence_span_ids=[row[8]],
                citation_label=str(resolution["citation_label"]),
                locator=_locator_from_resolved_evidence(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[2] or ""),
                ),
                resolver=dict(resolution["resolver"]),
                source=_build_search_source(row[1], row[2], row[3], row[5], row[4]),
                score=score,
            )
        )

    if result_type == "fragment":
        fragment_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
                SELECT
                    f.id,
                    f.idx,
                    f.canonical_text,
                    f.transcript_version_id,
                    f.t_start_ms,
                    f.t_end_ms,
                    nav.location_id AS section_id,
                    m.id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    active_run.source_version
                FROM fragments f
                JOIN media m ON m.id = f.media_id
                JOIN visible_media vm ON vm.media_id = f.media_id
                LEFT JOIN LATERAL (
                    SELECT location_id
                    FROM epub_nav_locations nav
                    WHERE nav.media_id = f.media_id
                      AND nav.fragment_idx <= f.idx
                    ORDER BY nav.fragment_idx DESC, nav.ordinal DESC
                    LIMIT 1
                ) nav ON true
                LEFT JOIN media_content_index_states mcis ON mcis.media_id = f.media_id
                LEFT JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                    AND active_run.state = 'ready'
                    AND active_run.deactivated_at IS NULL
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE f.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": fragment_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        locator = _direct_fragment_locator(
            media_id=row[7],
            media_kind=str(row[8] or ""),
            fragment_id=row[0],
            text_value=str(row[2] or ""),
            start_offset=0,
            end_offset=len(str(row[2] or "")),
            exact=str(row[2] or ""),
            transcript_version_id=row[3],
            t_start_ms=int(row[4]) if row[4] is not None else None,
            t_end_ms=int(row[5]) if row[5] is not None else None,
            section_id=str(row[6]) if row[6] is not None else None,
        )
        if locator is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedFragmentResult(
                id=row[0],
                idx=int(row[1]),
                snippet=_truncate_snippet(str(row[2] or "")),
                source=_build_search_source(row[7], row[8], row[9], row[11], row[10]),
                score=score,
                source_version=str(row[12] or f"fragment:{row[0]}"),
                citation_label=f"fragment {int(row[1]) + 1}",
                locator=locator,
            )
        )

    if result_type == "page":
        page_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                """
                SELECT id, title, description, revision
                FROM pages
                WHERE id = :id
                  AND user_id = :viewer_id
                """
            ),
            {"viewer_id": viewer_id, "id": page_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedPageResult(
                id=row[0],
                title=row[1],
                description=row[2],
                snippet=_truncate_snippet(str(row[2] or row[1])),
                score=score,
                source_version=f"page:{row[0]}:revision:{int(row[3])}",
            )
        )

    if result_type == "note_block":
        block_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                """
                SELECT nb.id, nb.page_id, p.title, nb.body_text, nb.revision
                FROM note_blocks nb
                JOIN pages p ON p.id = nb.page_id
                WHERE nb.id = :id
                  AND nb.user_id = :viewer_id
                """
            ),
            {"viewer_id": viewer_id, "id": block_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if not str(row[3] or ""):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedNoteBlockResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[3] or "")),
                page_id=row[1],
                page_title=row[2],
                body_text=row[3],
                score=score,
                source_version=f"note_block:{row[0]}:revision:{int(row[4])}",
                locator=retrieval_locator_json(
                    {
                        "type": "note_block_offsets",
                        "page_id": str(row[1]),
                        "block_id": str(row[0]),
                        "start_offset": 0,
                        "end_offset": len(str(row[3] or "")),
                    }
                )
                if row[3]
                else None,
            )
        )

    if result_type == "highlight":
        highlight_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
                SELECT
                    h.id,
                    h.exact,
                    h.prefix,
                    h.suffix,
                    h.color,
                    m.id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    h.anchor_kind,
                    hfa.fragment_id,
                    hfa.start_offset,
                    hfa.end_offset,
                    f.canonical_text,
                    f.transcript_version_id,
                    f.t_start_ms,
                    f.t_end_ms,
                    hpa.page_number,
                    pdf_quads.quads,
                    active_run.source_version
                FROM highlights h
                JOIN media m ON m.id = h.anchor_media_id
                JOIN visible_media vm ON vm.media_id = h.anchor_media_id
                LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                LEFT JOIN fragments f ON f.id = hfa.fragment_id
                LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
                LEFT JOIN LATERAL (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'x1', CAST(hpq.x1 AS float), 'y1', CAST(hpq.y1 AS float),
                            'x2', CAST(hpq.x2 AS float), 'y2', CAST(hpq.y2 AS float),
                            'x3', CAST(hpq.x3 AS float), 'y3', CAST(hpq.y3 AS float),
                            'x4', CAST(hpq.x4 AS float), 'y4', CAST(hpq.y4 AS float)
                        )
                        ORDER BY hpq.quad_idx
                    ) AS quads
                    FROM highlight_pdf_quads hpq
                    WHERE hpq.highlight_id = h.id
                ) pdf_quads ON true
                JOIN media_content_index_states mcis ON mcis.media_id = h.anchor_media_id
                JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                    AND active_run.state = 'ready'
                    AND active_run.deactivated_at IS NULL
                    AND NULLIF(btrim(active_run.source_version), '') IS NOT NULL
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE h.id = :id
                  AND h.anchor_media_id IS NOT NULL
                  AND (
                        (
                            h.anchor_kind = 'fragment_offsets'
                            AND EXISTS (
                                SELECT 1
                                FROM highlight_fragment_anchors hfa
                                JOIN fragments f ON f.id = hfa.fragment_id
                                WHERE hfa.highlight_id = h.id
                                  AND f.media_id = h.anchor_media_id
                            )
                        )
                        OR (
                            h.anchor_kind = 'pdf_page_geometry'
                            AND EXISTS (
                                SELECT 1
                                FROM highlight_pdf_anchors hpa
                                WHERE hpa.highlight_id = h.id
                                  AND hpa.media_id = h.anchor_media_id
                            )
                        )
                  )
                  AND EXISTS (
                        SELECT 1
                        FROM library_entries le
                        JOIN memberships viewer_m ON viewer_m.library_id = le.library_id
                        JOIN memberships author_m ON author_m.library_id = le.library_id
                        WHERE le.media_id = h.anchor_media_id
                          AND viewer_m.user_id = :viewer_id
                          AND author_m.user_id = h.user_id
                  )
                """
            ),
            {"viewer_id": viewer_id, "id": highlight_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        locator = None
        if row[10] == "fragment_offsets" and row[11] is not None:
            locator = _direct_fragment_locator(
                media_id=row[5],
                media_kind=str(row[6] or ""),
                fragment_id=row[11],
                text_value=str(row[14] or ""),
                start_offset=int(row[12]),
                end_offset=int(row[13]),
                exact=str(row[1] or ""),
                prefix=str(row[2] or ""),
                suffix=str(row[3] or ""),
                transcript_version_id=row[15],
                t_start_ms=int(row[16]) if row[16] is not None else None,
                t_end_ms=int(row[17]) if row[17] is not None else None,
            )
        elif row[10] == "pdf_page_geometry" and row[18] is not None:
            try:
                locator = retrieval_locator_json(
                    {
                        "type": "pdf_page_geometry",
                        "media_id": str(row[5]),
                        "page_number": int(row[18]),
                        "quads": row[19] if isinstance(row[19], list) else [],
                        "exact": str(row[1] or ""),
                        "prefix": str(row[2] or ""),
                        "suffix": str(row[3] or ""),
                        "text_quote_selector": {
                            "exact": str(row[1] or ""),
                            "prefix": str(row[2] or ""),
                            "suffix": str(row[3] or ""),
                        },
                    }
                )
            except ValueError:
                locator = None
        if locator is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedHighlightResult(
                id=row[0],
                exact=str(row[1] or ""),
                snippet=_truncate_snippet(str(row[1] or "")),
                color=str(row[4] or "yellow"),
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=score,
                source_version=_required_source_version("highlight", row[20]),
                citation_label=f"highlight {str(row[0])[:8]}",
                locator=locator,
            )
        )

    if result_type == "message":
        message_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT m.id, m.conversation_id, m.seq, m.content
                FROM messages m
                JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
                WHERE m.id = :id
                  AND m.status != 'pending'
                """
            ),
            {"viewer_id": viewer_id, "id": message_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if not str(row[3] or ""):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedMessageResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[3] or "")),
                conversation_id=row[1],
                seq=row[2],
                score=score,
                source_version=f"message:{row[0]}",
                locator=retrieval_locator_json(
                    {
                        "type": "message_offsets",
                        "conversation_id": str(row[1]),
                        "message_id": str(row[0]),
                        "message_seq": int(row[2]),
                        "start_offset": 0,
                        "end_offset": len(str(row[3] or "")),
                    }
                )
                if row[3]
                else None,
            )
        )

    if result_type == "conversation":
        conversation_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT c.id, c.title
                FROM conversations c
                JOIN visible_conversations vc ON vc.conversation_id = c.id
                WHERE c.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": conversation_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedConversationResult(
                id=row[0],
                title=str(row[1] or "Conversation"),
                snippet=str(row[1] or "Conversation"),
                score=score,
            )
        )

    if result_type == "web_result":
        retrieval_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT
                    mr.id,
                    mr.source_id,
                    COALESCE(mr.result_ref->>'result_ref', mr.source_id),
                    COALESCE(NULLIF(mr.result_ref->>'title', ''), mr.source_title, mr.source_id),
                    COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link),
                    NULLIF(mr.result_ref->>'display_url', ''),
                    mr.result_ref->'extra_snippets',
                    NULLIF(mr.result_ref->>'published_at', ''),
                    NULLIF(mr.result_ref->>'source_name', ''),
                    CASE
                        WHEN mr.result_ref->>'rank' ~ '^[0-9]+$'
                        THEN CAST(mr.result_ref->>'rank' AS integer)
                        ELSE NULL
                    END,
                    NULLIF(mr.result_ref->>'provider', ''),
                    NULLIF(mr.result_ref->>'provider_request_id', ''),
                    COALESCE(NULLIF(mr.exact_snippet, ''), mr.result_ref->>'snippet', ''),
                    COALESCE(NULLIF(mr.source_version, ''), mr.result_ref->>'source_version'),
                    mr.locator,
                    mr.result_ref,
                    mr.selected
                FROM message_retrievals mr
                JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                JOIN visible_conversations vc ON vc.conversation_id = mtc.conversation_id
                WHERE mr.id = :id
                  AND mr.result_type = 'web_result'
                  AND mr.result_ref->>'type' = 'web_result'
                  AND mr.locator IS NOT NULL
                  AND mr.locator != 'null'::jsonb
                """
            ),
            {"viewer_id": viewer_id, "id": retrieval_id},
        ).first()
        if row is None or not row[4] or not row[13]:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        result_ref = _web_result_ref_json(row[15])
        return _result_to_out(
            _RankedWebResult(
                id=str(row[0]),
                source_id=str(result_ref["source_id"]),
                result_ref=str(result_ref["result_ref"]),
                title=str(result_ref["title"]),
                url=str(result_ref["url"]),
                display_url=result_ref.get("display_url"),
                extra_snippets=list(result_ref.get("extra_snippets", [])),
                published_at=result_ref.get("published_at"),
                source_name=result_ref.get("source_name"),
                rank=result_ref.get("rank"),
                provider=result_ref.get("provider"),
                provider_request_id=result_ref.get("provider_request_id"),
                snippet=_truncate_snippet(str(row[12] or "")),
                source_version=str(result_ref["source_version"]),
                locator=result_ref["locator"],
                selected=bool(row[16]),
                score=score,
            )
        )

    if result_type == "evidence_span":
        evidence_span_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
                SELECT
                    es.id,
                    es.media_id,
                    es.span_text,
                    es.citation_label,
                    ss.source_version,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits
                FROM evidence_spans es
                JOIN media m ON m.id = es.media_id
                LEFT JOIN source_snapshots ss ON ss.id = es.source_snapshot_id
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE es.id = :id
                """
            ),
            {"id": evidence_span_id},
        ).first()
        if row is None or not can_read_media(db, viewer_id, row[1]):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=row[1],
            evidence_span_id=row[0],
        )
        _require_resolved_evidence(resolution)
        return _result_to_out(
            _RankedEvidenceSpanResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[2] or "")),
                source_version=str(row[4] or resolution.get("source_version") or ""),
                citation_label=str(row[3] or resolution.get("citation_label") or ""),
                locator=_locator_from_resolved_evidence(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[5]),
                ),
                source=_build_search_source(row[1], row[5], row[6], row[8], row[7]),
                score=score,
            )
        )

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}")


def _uuid_from_search_id(result_id: str) -> UUID:
    try:
        return UUID(result_id)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from exc


def _search_type(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    result_type: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
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
    if result_type == "episode":
        if content_kinds and "podcast_episode" not in content_kinds:
            return []
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            ["podcast_episode"],
            limit,
            result_type="episode",
        )
    if result_type == "video":
        if content_kinds and "video" not in content_kinds:
            return []
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_handles,
            roles,
            ["video"],
            limit,
            result_type="video",
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
            semantic_query_embedding,
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

    # Remaining types do not filter by contributor handles, roles, or content_kinds;
    # any such filter rules out a match entirely.
    if contributor_handles or roles or content_kinds:
        return []

    if result_type == "evidence_span":
        return _search_evidence_spans(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "fragment":
        return _search_fragments(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "page":
        return _search_pages(
            db, viewer_id, q, semantic_query_embedding, scope_type, scope_id, limit
        )
    if result_type == "note_block":
        return _search_note_blocks(
            db, viewer_id, q, semantic_query_embedding, scope_type, scope_id, limit
        )
    if result_type == "highlight":
        return _search_highlights(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "message":
        return _search_messages(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "conversation":
        return _search_conversations(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "web_result":
        return _search_web_results(db, viewer_id, q, has_query, scope_type, scope_id, limit)
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
    result_type: Literal["media", "episode", "video"] = "media",
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
    elif result_type == "media":
        content_kind_filter = "AND m.kind NOT IN ('podcast_episode', 'video')"

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
            result_type=result_type,
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
    semantic_query_embedding: tuple[str, list[float]] | None,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search active content chunks with lexical or hybrid semantic ranking."""
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
        "min_semantic_similarity": CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY,
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
    if semantic_query_embedding is not None:
        embedding_model, query_embedding = semantic_query_embedding
        params["query_embedding"] = to_pgvector_literal(query_embedding)
        params["query_embedding_provider"] = (
            "test" if embedding_model.startswith("test_") else "openai"
        )
        params["query_embedding_model"] = embedding_model
        params["query_embedding_version"] = embedding_model

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

    if semantic_query_embedding is not None:
        query = f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()}),
                query_embedding AS (
                    SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
                ),
                eligible_chunks AS (
                    SELECT
                        cc.id,
                        cc.media_id,
                        m.kind,
                        m.title,
                        m.published_date,
                        mcc.contributor_credits,
                        cc.chunk_text,
                        ts_headline(
                            'english',
                            cc.chunk_text,
                            websearch_to_tsquery('english', :query),
                            'MaxWords=50, MinWords=10, MaxFragments=1'
                        ) AS snippet,
                        cc.source_kind,
                        cc.primary_evidence_span_id,
                        cc.index_run_id,
                        active_run.source_version,
                        cc.summary_locator,
                        cc.created_at,
                        cc.chunk_text_tsv,
                        mcis.active_embedding_provider,
                        mcis.active_embedding_model,
                        mcis.active_embedding_version,
                        mcis.active_embedding_config_hash
                    FROM content_chunks cc
                    JOIN media m ON m.id = cc.media_id
                    JOIN visible_media vm ON vm.media_id = cc.media_id
                    JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                        AND mcis.active_run_id = cc.index_run_id
                    JOIN content_index_runs active_run ON active_run.id = cc.index_run_id
                        AND active_run.state = 'ready'
                        AND active_run.deactivated_at IS NULL
                    LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                    WHERE TRUE
                    {scope_filter}
                    {content_kind_filter}
                    {contributor_credit_filter}
                ),
                semantic_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_version = ec.active_embedding_version
                        AND ce.embedding_config_hash = ec.active_embedding_config_hash
                        AND ce.embedding_dimensions = {embedding_dims}
                    JOIN query_embedding qe ON true
                    WHERE ec.active_embedding_provider = :query_embedding_provider
                      AND ec.active_embedding_model = :query_embedding_model
                      AND ec.active_embedding_version = :query_embedding_version
                    ORDER BY ce.embedding_vector <=> qe.embedding ASC, ec.id ASC
                    LIMIT :ann_limit
                ),
                lexical_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    WHERE ec.chunk_text_tsv @@ websearch_to_tsquery('english', :query)
                    ORDER BY
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query)) DESC,
                        ec.id ASC
                    LIMIT :ann_limit
                ),
                candidate_ids AS (
                    SELECT id FROM semantic_candidates
                    UNION
                    SELECT id FROM lexical_candidates
                ),
                scored_candidates AS (
                    SELECT
                        ec.id,
                        ec.media_id,
                        ec.kind,
                        ec.title,
                        ec.published_date,
                        ec.contributor_credits,
                        ec.chunk_text,
                        ec.snippet,
                        ec.source_kind,
                        ec.primary_evidence_span_id,
                        ec.index_run_id,
                        ec.source_version,
                        ec.summary_locator,
                        ec.created_at,
                        CASE
                            WHEN ce.chunk_id IS NULL THEN 0.0
                            ELSE (1 - (ce.embedding_vector <=> qe.embedding))
                        END AS semantic_similarity,
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query))
                            AS lexical_score
                    FROM candidate_ids ci
                    JOIN eligible_chunks ec ON ec.id = ci.id
                    JOIN query_embedding qe ON true
                    LEFT JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_version = ec.active_embedding_version
                        AND ce.embedding_config_hash = ec.active_embedding_config_hash
                        AND ce.embedding_dimensions = {embedding_dims}
                        AND ec.active_embedding_provider = :query_embedding_provider
                        AND ec.active_embedding_model = :query_embedding_model
                        AND ec.active_embedding_version = :query_embedding_version
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
                source_version,
                summary_locator,
                (
                    (0.45 * CASE WHEN lexical_score > 0.0 THEN 1.0 ELSE 0.0 END)
                    + (0.35 * GREATEST(semantic_similarity, 0.0))
                    + (0.15 * GREATEST(lexical_score, 0.0))
                    + (
                        0.05 * GREATEST(
                            0.0,
                            1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                        )
                    )
                ) AS raw_score
            FROM scored_candidates
            WHERE
                lexical_score > 0.0
                OR semantic_similarity >= :min_semantic_similarity
            ORDER BY raw_score DESC, id ASC
            LIMIT :limit
        """
    else:
        query = f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()}),
                lexical_candidates AS (
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
                        active_run.source_version,
                        cc.summary_locator,
                        cc.created_at,
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
                    WHERE
                        (:has_query IS FALSE OR cc.chunk_text_tsv @@ websearch_to_tsquery('english', :query))
                    {scope_filter}
                    {content_kind_filter}
                    {contributor_credit_filter}
                    ORDER BY lexical_score DESC, cc.id ASC
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
                source_version,
                summary_locator,
                (
                    (0.20 * GREATEST(lexical_score, 0.0))
                    + (
                        0.05 * GREATEST(
                            0.0,
                            1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                        )
                    )
                ) AS raw_score
            FROM lexical_candidates
            WHERE :has_query IS FALSE OR lexical_score > 0.0
            ORDER BY raw_score DESC, id ASC
            LIMIT :limit
        """
    rows = db.execute(text(query), params).fetchall()
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
        try:
            _require_resolved_evidence(resolution)
        except NotFoundError:
            continue
        evidence_span_ids = [row[9]] if row[9] is not None else []
        snippet = _truncate_snippet(str(row[7] or row[6] or ""))
        if has_query and q.lower() not in snippet.lower().replace("<b>", "").replace("</b>", ""):
            query_snippet = _snippet_around_query(str(row[6] or ""), q)
            if query_snippet is not None:
                snippet = query_snippet
        results.append(
            _RankedContentChunkResult(
                id=row[0],
                snippet=snippet,
                source_kind=str(row[8]),
                source_version=str(resolution.get("source_version") or row[11] or ""),
                evidence_span_ids=evidence_span_ids,
                citation_label=str(resolution["citation_label"]),
                locator=_locator_from_resolved_evidence(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[2] or ""),
                ),
                resolver=dict(resolution["resolver"]),
                source=_build_search_source(row[1], row[2], row[3], row[5], row[4]),
                score=_build_search_score(row[13]),
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
            c.id,
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
            id=row[0],
            handle=str(row[1]),
            contributor=_parse_contributor(row[2]),
            snippet=_truncate_snippet(str(row[4] or row[1])),
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]


def _search_pages(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    rows = object_search.search_objects(
        db,
        viewer_id=viewer_id,
        object_type="page",
        query_text=q,
        semantic_query_embedding=semantic_query_embedding,
        scope_type=scope_type,
        scope_id=scope_id,
        limit=limit,
    )
    revisions: dict[UUID, int] = {}
    if rows:
        revisions = {
            row["id"]: int(row["revision"])
            for row in db.execute(
                text(
                    """
                    SELECT id, revision
                    FROM pages
                    WHERE user_id = :viewer_id
                      AND id = ANY(:page_ids)
                    """
                ),
                {"viewer_id": viewer_id, "page_ids": [row["object_id"] for row in rows]},
            ).mappings()
        }
    results: list[InternalSearchResult] = []
    for row in rows:
        revision = revisions.get(row["object_id"])
        if revision is None:
            continue
        results.append(
            _RankedPageResult(
                id=row["object_id"],
                title=row["title_text"],
                description=row["body_text"] or None,
                snippet=_truncate_snippet(str(row["snippet"] or row["title_text"])),
                score=_build_search_score(row["score"]),
                source_version=f"page:{row['object_id']}:revision:{revision}",
            )
        )
    return results


def _search_note_blocks(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    rows = object_search.search_objects(
        db,
        viewer_id=viewer_id,
        object_type="note_block",
        query_text=q,
        semantic_query_embedding=semantic_query_embedding,
        scope_type=scope_type,
        scope_id=scope_id,
        limit=limit,
    )
    note_ids = [row["object_id"] for row in rows]
    highlight_excerpts: dict[UUID, str] = {}
    if note_ids:
        for row in db.execute(
            text(
                """
                SELECT
                    CASE
                        WHEN ol.a_type = 'note_block' THEN ol.a_id
                        ELSE ol.b_id
                    END AS note_block_id,
                    h.exact
                FROM object_links ol
                JOIN highlights h
                  ON (
                        (ol.a_type = 'highlight' AND h.id = ol.a_id)
                     OR (ol.b_type = 'highlight' AND h.id = ol.b_id)
                  )
                WHERE ol.user_id = :viewer_id
                  AND ol.relation_type = 'note_about'
                  AND (
                        (ol.a_type = 'note_block' AND ol.a_id = ANY(:note_ids))
                     OR (ol.b_type = 'note_block' AND ol.b_id = ANY(:note_ids))
                  )
                ORDER BY ol.created_at ASC, ol.id ASC
                """
            ),
            {"viewer_id": viewer_id, "note_ids": note_ids},
        ).mappings():
            highlight_excerpts.setdefault(
                row["note_block_id"],
                _truncate_snippet(str(row["exact"] or "")),
            )
    revisions: dict[UUID, int] = {}
    if note_ids:
        revisions = {
            row["id"]: int(row["revision"])
            for row in db.execute(
                text(
                    """
                    SELECT id, revision
                    FROM note_blocks
                    WHERE user_id = :viewer_id
                      AND id = ANY(:note_ids)
                    """
                ),
                {"viewer_id": viewer_id, "note_ids": note_ids},
            ).mappings()
        }
    results: list[InternalSearchResult] = []
    for row in rows:
        body_text = str(row["body_text"] or "")
        if not body_text:
            continue
        revision = revisions.get(row["object_id"])
        if revision is None:
            continue
        locator = retrieval_locator_json(
            {
                "type": "note_block_offsets",
                "page_id": str(row["parent_object_id"]),
                "block_id": str(row["object_id"]),
                "start_offset": 0,
                "end_offset": len(body_text),
            }
        )
        results.append(
            _RankedNoteBlockResult(
                id=row["object_id"],
                snippet=_truncate_snippet(str(row["snippet"] or "")),
                page_id=row["parent_object_id"],
                page_title=row["title_text"],
                body_text=body_text,
                score=_build_search_score(row["score"]),
                highlight_excerpt=highlight_excerpts.get(row["object_id"]),
                source_version=f"note_block:{row['object_id']}:revision:{revision}",
                locator=locator,
            )
        )
    return results


def _search_fragments(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    if scope_type == "media":
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
        return []
    elif scope_type != "all":
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
            SELECT
                f.id,
                f.idx,
                f.canonical_text,
                f.transcript_version_id,
                f.t_start_ms,
                f.t_end_ms,
                nav.location_id AS section_id,
                m.id AS media_id,
                m.kind,
                m.title,
                m.published_date,
                mcc.contributor_credits,
                active_run.source_version,
                ts_rank_cd(
                    to_tsvector('english', f.canonical_text),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    f.canonical_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) AS snippet
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            JOIN visible_media vm ON vm.media_id = f.media_id
            LEFT JOIN LATERAL (
                SELECT location_id
                FROM epub_nav_locations nav
                WHERE nav.media_id = f.media_id
                  AND nav.fragment_idx <= f.idx
                ORDER BY nav.fragment_idx DESC, nav.ordinal DESC
                LIMIT 1
            ) nav ON true
            LEFT JOIN media_content_index_states mcis ON mcis.media_id = f.media_id
            LEFT JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                AND active_run.state = 'ready'
                AND active_run.deactivated_at IS NULL
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE to_tsvector('english', f.canonical_text) @@ websearch_to_tsquery('english', :query)
            {scope_filter}
            ORDER BY score DESC, f.idx ASC, f.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    results: list[InternalSearchResult] = []
    for row in rows:
        locator = _direct_fragment_locator(
            media_id=row[7],
            media_kind=str(row[8] or ""),
            fragment_id=row[0],
            text_value=str(row[2] or ""),
            start_offset=0,
            end_offset=len(str(row[2] or "")),
            exact=str(row[2] or ""),
            transcript_version_id=row[3],
            t_start_ms=int(row[4]) if row[4] is not None else None,
            t_end_ms=int(row[5]) if row[5] is not None else None,
            section_id=str(row[6]) if row[6] is not None else None,
        )
        if locator is None:
            continue
        results.append(
            _RankedFragmentResult(
                id=row[0],
                idx=int(row[1]),
                snippet=_truncate_snippet(str(row[14] or row[2] or "")),
                source=_build_search_source(row[7], row[8], row[9], row[11], row[10]),
                score=_build_search_score(row[13]),
                source_version=str(row[12] or f"fragment:{row[0]}"),
                citation_label=f"fragment {int(row[1]) + 1}",
                locator=locator,
            )
        )
    return results


def _search_highlights(
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
        scope_filter = "AND h.anchor_media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND h.anchor_media_id IN (
                SELECT media_id
                FROM library_entries
                WHERE library_id = :scope_id
                  AND media_id IS NOT NULL
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND ('highlight:' || h.id::text) IN (
                SELECT cr.resource_uri
                FROM conversation_references cr
                WHERE cr.conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
            SELECT
                h.id,
                h.exact,
                h.prefix,
                h.suffix,
                h.color,
                m.id AS media_id,
                m.kind,
                m.title,
                m.published_date,
                mcc.contributor_credits,
                h.anchor_kind,
                hfa.fragment_id,
                hfa.start_offset,
                hfa.end_offset,
                f.canonical_text,
                f.transcript_version_id,
                f.t_start_ms,
                f.t_end_ms,
                hpa.page_number,
                pdf_quads.quads,
                active_run.source_version,
                ts_rank_cd(
                    to_tsvector(
                        'english',
                        concat_ws(' ', h.exact, COALESCE(h.prefix, ''), COALESCE(h.suffix, ''))
                    ),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    concat_ws(' ', h.exact, COALESCE(h.prefix, ''), COALESCE(h.suffix, '')),
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) AS snippet
            FROM highlights h
            JOIN media m ON m.id = h.anchor_media_id
            JOIN visible_media vm ON vm.media_id = h.anchor_media_id
            LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
            LEFT JOIN fragments f ON f.id = hfa.fragment_id
            LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'x1', CAST(hpq.x1 AS float), 'y1', CAST(hpq.y1 AS float),
                        'x2', CAST(hpq.x2 AS float), 'y2', CAST(hpq.y2 AS float),
                        'x3', CAST(hpq.x3 AS float), 'y3', CAST(hpq.y3 AS float),
                        'x4', CAST(hpq.x4 AS float), 'y4', CAST(hpq.y4 AS float)
                    )
                    ORDER BY hpq.quad_idx
                ) AS quads
                FROM highlight_pdf_quads hpq
                WHERE hpq.highlight_id = h.id
            ) pdf_quads ON true
            JOIN media_content_index_states mcis ON mcis.media_id = h.anchor_media_id
            JOIN content_index_runs active_run ON active_run.id = mcis.active_run_id
                AND active_run.state = 'ready'
                AND active_run.deactivated_at IS NULL
                AND NULLIF(btrim(active_run.source_version), '') IS NOT NULL
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE to_tsvector(
                    'english',
                    concat_ws(' ', h.exact, COALESCE(h.prefix, ''), COALESCE(h.suffix, ''))
                ) @@ websearch_to_tsquery('english', :query)
              AND h.anchor_media_id IS NOT NULL
              AND (
                    (
                        h.anchor_kind = 'fragment_offsets'
                        AND EXISTS (
                            SELECT 1
                            FROM highlight_fragment_anchors hfa
                            JOIN fragments f ON f.id = hfa.fragment_id
                            WHERE hfa.highlight_id = h.id
                              AND f.media_id = h.anchor_media_id
                        )
                    )
                    OR (
                        h.anchor_kind = 'pdf_page_geometry'
                        AND EXISTS (
                            SELECT 1
                            FROM highlight_pdf_anchors hpa
                            WHERE hpa.highlight_id = h.id
                              AND hpa.media_id = h.anchor_media_id
                        )
                    )
              )
              AND EXISTS (
                    SELECT 1
                    FROM library_entries le
                    JOIN memberships viewer_m ON viewer_m.library_id = le.library_id
                    JOIN memberships author_m ON author_m.library_id = le.library_id
                    WHERE le.media_id = h.anchor_media_id
                      AND viewer_m.user_id = :viewer_id
                      AND author_m.user_id = h.user_id
              )
            {scope_filter}
            ORDER BY score DESC, h.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()

    results: list[InternalSearchResult] = []
    for row in rows:
        locator = None
        if row[10] == "fragment_offsets" and row[11] is not None:
            locator = _direct_fragment_locator(
                media_id=row[5],
                media_kind=str(row[6] or ""),
                fragment_id=row[11],
                text_value=str(row[14] or ""),
                start_offset=int(row[12]),
                end_offset=int(row[13]),
                exact=str(row[1] or ""),
                prefix=str(row[2] or ""),
                suffix=str(row[3] or ""),
                transcript_version_id=row[15],
                t_start_ms=int(row[16]) if row[16] is not None else None,
                t_end_ms=int(row[17]) if row[17] is not None else None,
            )
        elif row[10] == "pdf_page_geometry" and row[18] is not None:
            try:
                locator = retrieval_locator_json(
                    {
                        "type": "pdf_page_geometry",
                        "media_id": str(row[5]),
                        "page_number": int(row[18]),
                        "quads": row[19] if isinstance(row[19], list) else [],
                        "exact": str(row[1] or ""),
                        "prefix": str(row[2] or ""),
                        "suffix": str(row[3] or ""),
                        "text_quote_selector": {
                            "exact": str(row[1] or ""),
                            "prefix": str(row[2] or ""),
                            "suffix": str(row[3] or ""),
                        },
                    }
                )
            except ValueError:
                locator = None
        if locator is None:
            continue
        results.append(
            _RankedHighlightResult(
                id=row[0],
                exact=str(row[1] or ""),
                snippet=_truncate_snippet(str(row[22] or row[1] or "")),
                color=str(row[4] or "yellow"),
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=_build_search_score(row[21]),
                source_version=_required_source_version("highlight", row[20]),
                citation_label=f"highlight {str(row[0])[:8]}",
                locator=locator,
            )
        )
    return results


def _search_messages(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search message content with visibility filtering.

    Message visibility follows the canonical conversation visibility CTE.
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
            m.content,
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
            snippet=_truncate_snippet(str(row[5] or "")),
            conversation_id=row[1],
            seq=row[2],
            score=_build_search_score(row[4]),
            source_version=f"message:{row[0]}",
            locator=retrieval_locator_json(
                {
                    "type": "message_offsets",
                    "conversation_id": str(row[1]),
                    "message_id": str(row[0]),
                    "message_seq": int(row[2]),
                    "start_offset": 0,
                    "end_offset": len(str(row[3] or "")),
                }
            )
            if row[3]
            else None,
        )
        for row in rows
    ]


def _search_conversations(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    if scope_type == "media":
        return []
    if scope_type == "library":
        scope_filter = """
            AND c.id IN (
                SELECT cs.conversation_id
                FROM conversation_shares cs
                WHERE cs.library_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = "AND c.id = :scope_id"
        params["scope_id"] = scope_id

    rows = db.execute(
        text(
            f"""
            WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
            SELECT
                c.id,
                c.title,
                ts_rank_cd(
                    to_tsvector('english', COALESCE(c.title, '')),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    COALESCE(c.title, ''),
                    websearch_to_tsquery('english', :query),
                    'MaxWords=24, MinWords=3, MaxFragments=1'
                ) AS snippet
            FROM conversations c
            JOIN visible_conversations vc ON vc.conversation_id = c.id
            WHERE to_tsvector('english', COALESCE(c.title, ''))
                  @@ websearch_to_tsquery('english', :query)
              {scope_filter}
            ORDER BY score DESC, c.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    return [
        _RankedConversationResult(
            id=row[0],
            title=str(row[1] or "Conversation"),
            snippet=_truncate_snippet(str(row[3] or row[1] or "")),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _search_evidence_spans(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    if scope_type == "media":
        scope_filter = "AND es.media_id = :scope_id"
        params["scope_id"] = scope_id
    elif scope_type == "library":
        scope_filter = """
            AND es.media_id IN (
                SELECT media_id FROM library_entries WHERE library_id = :scope_id
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = """
            AND es.media_id IN (
                SELECT media_id FROM conversation_media WHERE conversation_id = :scope_id
            )
        """
        params["scope_id"] = scope_id

    rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({media_contributor_credits_rollup_cte_sql()})
            SELECT
                es.id,
                es.media_id,
                es.span_text,
                es.citation_label,
                ss.source_version,
                m.kind,
                m.title,
                m.published_date,
                mcc.contributor_credits,
                ts_rank_cd(
                    to_tsvector('english', es.span_text),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    es.span_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) AS snippet
            FROM evidence_spans es
            JOIN visible_media vm ON vm.media_id = es.media_id
            JOIN media m ON m.id = es.media_id
            LEFT JOIN source_snapshots ss ON ss.id = es.source_snapshot_id
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE to_tsvector('english', es.span_text)
                  @@ websearch_to_tsquery('english', :query)
              {scope_filter}
            ORDER BY score DESC, es.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    results: list[InternalSearchResult] = []
    for row in rows:
        try:
            resolution = resolve_evidence_span(
                db,
                viewer_id=viewer_id,
                media_id=row[1],
                evidence_span_id=row[0],
            )
            _require_resolved_evidence(resolution)
        except NotFoundError:
            continue
        locator = _locator_from_resolved_evidence(
            resolution,
            media_id=row[1],
            media_kind=str(row[5]),
        )
        results.append(
            _RankedEvidenceSpanResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[10] or row[2] or "")),
                source_version=str(row[4] or resolution.get("source_version") or ""),
                citation_label=str(row[3] or resolution.get("citation_label") or ""),
                locator=locator,
                source=_build_search_source(row[1], row[5], row[6], row[8], row[7]),
                score=_build_search_score(row[9]),
            )
        )
    return results


def _search_web_results(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search persisted public-web retrievals visible through their conversation."""
    if not has_query:
        return []

    scope_filter = ""
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    if scope_type == "all":
        pass
    elif scope_type == "media":
        return []
    elif scope_type == "library":
        scope_filter = """
            AND mtc.conversation_id IN (
                SELECT cs.conversation_id
                FROM conversation_shares cs
                JOIN conversations conv ON conv.id = cs.conversation_id
                WHERE cs.library_id = :scope_id
                  AND conv.sharing = 'library'
            )
        """
        params["scope_id"] = scope_id
    elif scope_type == "conversation":
        scope_filter = "AND mtc.conversation_id = :scope_id"
        params["scope_id"] = scope_id
    else:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Invalid scope format")

    rows = db.execute(
        text(
            f"""
            WITH
                visible_conversations AS ({visible_conversation_ids_cte_sql()}),
                web_rows AS (
                    SELECT
                        mr.id,
                        mr.source_id,
                        COALESCE(mr.result_ref->>'result_ref', mr.source_id) AS result_ref,
                        COALESCE(
                            NULLIF(mr.result_ref->>'title', ''),
                            mr.source_title,
                            mr.source_id
                        ) AS title,
                        COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link) AS url,
                        NULLIF(mr.result_ref->>'display_url', '') AS display_url,
                        mr.result_ref->'extra_snippets' AS extra_snippets,
                        NULLIF(mr.result_ref->>'published_at', '') AS published_at,
                        NULLIF(mr.result_ref->>'source_name', '') AS source_name,
                        CASE
                            WHEN mr.result_ref->>'rank' ~ '^[0-9]+$'
                            THEN CAST(mr.result_ref->>'rank' AS integer)
                            ELSE NULL
                        END AS rank,
                        NULLIF(mr.result_ref->>'provider', '') AS provider,
                        NULLIF(mr.result_ref->>'provider_request_id', '') AS provider_request_id,
                        COALESCE(NULLIF(mr.exact_snippet, ''), mr.result_ref->>'snippet', '') AS exact_snippet,
                        COALESCE(NULLIF(mr.source_version, ''), mr.result_ref->>'source_version') AS source_version,
                        mr.locator,
                        mr.selected,
                        mr.result_ref AS raw_result_ref,
                        concat_ws(
                            ' ',
                            mr.source_id,
                            mr.source_title,
                            mr.deep_link,
                            mr.exact_snippet,
                            mr.result_ref->>'title',
                            mr.result_ref->>'url',
                            mr.result_ref->>'display_url',
                            mr.result_ref->>'source_name',
                            mr.result_ref->>'snippet'
                        ) AS search_text
                    FROM message_retrievals mr
                    JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                    JOIN visible_conversations vc ON vc.conversation_id = mtc.conversation_id
                    WHERE mr.result_type = 'web_result'
                      AND mr.result_ref->>'type' = 'web_result'
                      AND mr.locator IS NOT NULL
                      AND mr.locator != 'null'::jsonb
                      {scope_filter}
                )
            SELECT
                id,
                source_id,
                result_ref,
                title,
                url,
                display_url,
                extra_snippets,
                published_at,
                source_name,
                rank,
                provider,
                provider_request_id,
                exact_snippet,
                source_version,
                locator,
                selected,
                raw_result_ref,
                ts_rank_cd(
                    to_tsvector('english', search_text),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    search_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) AS snippet
            FROM web_rows
            WHERE to_tsvector('english', search_text)
                  @@ websearch_to_tsquery('english', :query)
              AND url IS NOT NULL
              AND source_version IS NOT NULL
            ORDER BY score DESC, id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()

    results: list[InternalSearchResult] = []
    for row in rows:
        result_ref = _web_result_ref_json(row[16])
        results.append(
            _RankedWebResult(
                id=str(row[0]),
                source_id=str(result_ref["source_id"]),
                result_ref=str(result_ref["result_ref"]),
                title=str(result_ref["title"]),
                url=str(result_ref["url"]),
                display_url=result_ref.get("display_url"),
                extra_snippets=list(result_ref.get("extra_snippets", [])),
                published_at=result_ref.get("published_at"),
                source_name=result_ref.get("source_name"),
                rank=result_ref.get("rank"),
                provider=result_ref.get("provider"),
                provider_request_id=result_ref.get("provider_request_id"),
                snippet=_truncate_snippet(str(row[18] or row[12] or "")),
                source_version=str(result_ref["source_version"]),
                locator=_required_locator("web_result", result_ref["locator"]),
                selected=bool(row[15]),
                score=_build_search_score(row[17]),
            )
        )
    return results


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
    """Truncate snippet to max length, preserving highlighted matches."""
    if len(snippet) <= MAX_SNIPPET_LENGTH:
        return snippet

    match_start = snippet.lower().find("<b>")
    if match_start > MAX_SNIPPET_LENGTH:
        start = max(0, match_start - MAX_SNIPPET_LENGTH // 3)
        first_space = snippet.find(" ", start, match_start)
        if first_space != -1:
            start = first_space + 1

        end = min(len(snippet), start + MAX_SNIPPET_LENGTH)
        last_space = snippet.rfind(" ", match_start, end)
        if last_space > match_start:
            end = last_space

        return f"...{snippet[start:end]}{'...' if end < len(snippet) else ''}"

    truncated = snippet[:MAX_SNIPPET_LENGTH]
    last_space = truncated.rfind(" ")
    if last_space > MAX_SNIPPET_LENGTH // 2:
        truncated = truncated[:last_space]

    return truncated + "..."


def _snippet_around_query(text: str, query: str) -> str | None:
    query = " ".join(query.split())
    if not text or not query:
        return None

    text_lower = text.lower()
    query_lower = query.lower()
    match_start = text_lower.find(query_lower)
    match_len = len(query)

    if match_start == -1:
        terms = [term for term in re.findall(r"[a-z0-9]+", query_lower) if len(term) >= 2]
        positions = [(text_lower.find(term), len(term)) for term in terms]
        positions = [position for position in positions if position[0] != -1]
        if not positions:
            return None
        match_start, match_len = min(positions, key=lambda position: position[0])

    prefix = "..." if match_start > MAX_SNIPPET_LENGTH // 3 else ""
    body_limit = MAX_SNIPPET_LENGTH - len(prefix) - len("...") - len("<b></b>")
    start = max(0, match_start - MAX_SNIPPET_LENGTH // 3)
    first_space = text.find(" ", start, match_start)
    if first_space != -1:
        start = first_space + 1

    end = min(len(text), start + body_limit)
    if end < match_start + match_len:
        end = min(len(text), match_start + match_len)
    last_space = text.rfind(" ", match_start + match_len, end)
    if last_space > match_start + match_len:
        end = last_space

    suffix = "..." if end < len(text) else ""
    local_match_start = match_start - start
    body = text[start : local_match_start + start]
    body += f"<b>{text[match_start : match_start + match_len]}</b>"
    body += text[match_start + match_len : end]
    return f"{prefix}{body}{suffix}"


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
    if isinstance(result, _RankedMediaResult):
        return SearchResultContextRefOut(type="media", id=result.id)
    if isinstance(result, _RankedContentChunkResult):
        return SearchResultContextRefOut(
            type=result.result_type,
            id=result.id,
            evidence_span_ids=result.evidence_span_ids,
        )
    if isinstance(result, _RankedContributorResult):
        return SearchResultContextRefOut(type=result.result_type, id=result.handle)
    return SearchResultContextRefOut(type=result.result_type, id=result.id)


def _direct_fragment_locator(
    *,
    media_id: UUID,
    media_kind: str,
    fragment_id: UUID,
    text_value: str,
    start_offset: int,
    end_offset: int,
    exact: str,
    prefix: str = "",
    suffix: str = "",
    transcript_version_id: UUID | None = None,
    t_start_ms: int | None = None,
    t_end_ms: int | None = None,
    section_id: str | None = None,
) -> dict[str, Any] | None:
    if t_start_ms is not None and t_end_ms is not None:
        if t_end_ms <= t_start_ms or not exact:
            return None
        locator = {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "transcript_version_id": str(transcript_version_id) if transcript_version_id else None,
            "t_start_ms": t_start_ms,
            "t_end_ms": t_end_ms,
            "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
        }
    else:
        if end_offset <= start_offset or len(text_value) < end_offset:
            return None
        if media_kind == "epub":
            locator = {
                "type": "epub_fragment_offsets",
                "media_id": str(media_id),
                "section_id": section_id,
                "fragment_id": str(fragment_id),
                "start_offset": start_offset,
                "end_offset": end_offset,
                "media_kind": media_kind,
                "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }
        elif media_kind != "pdf":
            locator = {
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": start_offset,
                "end_offset": end_offset,
                "media_kind": media_kind,
                "text_quote_selector": {"exact": exact, "prefix": prefix, "suffix": suffix},
            }
        else:
            return None
    try:
        return retrieval_locator_json(locator)
    except ValueError:
        return None


def _locator_from_resolved_evidence(
    resolution: dict[str, Any],
    *,
    media_id: UUID,
    media_kind: str,
) -> dict[str, Any]:
    resolver = resolution.get("resolver")
    if not isinstance(resolver, dict):
        raise AssertionError("Resolved evidence is missing resolver")
    selector = resolver.get("selector")
    if not isinstance(selector, dict):
        raise AssertionError("Resolved evidence is missing selector")

    raw_quote = selector.get("text_quote")
    quote = raw_quote if isinstance(raw_quote, dict) else {}
    exact = str(quote.get("exact") or resolution.get("span_text") or "")
    prefix = quote.get("prefix") if isinstance(quote.get("prefix"), str) else None
    suffix = quote.get("suffix") if isinstance(quote.get("suffix"), str) else None
    quote_selector = {"exact": exact, "prefix": prefix, "suffix": suffix}

    kind = resolver.get("kind")
    if kind == "web":
        locator = {
            "type": "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "media_kind": media_kind,
            "text_quote_selector": quote_selector,
        }
    elif kind == "epub":
        locator = {
            "type": "epub_fragment_offsets",
            "media_id": str(media_id),
            "section_id": selector.get("section_id")
            if isinstance(selector.get("section_id"), str)
            else None,
            "fragment_id": selector.get("fragment_id"),
            "start_offset": selector.get("start_offset"),
            "end_offset": selector.get("end_offset"),
            "media_kind": media_kind,
            "text_quote_selector": quote_selector,
        }
    elif kind == "pdf":
        raw_geometry = selector.get("geometry")
        geometry = raw_geometry if isinstance(raw_geometry, dict) else {}
        quads = geometry.get("quads") if isinstance(geometry.get("quads"), list) else []
        locator = {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": selector.get("page_number"),
            "quads": quads,
            "exact": exact,
            "prefix": prefix,
            "suffix": suffix,
            "text_quote_selector": quote_selector,
        }
    elif kind == "transcript":
        locator = {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": selector.get("t_start_ms"),
            "t_end_ms": selector.get("t_end_ms"),
            "text_quote_selector": quote_selector,
        }
    else:
        raise AssertionError("Resolved evidence has unsupported resolver kind")

    validated = retrieval_locator_json(locator)
    if validated is None:
        raise AssertionError("Resolved evidence locator is required")
    return validated


def _require_resolved_evidence(resolution: dict[str, Any]) -> None:
    resolver = resolution.get("resolver")
    if not isinstance(resolver, dict) or resolver.get("status") != "resolved":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result is stale")


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
        # Resolver always seeds params["evidence"] with the span id (see
        # locator_resolver.resolve_evidence_span); route is /media/<media_id>.
        route = result.resolver.get("route")
        params = result.resolver.get("params")
        if not isinstance(route, str) or not route:
            raise AssertionError("Content chunk resolver route is required")
        if not isinstance(params, dict):
            raise AssertionError("Content chunk resolver params must be an object")
        evidence_id = params.get("evidence")
        if not isinstance(evidence_id, str) or not evidence_id:
            raise AssertionError("Content chunk resolver params must include evidence id")
        return f"{route}#evidence-{evidence_id}"
    if isinstance(result, _RankedFragmentResult):
        return f"/media/{result.source.media_id}#fragment-{result.id}"
    if isinstance(result, _RankedNoteBlockResult):
        return f"/notes/{result.id}"
    if isinstance(result, _RankedHighlightResult):
        return f"/media/{result.source.media_id}#highlight-{result.id}"
    if isinstance(result, _RankedMessageResult):
        return f"/conversations/{result.conversation_id}"
    if isinstance(result, _RankedConversationResult):
        return f"/conversations/{result.id}"
    if isinstance(result, _RankedEvidenceSpanResult):
        return f"/media/{result.source.media_id}#evidence-{result.id}"
    if isinstance(result, _RankedWebResult):
        return result.url
    raise AssertionError(f"Unknown search result type: {type(result).__name__}")


def _required_source_version(result_type: str, source_version: str | None) -> str:
    if isinstance(source_version, str) and source_version.strip():
        return source_version
    raise AssertionError(f"{result_type} search result is missing source_version")


def _required_locator(
    result_type: str,
    locator: RetrievalLocator | dict[str, Any] | None,
) -> Any:
    if isinstance(locator, BaseModel):
        return locator
    if isinstance(locator, dict) and locator:
        try:
            RETRIEVAL_LOCATOR_ADAPTER.validate_python(locator)
        except ValidationError as exc:
            raise AssertionError(f"{result_type} search result locator is invalid") from exc
        return locator
    raise AssertionError(f"{result_type} search result is missing locator")


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

    if isinstance(result, _RankedConversationResult):
        return {
            "title": result.title,
            "source_label": "conversation",
            "media_id": None,
            "media_kind": None,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    if isinstance(result, _RankedHighlightResult):
        return {
            "title": result.source.title,
            "source_label": _build_source_label(result.source),
            "media_id": result.source.media_id,
            "media_kind": result.source.media_kind,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    if isinstance(result, _RankedEvidenceSpanResult):
        return {
            "title": result.source.title,
            "source_label": _build_source_label(result.source),
            "media_id": result.source.media_id,
            "media_kind": result.source.media_kind,
            "deep_link": deep_link,
            "context_ref": context_ref,
        }

    if isinstance(result, _RankedWebResult):
        return {
            "title": result.title,
            "source_label": result.source_name or result.display_url or "web",
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

    if isinstance(result, _RankedMediaResult) and result.result_type == "media":
        return SearchResultMediaOut(
            type="media",
            source=result.source,
            **base_payload,
        )
    if isinstance(result, _RankedMediaResult) and result.result_type == "episode":
        return SearchResultEpisodeOut(
            type="episode",
            source=result.source,
            **base_payload,
        )
    if isinstance(result, _RankedMediaResult) and result.result_type == "video":
        return SearchResultVideoOut(
            type="video",
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
            source_version=result.source_version,
            evidence_span_ids=result.evidence_span_ids,
            citation_label=result.citation_label,
            locator=_required_locator("content_chunk", result.locator),
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedEvidenceSpanResult):
        return SearchResultEvidenceSpanOut(
            type="evidence_span",
            evidence_span_id=result.id,
            source_version=result.source_version,
            citation_label=result.citation_label,
            locator=_required_locator("evidence_span", result.locator),
            source=result.source,
            **base_payload,
        )

    if isinstance(result, _RankedFragmentResult):
        return SearchResultFragmentOut(
            type="fragment",
            source=result.source,
            source_version=_required_source_version("fragment", result.source_version),
            citation_label=result.citation_label,
            locator=_required_locator("fragment", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedPageResult):
        return SearchResultPageOut(
            type="page",
            description=result.description,
            source_version=_required_source_version("page", result.source_version),
            **base_payload,
        )

    if isinstance(result, _RankedNoteBlockResult):
        return SearchResultNoteBlockOut(
            type="note_block",
            page_id=result.page_id,
            page_title=result.page_title,
            body_text=result.body_text,
            highlight_excerpt=result.highlight_excerpt,
            source_version=_required_source_version("note_block", result.source_version),
            locator=_required_locator("note_block", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedHighlightResult):
        return SearchResultHighlightOut(
            type="highlight",
            color=result.color,
            exact=result.exact,
            source=result.source,
            source_version=_required_source_version("highlight", result.source_version),
            citation_label=result.citation_label,
            locator=_required_locator("highlight", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedMessageResult):
        return SearchResultMessageOut(
            type="message",
            conversation_id=result.conversation_id,
            seq=result.seq,
            source_version=_required_source_version("message", result.source_version),
            locator=_required_locator("message", result.locator),
            **base_payload,
        )

    if isinstance(result, _RankedConversationResult):
        return SearchResultConversationOut(
            type="conversation",
            **base_payload,
        )

    if isinstance(result, _RankedWebResult):
        return SearchResultWebOut(
            type="web_result",
            result_type="web_result",
            source_id=result.source_id,
            result_ref=result.result_ref,
            url=result.url,
            display_url=result.display_url,
            extra_snippets=result.extra_snippets,
            published_at=result.published_at,
            source_name=result.source_name,
            rank=result.rank,
            provider=result.provider,
            provider_request_id=result.provider_request_id,
            source_version=_required_source_version("web_result", result.source_version),
            locator=_required_locator("web_result", result.locator),
            selected=result.selected,
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
