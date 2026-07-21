"""Pre-projection search candidate engine: retrieval + ranking, one seam.

Sole owner of search candidate retrieval/ranking
(universal-link-authoring-hard-cutover.md, Final Architecture). Typed internal
candidates exist after retrieval/ranking and BEFORE pagination and projection;
ordinary ``GET /search`` discovery (``service.search``) and resource-target
search (``resource_items/targets.py``) both consume this seam. Target search is
a second projection over the same engine, not a second search engine.

Three retrieval profiles:

- ``discovery_candidates`` — the ordinary hybrid ``/search`` profile (scope,
  kinds, structured filters). Returns only public ``InternalSearchResult``
  variants; ``service.py`` paginates and projects to ``SearchResultOut``.
- ``link_candidates`` — the ``purpose=link`` hybrid target profile: the central
  hybrid ranking over durable + passage result types (unscoped), plus the
  target-only resource-metadata retrievers (libraries, generated outputs,
  passage anchors).
- ``reference_candidates`` — the ``purpose=reference`` lexical target profile:
  one-character-capable exact/prefix/substring ILIKE + FTS over direct targets
  only. It structurally never reaches ``build_query_embedding`` (no call site).

Target-only candidate types never enter ``SEARCH_RESULT_TYPES``/``SearchKind``
(spec-frozen); they are projected by ``resource_items/targets.py`` only.
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_shared_library_exists_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.contributor_credits import (
    contributor_fts_text_sql,
    visible_credit_rows_sql,
)
from nexus.services.contributors import resolve_contributor_ids_by_handles
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.constants import CANDIDATES_PER_TYPE
from nexus.services.search.embedding import _query_has_full_text_terms, build_query_embedding
from nexus.services.search.projection import (
    _result_resource_ref,
    _snippet_around_query,
    _truncate_snippet,
)
from nexus.services.search.ranking import TYPE_WEIGHTS, _normalize_scores_by_type
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedContributorResult,
    _RankedConversationResult,
    _RankedHighlightResult,
    _RankedMediaResult,
    _RankedMessageResult,
    _RankedNoteBlockResult,
    _RankedPageResult,
    _RankedPodcastResult,
)
from nexus.services.search.retrievers.contributors import _search_contributors
from nexus.services.search.retrievers.conversations import (
    _search_conversation_artifacts,
    _search_conversations,
    _search_messages,
)
from nexus.services.search.retrievers.highlights import _search_highlights
from nexus.services.search.retrievers.library_content import (
    _search_content_chunks,
    _search_evidence_spans,
    _search_fragments,
)
from nexus.services.search.retrievers.media import _search_media, _search_podcasts
from nexus.services.search.retrievers.notes import _search_note_chunks, _search_pages
from nexus.services.search.retrievers.reader_apparatus import _search_reader_apparatus_items
from nexus.services.search.retrievers.resource_metadata import (
    LibraryCandidate,
    LibraryDossierCandidate,
    OracleReadingCandidate,
    PassageAnchorCandidate,
    ResourceMetadataCandidate,
    _lexical_match_sql,
    _lexical_params,
    _tier_score_sql,
    retrieve_library_candidates,
    retrieve_library_dossier_candidates,
    retrieve_oracle_reading_candidates,
    retrieve_passage_anchor_candidates,
)
from nexus.services.search.retrievers.web import _search_web_results

TargetCandidate = InternalSearchResult | ResourceMetadataCandidate

# Sources the reference profile fans out to before the shared refill loop in
# resource_items/targets.py re-calls with a larger cap.
REFERENCE_CANDIDATES_PER_SOURCE = 50

# Result types the semantic query embedding serves (hybrid invariant: built once).
_SEMANTIC_RESULT_TYPES = ("content_chunk", "page", "note_block")

# The purpose=link hybrid pool: every durable/passage result type of ordinary
# search. web_result (no durable resource) and artifact (conversation-distillate
# rows whose artifact_revision refs the resource graph masks) are excluded; the
# artifact scheme is served by the library-dossier metadata retriever instead.
_LINK_HYBRID_RESULT_TYPES = (
    "media",
    "episode",
    "video",
    "podcast",
    "content_chunk",
    "fragment",
    "contributor",
    "page",
    "note_block",
    "highlight",
    "message",
    "evidence_span",
    "conversation",
    "reader_apparatus_item",
)

_RESULT_TYPE_TO_SCHEME = {
    "media": "media",
    "episode": "media",
    "video": "media",
    "podcast": "podcast",
    "content_chunk": "content_chunk",
    "fragment": "fragment",
    "contributor": "contributor",
    "page": "page",
    "note_block": "note_block",
    "highlight": "highlight",
    "message": "message",
    "evidence_span": "evidence_span",
    "conversation": "conversation",
    "reader_apparatus_item": "reader_apparatus_item",
}


def candidate_resource_ref(candidate: TargetCandidate) -> ResourceRef:
    """Durable ResourceRef identity for one candidate (consumers never map types)."""
    if isinstance(candidate, LibraryCandidate):
        return ResourceRef(scheme="library", id=candidate.id)
    if isinstance(candidate, OracleReadingCandidate):
        return ResourceRef(scheme="oracle_reading", id=candidate.id)
    if isinstance(candidate, LibraryDossierCandidate):
        return ResourceRef(scheme="artifact", id=candidate.id)
    if isinstance(candidate, PassageAnchorCandidate):
        return ResourceRef(scheme="passage_anchor", id=candidate.id)
    return _result_resource_ref(candidate)


def rank_candidates[C: TargetCandidate](candidates: list[C]) -> list[C]:
    """Weight, normalize within type, and sort candidates deterministically in place."""
    for candidate in candidates:
        candidate.score.weighted = candidate.score.raw * TYPE_WEIGHTS[candidate.result_type]
    _normalize_scores_by_type(candidates)
    candidates.sort(
        key=lambda candidate: (
            -candidate.score.normalized,
            candidate.handle
            if isinstance(candidate, _RankedContributorResult)
            else str(candidate.id),
        )
    )
    return candidates


def discovery_candidates(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    has_query: bool,
    result_types: tuple[str, ...],
    scope_type: str,
    scope_id: UUID | None,
    contributor_handles: list[str],
    roles: list[str],
    content_kinds: list[str],
    transaction_active_at_entry: bool,
) -> list[InternalSearchResult]:
    """Ranked candidates for the ordinary hybrid ``/search`` profile.

    Gates (query length, FTS terms, scope authorization) are the caller's;
    this owns embedding build, structured-filter resolution, per-type retrieval,
    and ranking. ``service.search`` paginates + projects the returned list.
    """
    # Hybrid invariant: build the query embedding once for any semantic-capable kind
    # (content_chunk via Documents, page/note_block via Notes), regardless of filters.
    semantic_query_embedding: tuple[str, list[float]] | None = None
    if has_query and any(rt in _SEMANTIC_RESULT_TYPES for rt in result_types):
        semantic_query_embedding = build_query_embedding(
            db, q, list(result_types), transaction_active_at_entry=transaction_active_at_entry
        )

    # None = no contributor filter requested; an empty list = requested handles
    # resolved to nothing (unknown handles drop — D-29), which matches nothing.
    contributor_ids = (
        list(resolve_contributor_ids_by_handles(db, contributor_handles).values())
        if contributor_handles
        else None
    )

    all_results: list[InternalSearchResult] = []
    for result_type in result_types:
        all_results.extend(
            _search_type(
                db,
                viewer_id,
                q,
                has_query,
                result_type,
                semantic_query_embedding,
                scope_type,
                scope_id,
                contributor_ids,
                roles,
                content_kinds,
                CANDIDATES_PER_TYPE,
            )
        )
    return rank_candidates(all_results)


def link_candidates(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    transaction_active_at_entry: bool,
    schemes: Collection[str] | None = None,
    limit_per_source: int = CANDIDATES_PER_TYPE,
) -> list[TargetCandidate]:
    """Ranked candidates for the ``purpose=link`` hybrid target profile.

    Unscoped central hybrid retrieval over durable + passage result types plus
    the target-only metadata retrievers. Queries without full-text terms still
    run the lexical metadata retrievers; the hybrid pool and the embedding build
    are skipped. ``schemes`` restricts retrieval at the source (admission,
    dedupe, exclusions, and pagination stay in ``resource_items/targets.py``).
    """
    query = q.strip()
    if not query:
        return []

    def include(scheme: str) -> bool:
        return schemes is None or scheme in schemes

    out: list[TargetCandidate] = []
    if _query_has_full_text_terms(db, query):
        hybrid_types = [
            rt for rt in _LINK_HYBRID_RESULT_TYPES if include(_RESULT_TYPE_TO_SCHEME[rt])
        ]
        semantic_query_embedding: tuple[str, list[float]] | None = None
        if any(rt in _SEMANTIC_RESULT_TYPES for rt in hybrid_types):
            semantic_query_embedding = build_query_embedding(
                db, query, hybrid_types, transaction_active_at_entry=transaction_active_at_entry
            )
        for result_type in hybrid_types:
            out.extend(
                _search_type(
                    db,
                    viewer_id,
                    query,
                    True,
                    result_type,
                    semantic_query_embedding,
                    "all",
                    None,
                    None,
                    [],
                    [],
                    limit_per_source,
                )
            )
    out.extend(
        _metadata_candidates(db, viewer_id, q=query, include=include, limit=limit_per_source)
    )
    return rank_candidates(out)


def reference_candidates(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    schemes: Collection[str] | None = None,
    limit_per_source: int = REFERENCE_CANDIDATES_PER_SOURCE,
) -> list[TargetCandidate]:
    """Ranked candidates for the ``purpose=reference`` lexical target profile.

    Accepts one-character queries; matches exact/prefix/substring ILIKE plus
    FTS; emits direct targets only (never passage candidates); and has no
    ``build_query_embedding`` call site. Note-body substring matching is the
    ported ``search_object_refs`` behavior.
    """
    query = q.strip()
    if not query:
        return []

    def include(scheme: str) -> bool:
        return schemes is None or scheme in schemes

    out: list[TargetCandidate] = []
    if include("page"):
        out.extend(_reference_pages(db, viewer_id, query, limit_per_source))
    if include("note_block"):
        out.extend(_reference_note_blocks(db, viewer_id, query, limit_per_source))
    if include("media"):
        out.extend(_reference_media(db, viewer_id, query, limit_per_source))
    if include("podcast"):
        out.extend(_reference_podcasts(db, viewer_id, query, limit_per_source))
    if include("contributor"):
        out.extend(_reference_contributors(db, viewer_id, query, limit_per_source))
    if include("highlight"):
        out.extend(_reference_highlights(db, viewer_id, query, limit_per_source))
    if include("conversation"):
        out.extend(_reference_conversations(db, viewer_id, query, limit_per_source))
    if include("message"):
        out.extend(_reference_messages(db, viewer_id, query, limit_per_source))
    out.extend(
        _metadata_candidates(db, viewer_id, q=query, include=include, limit=limit_per_source)
    )
    return rank_candidates(out)


def _metadata_candidates(
    db: Session, viewer_id: UUID, *, q: str, include: Callable[[str], bool], limit: int
) -> list[ResourceMetadataCandidate]:
    out: list[ResourceMetadataCandidate] = []
    if include("library"):
        out.extend(retrieve_library_candidates(db, viewer_id=viewer_id, q=q, limit=limit))
    if include("oracle_reading"):
        out.extend(retrieve_oracle_reading_candidates(db, viewer_id=viewer_id, q=q, limit=limit))
    if include("artifact"):
        out.extend(retrieve_library_dossier_candidates(db, viewer_id=viewer_id, q=q, limit=limit))
    if include("passage_anchor"):
        out.extend(retrieve_passage_anchor_candidates(db, viewer_id=viewer_id, q=q, limit=limit))
    return out


# =============================================================================
# purpose=reference lexical retrieval (direct targets; behavior ported from the
# deleted services/object_refs.py::search_object_refs, now escaped and scored)
# =============================================================================


def _reference_pages(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    rows = db.execute(
        text(
            f"""
            SELECT p.id, p.title, {_tier_score_sql("p.title", "p.title")} AS score
            FROM pages p
            WHERE p.user_id = :viewer_id
              AND {_lexical_match_sql("p.title")}
            ORDER BY score DESC, p.title ASC, p.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedPageResult(
            id=row[0],
            title=str(row[1]),
            snippet=_truncate_snippet(str(row[1])),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _reference_note_blocks(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    """Note-body substring matching (the preserved ``@``-picker behavior)."""
    rows = db.execute(
        text(
            f"""
            SELECT nb.id, nb.body_text, {_tier_score_sql("nb.body_text", "nb.body_text")} AS score
            FROM note_blocks nb
            WHERE nb.user_id = :viewer_id
              AND {_lexical_match_sql("nb.body_text")}
            ORDER BY score DESC, nb.updated_at DESC, nb.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedNoteBlockResult(
            id=row[0],
            snippet=_snippet_around_query(str(row[1] or ""), q)
            or _truncate_snippet(str(row[1] or "")),
            body_text=str(row[1] or ""),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _reference_media(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    blob = "concat_ws(' ', m.title, COALESCE(m.description, ''))"
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT m.id, m.kind, m.title, m.published_date,
                   {_tier_score_sql("m.title", blob)} AS score
            FROM media m
            JOIN visible_media vm ON vm.media_id = m.id
            WHERE {_lexical_match_sql(blob)}
            ORDER BY score DESC, m.title ASC, m.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedMediaResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[2] or "")),
            source=_build_search_source(row[0], row[1], row[2], None, row[3]),
            score=_build_search_score(row[4]),
        )
        for row in rows
    ]


def _reference_podcasts(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    blob = "concat_ws(' ', p.title, COALESCE(p.description, ''))"
    rows = db.execute(
        text(
            f"""
            SELECT p.id, p.title, {_tier_score_sql("p.title", blob)} AS score
            FROM podcasts p
            WHERE p.id IN ({visible_podcast_ids_cte_sql()})
              AND {_lexical_match_sql(blob)}
            ORDER BY score DESC, p.title ASC, p.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedPodcastResult(
            id=row[0],
            title=str(row[1]),
            contributors=[],
            snippet=_truncate_snippet(str(row[1])),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _reference_contributors(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    """Credited-visible contributors (canonical D-8 predicate) matched by substring."""
    rows = db.execute(
        text(
            f"""
            WITH
                visible_credits AS ({visible_credit_rows_sql()}),
                visible_gate AS (SELECT DISTINCT contributor_id FROM visible_credits),
                contributor_fts AS ({contributor_fts_text_sql()})
            SELECT c.id, c.handle, c.display_name,
                   {_tier_score_sql("c.display_name", "fts.search_text")} AS score
            FROM contributors c
            JOIN visible_gate cv ON cv.contributor_id = c.id
            JOIN contributor_fts fts ON fts.contributor_id = c.id
            WHERE {_lexical_match_sql("fts.search_text")}
            ORDER BY score DESC, c.display_name ASC, c.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedContributorResult(
            id=row[0],
            handle=str(row[1]),
            display_name=str(row[2]),
            snippet=_truncate_snippet(str(row[2])),
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]


def _reference_highlights(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT h.id, h.exact, h.color, m.id AS media_id, m.kind, m.title,
                   m.published_date, {_tier_score_sql("h.exact", "h.exact")} AS score
            FROM highlights h
            JOIN media m ON m.id = h.anchor_media_id
            JOIN visible_media vm ON vm.media_id = h.anchor_media_id
            WHERE {_lexical_match_sql("h.exact")}
              AND {highlight_shared_library_exists_sql("h")}
            ORDER BY score DESC, h.updated_at DESC, h.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedHighlightResult(
            id=row[0],
            snippet=_snippet_around_query(str(row[1] or ""), q)
            or _truncate_snippet(str(row[1] or "")),
            exact=str(row[1] or ""),
            color=str(row[2] or "yellow"),
            source=_build_search_source(row[3], row[4], row[5], None, row[6]),
            score=_build_search_score(row[7]),
        )
        for row in rows
    ]


def _reference_conversations(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    title = "COALESCE(c.title, '')"
    rows = db.execute(
        text(
            f"""
            WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
            SELECT c.id, c.title, {_tier_score_sql(title, title)} AS score
            FROM conversations c
            JOIN visible_conversations vc ON vc.conversation_id = c.id
            WHERE {_lexical_match_sql(title)}
            ORDER BY score DESC, c.updated_at DESC, c.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedConversationResult(
            id=row[0],
            title=str(row[1] or "Conversation"),
            snippet=_truncate_snippet(str(row[1] or "Conversation")),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _reference_messages(
    db: Session, viewer_id: UUID, q: str, limit: int
) -> list[InternalSearchResult]:
    rows = db.execute(
        text(
            f"""
            WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
            SELECT m.id, m.conversation_id, m.seq, m.content,
                   {_tier_score_sql("m.content", "m.content")} AS score
            FROM messages m
            JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
            WHERE m.status = 'complete'
              AND (
                    m.content ILIKE :contains_pattern
                    OR m.content_tsv @@ websearch_to_tsquery('english', :query)
              )
            ORDER BY score DESC, m.created_at DESC, m.id ASC
            LIMIT :limit
            """
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [
        _RankedMessageResult(
            id=row[0],
            snippet=_snippet_around_query(str(row[3] or ""), q)
            or _truncate_snippet(str(row[3] or "")),
            conversation_id=row[1],
            seq=int(row[2]),
            score=_build_search_score(row[4]),
        )
        for row in rows
    ]


# =============================================================================
# Per-type dispatch (shared by the discovery and link profiles)
# =============================================================================


def _search_type(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    result_type: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    contributor_ids: list[UUID] | None,
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search a specific content type with visibility filtering.

    Returns raw-scored internal results (not yet normalized).
    """
    if result_type == "media":
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
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
            contributor_ids,
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
            contributor_ids,
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
            contributor_ids,
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
            contributor_ids,
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
            contributor_ids,
            roles,
            content_kinds,
            limit,
        )

    # Remaining types do not filter by contributor ids, roles, or content_kinds;
    # any such filter rules out a match entirely.
    if contributor_ids is not None or roles or content_kinds:
        return []

    if result_type == "evidence_span":
        return _search_evidence_spans(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "fragment":
        return _search_fragments(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "reader_apparatus_item":
        return _search_reader_apparatus_items(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "page":
        return _search_pages(
            db, viewer_id, q, semantic_query_embedding, scope_type, scope_id, limit
        )
    if result_type == "note_block":
        return _search_note_chunks(
            db, viewer_id, q, semantic_query_embedding, scope_type, scope_id, limit
        )
    if result_type == "highlight":
        return _search_highlights(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "message":
        return _search_messages(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "conversation":
        return _search_conversations(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "artifact":
        return _search_conversation_artifacts(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "web_result":
        return _search_web_results(db, viewer_id, q, has_query, scope_type, scope_id, limit)
    # Unreachable: result_types are validated at the edge and derived from the kind
    # taxonomy, so an unknown type here is an internal dispatch-invariant violation, not
    # a client error.
    raise ApiError(ApiErrorCode.E_INTERNAL, f"Unhandled search result type: {result_type}")
