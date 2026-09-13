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
  target-only resource-metadata retrievers (libraries, Library Dossiers,
  passage anchors).
- ``reference_candidates`` — the ``purpose=reference`` lexical target profile:
  one-character-capable exact/prefix/substring ILIKE + FTS over direct targets
  only. It structurally never reaches ``build_query_embedding`` (no call site).

Target-only candidate types never enter ``SEARCH_RESULT_TYPES``/``SearchKind``
(spec-frozen); they are projected by ``resource_items/targets.py`` only.
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_visibility_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.contributor_credits import visible_credit_rows_sql
from nexus.services.contributors import resolve_contributor_ids_by_handles
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.constants import CANDIDATES_PER_TYPE
from nexus.services.search.embedding import _query_has_full_text_terms, build_query_embedding
from nexus.services.search.projection import (
    _result_resource_ref,
    _snippet_around_query,
    _truncate_snippet,
)
from nexus.services.search.ranking import (
    MAX_POSITIVE_TYPE_WEIGHT,
    TYPE_WEIGHTS,
    _normalize_scores_by_type,
)
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
    reference_metadata_candidate_sql_parts,
    retrieve_library_artifact_candidates,
    retrieve_library_candidates,
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
# search. web_result (no durable resource) and artifact (Conversation Dossier
# claims) are excluded; the artifact scheme is served by the Library Dossier
# metadata retriever instead.
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
    """Normalize, weight, project to [0, 1], and sort deterministically in place."""
    _normalize_scores_by_type(candidates)
    for candidate in candidates:
        candidate.score.weighted = candidate.score.normalized * TYPE_WEIGHTS[candidate.result_type]
        candidate.score.normalized = candidate.score.weighted / MAX_POSITIVE_TYPE_WEIGHT
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
    highlight_notes_only: bool,
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
    embedding_result_types = (
        (*result_types, "note_block")
        if highlight_notes_only and "note_block" not in result_types
        else result_types
    )
    if has_query and any(rt in _SEMANTIC_RESULT_TYPES for rt in embedding_result_types):
        semantic_query_embedding = build_query_embedding(
            db,
            q,
            list(embedding_result_types),
            transaction_active_at_entry=transaction_active_at_entry,
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
    if highlight_notes_only:
        all_results.extend(
            _search_note_chunks(
                db,
                viewer_id,
                q,
                semantic_query_embedding,
                scope_type,
                scope_id,
                CANDIDATES_PER_TYPE,
                required_origin="highlight_note",
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

    out = _reference_candidates(
        db,
        viewer_id,
        query,
        include=include,
        limit=limit_per_source,
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
        out.extend(retrieve_library_artifact_candidates(db, viewer_id=viewer_id, q=q, limit=limit))
    if include("passage_anchor"):
        out.extend(retrieve_passage_anchor_candidates(db, viewer_id=viewer_id, q=q, limit=limit))
    return out


# =============================================================================
# purpose=reference lexical retrieval (direct targets; behavior ported from the
# deleted services/object_refs.py::search_object_refs, now escaped and scored)
# =============================================================================


def _reference_candidates(
    db: Session,
    viewer_id: UUID,
    q: str,
    *,
    include: Callable[[str], bool],
    limit: int,
) -> list[TargetCandidate]:
    """Retrieve every reference-profile lexical source in one round trip."""
    parts: list[str] = []
    if include("page"):
        parts.append(
            f"""
            (
                SELECT 'page'::text AS result_type, p.id,
                       {_tier_score_sql("p.title", "p.title")} AS score,
                       jsonb_build_object('title', p.title) AS payload
                FROM pages p
                WHERE p.user_id = :viewer_id
                  AND {_lexical_match_sql("p.title")}
                ORDER BY score DESC, p.title ASC, p.id ASC
                LIMIT :limit
            )
            """
        )
    if include("note_block"):
        parts.append(
            f"""
            (
                SELECT 'note_block'::text AS result_type, nb.id,
                       {_tier_score_sql("nb.body_text", "nb.body_text")} AS score,
                       jsonb_build_object('body_text', nb.body_text) AS payload
                FROM note_blocks nb
                WHERE nb.user_id = :viewer_id
                  AND {_lexical_match_sql("nb.body_text")}
                ORDER BY score DESC, nb.updated_at DESC, nb.id ASC
                LIMIT :limit
            )
            """
        )
    if include("media"):
        blob = "concat_ws(' ', m.title, COALESCE(m.description, ''))"
        parts.append(
            f"""
            (
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT 'media'::text AS result_type, m.id,
                       {_tier_score_sql("m.title", blob)} AS score,
                       jsonb_build_object(
                           'media_kind', m.kind,
                           'title', m.title,
                           'published_date', m.published_date
                       ) AS payload
                FROM media m
                JOIN visible_media vm ON vm.media_id = m.id
                WHERE {_lexical_match_sql(blob)}
                ORDER BY score DESC, m.title ASC, m.id ASC
                LIMIT :limit
            )
            """
        )
    if include("podcast"):
        blob = "concat_ws(' ', p.title, COALESCE(p.description, ''))"
        parts.append(
            f"""
            (
                SELECT 'podcast'::text AS result_type, p.id,
                       {_tier_score_sql("p.title", blob)} AS score,
                       jsonb_build_object('title', p.title) AS payload
                FROM podcasts p
                WHERE p.id IN ({visible_podcast_ids_cte_sql()})
                  AND {_lexical_match_sql(blob)}
                ORDER BY score DESC, p.title ASC, p.id ASC
                LIMIT :limit
            )
            """
        )
    if include("contributor"):
        parts.append(
            f"""
            (
                WITH
                    visible_credits AS MATERIALIZED (
                        SELECT contributor_id, credited_name
                        FROM ({visible_credit_rows_sql()}) visible_credit
                    ),
                    visible_credit_text AS MATERIALIZED (
                        SELECT
                            contributor_id,
                            string_agg(
                                DISTINCT credited_name,
                                ' ' ORDER BY credited_name
                            ) AS credited_names
                        FROM visible_credits
                        GROUP BY contributor_id
                    ),
                    alias_text AS MATERIALIZED (
                        SELECT
                            alias.contributor_id,
                            string_agg(alias.alias, ' ' ORDER BY alias.alias) AS aliases
                        FROM contributor_aliases alias
                        JOIN visible_credit_text credit
                          ON credit.contributor_id = alias.contributor_id
                        GROUP BY alias.contributor_id
                    ),
                    candidate_text AS MATERIALIZED (
                        SELECT
                            contributor.id,
                            contributor.handle,
                            contributor.display_name,
                            concat_ws(
                                ' ',
                                contributor.display_name,
                                aliases.aliases,
                                credit.credited_names
                            ) AS search_text
                        FROM visible_credit_text credit
                        JOIN contributors contributor
                          ON contributor.id = credit.contributor_id
                        LEFT JOIN alias_text aliases
                          ON aliases.contributor_id = contributor.id
                    )
                SELECT 'contributor'::text AS result_type, candidate.id,
                       {_tier_score_sql("candidate.display_name", "candidate.search_text")} AS score,
                       jsonb_build_object(
                           'handle', candidate.handle,
                           'display_name', candidate.display_name
                       ) AS payload
                FROM candidate_text candidate
                WHERE {_lexical_match_sql("candidate.search_text")}
                ORDER BY score DESC, candidate.display_name ASC, candidate.id ASC
                LIMIT :limit
            )
            """
        )
    if include("highlight"):
        parts.append(
            f"""
            (
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT 'highlight'::text AS result_type, h.id,
                       {_tier_score_sql("h.exact", "h.exact")} AS score,
                       jsonb_build_object(
                           'exact', h.exact,
                           'color', h.color,
                           'media_id', m.id,
                           'media_kind', m.kind,
                           'media_title', m.title,
                           'published_date', m.published_date
                       ) AS payload
                FROM highlights h
                JOIN media m ON m.id = h.anchor_media_id
                JOIN visible_media vm ON vm.media_id = h.anchor_media_id
                WHERE {_lexical_match_sql("h.exact")}
                  AND {highlight_visibility_sql("h")}
                ORDER BY score DESC, h.updated_at DESC, h.id ASC
                LIMIT :limit
            )
            """
        )
    if include("conversation"):
        title = "COALESCE(c.title, '')"
        parts.append(
            f"""
            (
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT 'conversation'::text AS result_type, c.id,
                       {_tier_score_sql(title, title)} AS score,
                       jsonb_build_object('title', c.title) AS payload
                FROM conversations c
                JOIN visible_conversations vc ON vc.conversation_id = c.id
                WHERE {_lexical_match_sql(title)}
                ORDER BY score DESC, c.updated_at DESC, c.id ASC
                LIMIT :limit
            )
            """
        )
    if include("message"):
        parts.append(
            f"""
            (
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT 'message'::text AS result_type, m.id,
                       {_tier_score_sql("m.content", "m.content")} AS score,
                       jsonb_build_object(
                           'conversation_id', m.conversation_id,
                           'seq', m.seq,
                           'content', m.content
                       ) AS payload
                FROM messages m
                JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
                WHERE m.status = 'complete'
                  AND (
                        m.content ILIKE :contains_pattern
                        OR m.content_tsv @@ websearch_to_tsquery('english', :query)
                  )
                ORDER BY score DESC, m.created_at DESC, m.id ASC
                LIMIT :limit
            )
            """
        )
    parts.extend(reference_metadata_candidate_sql_parts(include))
    if not parts:
        return []

    rows = db.execute(
        text(
            "SELECT result_type, id, score, payload FROM ("
            + " UNION ALL ".join(parts)
            + ") direct_candidates"
        ),
        _lexical_params(viewer_id, q, limit),
    ).fetchall()
    return [_reference_candidate(row, q) for row in rows]


def _reference_candidate(
    row: Row[tuple[object, object, object, object]], q: str
) -> TargetCandidate:
    result_type = str(row[0])
    candidate_id = row[1]
    score = _build_search_score(row[2])
    raw_payload = row[3]
    if not isinstance(candidate_id, UUID) or not isinstance(raw_payload, dict):
        raise AssertionError("direct reference candidate row violated its typed SQL contract")
    payload = cast(dict[str, object], raw_payload)

    if result_type == "page":
        title = str(payload["title"])
        return _RankedPageResult(
            id=candidate_id,
            title=title,
            snippet=_truncate_snippet(title),
            score=score,
        )
    if result_type == "note_block":
        body_text = str(payload.get("body_text") or "")
        return _RankedNoteBlockResult(
            id=candidate_id,
            snippet=_snippet_around_query(body_text, q) or _truncate_snippet(body_text),
            body_text=body_text,
            score=score,
        )
    if result_type == "media":
        title = str(payload.get("title") or "")
        return _RankedMediaResult(
            id=candidate_id,
            snippet=_truncate_snippet(title),
            source=_build_search_source(
                candidate_id,
                str(payload["media_kind"]),
                title,
                None,
                payload.get("published_date"),
            ),
            score=score,
        )
    if result_type == "podcast":
        title = str(payload["title"])
        return _RankedPodcastResult(
            id=candidate_id,
            title=title,
            contributors=[],
            snippet=_truncate_snippet(title),
            score=score,
        )
    if result_type == "contributor":
        display_name = str(payload["display_name"])
        return _RankedContributorResult(
            id=candidate_id,
            handle=str(payload["handle"]),
            display_name=display_name,
            snippet=_truncate_snippet(display_name),
            score=score,
        )
    if result_type == "highlight":
        exact = str(payload.get("exact") or "")
        media_id = UUID(str(payload["media_id"]))
        return _RankedHighlightResult(
            id=candidate_id,
            snippet=_snippet_around_query(exact, q) or _truncate_snippet(exact),
            exact=exact,
            color=str(payload.get("color") or "yellow"),
            source=_build_search_source(
                media_id,
                str(payload["media_kind"]),
                str(payload.get("media_title") or ""),
                None,
                payload.get("published_date"),
            ),
            score=score,
        )
    if result_type == "conversation":
        title = str(payload.get("title") or "Conversation")
        return _RankedConversationResult(
            id=candidate_id,
            title=title,
            snippet=_truncate_snippet(title),
            score=score,
        )
    if result_type == "message":
        content = str(payload.get("content") or "")
        return _RankedMessageResult(
            id=candidate_id,
            snippet=_snippet_around_query(content, q) or _truncate_snippet(content),
            conversation_id=UUID(str(payload["conversation_id"])),
            seq=int(str(payload["seq"])),
            score=score,
        )
    if result_type == "library":
        name = str(payload["name"])
        return LibraryCandidate(
            id=candidate_id,
            name=name,
            snippet=_truncate_snippet(name),
            score=score,
        )
    if result_type == "oracle_reading":
        question_text = str(payload["question_text"])
        blob = str(payload.get("blob") or "")
        return OracleReadingCandidate(
            id=candidate_id,
            question_text=question_text,
            snippet=_snippet_around_query(blob, q) or _truncate_snippet(question_text),
            score=score,
        )
    if result_type == "artifact":
        library_name = str(payload["library_name"])
        content_text = str(payload.get("content_text") or "")
        return LibraryDossierCandidate(
            id=candidate_id,
            library_id=UUID(str(payload["library_id"])),
            library_name=library_name,
            snippet=_snippet_around_query(content_text, q)
            or _truncate_snippet(content_text or library_name),
            score=score,
        )
    if result_type == "passage_anchor":
        exact = str(payload.get("exact") or "")
        return PassageAnchorCandidate(
            id=candidate_id,
            owner_scheme=str(payload["owner_scheme"]),
            owner_id=UUID(str(payload["owner_id"])),
            exact=exact,
            snippet=_snippet_around_query(exact, q) or _truncate_snippet(exact),
            score=score,
        )
    raise AssertionError(f"unsupported reference candidate type: {result_type}")


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
