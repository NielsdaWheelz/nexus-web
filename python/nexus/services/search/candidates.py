"""Candidate retrieval for linking and the route-only omnibox.

Linking combines hybrid search with visible metadata and passage candidates.
The omnibox uses the lexical resource query. Admission and paging belong to
resource_items; this module retrieves and ranks.
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_visibility_sql,
    visible_content_credit_rows_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.services.dossier.subjects import head_visible_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.projection import (
    _result_resource_ref,
    _snippet_around_query,
    _truncate_snippet,
)
from nexus.services.search.query import CANDIDATES_PER_TYPE, SEMANTIC_RESULT_TYPES
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
    _SearchScore,
    rank_candidates,
)
from nexus.services.search.retrievers import retrieve
from nexus.services.search.service import _query_has_full_text_terms, build_query_embedding
from nexus.text import escape_like

LEXICAL_CANDIDATES_PER_SOURCE = 50

# Ordinary durable and passage result families. Artifact heads and the extra
# passage families are supplied by the metadata query below.
_LINK_HYBRID_TYPES = (
    ("media", "media"),
    ("episode", "media"),
    ("video", "media"),
    ("podcast", "podcast"),
    ("content_chunk", "content_chunk"),
    ("fragment", "fragment"),
    ("contributor", "contributor"),
    ("page", "page"),
    ("note_block", "note_block"),
    ("highlight", "highlight"),
    ("message", "message"),
    ("conversation", "conversation"),
    ("reader_apparatus_item", "reader_apparatus_item"),
)


@dataclass(slots=True)
class LibraryCandidate:
    id: UUID
    name: str
    snippet: str
    score: _SearchScore
    result_type: Literal["library"] = "library"


@dataclass(slots=True)
class OracleReadingCandidate:
    id: UUID
    question_text: str
    snippet: str
    score: _SearchScore
    result_type: Literal["oracle_reading"] = "oracle_reading"


@dataclass(slots=True)
class ArtifactCandidate:
    id: UUID
    snippet: str
    score: _SearchScore
    result_type: Literal["artifact"] = "artifact"


@dataclass(slots=True)
class PassageCandidate:
    id: UUID
    snippet: str
    score: _SearchScore
    result_type: Literal["evidence_span", "oracle_passage_anchor"]


@dataclass(slots=True)
class PassageAnchorCandidate:
    id: UUID
    owner_scheme: str  # "media" | "note_block"
    owner_id: UUID
    exact: str
    snippet: str
    score: _SearchScore
    result_type: Literal["passage_anchor"] = "passage_anchor"


ResourceMetadataCandidate = (
    LibraryCandidate
    | OracleReadingCandidate
    | ArtifactCandidate
    | PassageAnchorCandidate
    | PassageCandidate
)
TargetCandidate = InternalSearchResult | ResourceMetadataCandidate


def candidate_resource_ref(candidate: TargetCandidate) -> ResourceRef:
    """Durable ResourceRef identity for one candidate (consumers never map types)."""
    if isinstance(candidate, LibraryCandidate):
        return ResourceRef(scheme="library", id=candidate.id)
    if isinstance(candidate, OracleReadingCandidate):
        return ResourceRef(scheme="oracle_reading", id=candidate.id)
    if isinstance(candidate, ArtifactCandidate):
        return ResourceRef(scheme="artifact", id=candidate.id)
    if isinstance(candidate, PassageAnchorCandidate):
        return ResourceRef(scheme="passage_anchor", id=candidate.id)
    if isinstance(candidate, PassageCandidate):
        return ResourceRef(scheme=candidate.result_type, id=candidate.id)
    return _result_resource_ref(candidate)


def link_candidates(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    transaction_active_at_entry: bool,
    schemes: Collection[str] | None = None,
    limit_per_source: int = CANDIDATES_PER_TYPE,
) -> list[TargetCandidate]:
    """Unscoped hybrid retrieval plus the target-only metadata sources.

    A query with no full-text terms still runs the lexical metadata sources;
    the hybrid pool and the embedding build are skipped.
    """
    query = q.strip()
    if not query:
        return []

    def include(scheme: str) -> bool:
        return schemes is None or scheme in schemes

    out: list[TargetCandidate] = []
    if _query_has_full_text_terms(db, query):
        types = [rt for rt, scheme in _LINK_HYBRID_TYPES if include(scheme)]
        embedding = None
        if any(rt in SEMANTIC_RESULT_TYPES for rt in types):
            embedding = build_query_embedding(
                db, query, types, transaction_active_at_entry=transaction_active_at_entry
            )
        for result_type in types:
            out.extend(
                retrieve(
                    db,
                    viewer_id,
                    result_type=result_type,
                    q=query,
                    has_query=True,
                    semantic_embedding=embedding,
                    scope_type="all",
                    scope_id=None,
                    contributor_ids=None,
                    roles=(),
                    content_kinds=(),
                    limit=limit_per_source,
                )
            )
    out.extend(
        _union(
            db,
            _metadata_parts(include) + _passage_parts(include),
            viewer_id=viewer_id,
            q=query,
            limit=limit_per_source,
        )
    )
    return rank_candidates(out)


def lexical_resource_candidates(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    schemes: Collection[str] | None = None,
    limit_per_source: int = LEXICAL_CANDIDATES_PER_SOURCE,
) -> list[TargetCandidate]:
    """One lexical UNION over direct targets: exact/prefix/substring ILIKE plus FTS.

    Accepts one-character queries, emits direct targets only (never passages),
    and has no embedding call site.
    """
    query = q.strip()
    if not query:
        return []

    def include(scheme: str) -> bool:
        return schemes is None or scheme in schemes

    parts = _direct_parts(include) + _metadata_parts(include)
    return rank_candidates(_union(db, parts, viewer_id=viewer_id, q=query, limit=limit_per_source))


# =============================================================================
# The lexical UNION: exact/prefix/substring tiers plus an FTS bonus
# =============================================================================


def _tier_score(title: str, blob: str) -> str:
    return f"""(
        CASE WHEN lower({title}) = lower(:query) THEN 4.0
             WHEN {title} ILIKE :prefix_pattern THEN 3.0
             WHEN {blob} ILIKE :contains_pattern THEN 2.0
             ELSE 0.0 END
        + ts_rank_cd(to_tsvector('english', {blob}), websearch_to_tsquery('english', :query)) * 2.0
    )"""


def _matches(blob: str) -> str:
    return (
        f"({blob} ILIKE :contains_pattern"
        f" OR to_tsvector('english', {blob}) @@ websearch_to_tsquery('english', :query))"
    )


def _branch(result_type: str, sql: str) -> str:
    return f"(SELECT '{result_type}'::text AS result_type, {sql})"


def _direct_parts(include: Callable[[str], bool]) -> list[str]:
    """One UNION branch per direct target source."""
    media_blob = "concat_ws(' ', m.title, COALESCE(m.description, ''))"
    podcast_blob = "concat_ws(' ', p.title, COALESCE(p.description, ''))"
    title = "COALESCE(c.title, '')"
    parts: list[str] = []
    if include("page"):
        parts.append(
            _branch(
                "page",
                f"""p.id, {_tier_score("p.title", "p.title")} AS score,
                jsonb_build_object('title', p.title) AS payload
                FROM pages p
                WHERE p.user_id = :viewer_id AND {_matches("p.title")}
                ORDER BY score DESC, p.title ASC, p.id ASC LIMIT :limit""",
            )
        )
    if include("note_block"):
        parts.append(
            _branch(
                "note_block",
                f"""nb.id, {_tier_score("nb.body_text", "nb.body_text")} AS score,
                jsonb_build_object('body_text', nb.body_text) AS payload
                FROM note_blocks nb
                WHERE nb.user_id = :viewer_id AND {_matches("nb.body_text")}
                ORDER BY score DESC, nb.updated_at DESC, nb.id ASC LIMIT :limit""",
            )
        )
    if include("media"):
        parts.append(
            _branch(
                "media",
                f"""m.id, {_tier_score("m.title", media_blob)} AS score,
                jsonb_build_object('media_kind', m.kind, 'title', m.title,
                    'original_published_date', m.original_published_date) AS payload
                FROM media m
                JOIN ({visible_media_ids_cte_sql()}) vm ON vm.media_id = m.id
                WHERE {_matches(media_blob)}
                ORDER BY score DESC, m.title ASC, m.id ASC LIMIT :limit""",
            )
        )
    if include("podcast"):
        parts.append(
            _branch(
                "podcast",
                f"""p.id, {_tier_score("p.title", podcast_blob)} AS score,
                jsonb_build_object('title', p.title) AS payload
                FROM podcasts p
                WHERE p.id IN ({visible_podcast_ids_cte_sql()}) AND {_matches(podcast_blob)}
                ORDER BY score DESC, p.title ASC, p.id ASC LIMIT :limit""",
            )
        )
    if include("contributor"):
        parts.append(_contributor_branch())
    if include("highlight"):
        parts.append(
            _branch(
                "highlight",
                f"""h.id, {_tier_score("h.exact", "h.exact")} AS score,
                jsonb_build_object('exact', h.exact, 'color', h.color, 'media_id', m.id,
                    'media_kind', m.kind, 'media_title', m.title,
                    'original_published_date', m.original_published_date) AS payload
                FROM highlights h
                JOIN media m ON m.id = h.anchor_media_id
                JOIN ({visible_media_ids_cte_sql()}) vm ON vm.media_id = h.anchor_media_id
                WHERE {_matches("h.exact")} AND {highlight_visibility_sql("h")}
                ORDER BY score DESC, h.updated_at DESC, h.id ASC LIMIT :limit""",
            )
        )
    if include("conversation"):
        parts.append(
            _branch(
                "conversation",
                f"""c.id, {_tier_score(title, title)} AS score,
                jsonb_build_object('title', c.title) AS payload
                FROM conversations c
                JOIN ({visible_conversation_ids_cte_sql()}) vc ON vc.conversation_id = c.id
                WHERE {_matches(title)}
                ORDER BY score DESC, c.updated_at DESC, c.id ASC LIMIT :limit""",
            )
        )
    if include("message"):
        parts.append(
            _branch(
                "message",
                f"""m.id, {_tier_score("m.content", "m.content")} AS score,
                jsonb_build_object('conversation_id', m.conversation_id, 'seq', m.seq,
                    'content', m.content) AS payload
                FROM messages m
                JOIN ({visible_conversation_ids_cte_sql()}) vc
                  ON vc.conversation_id = m.conversation_id
                WHERE m.status = 'complete'
                  AND (m.content ILIKE :contains_pattern
                       OR m.content_tsv @@ websearch_to_tsquery('english', :query))
                ORDER BY score DESC, m.created_at DESC, m.id ASC LIMIT :limit""",
            )
        )
    return parts


def _contributor_branch() -> str:
    """Display name + human aliases + visible credited names; never an external key."""
    return f"""
        (
            WITH visible_credits AS MATERIALIZED (
                    SELECT contributor_id, credited_name
                    FROM ({visible_content_credit_rows_sql()}) visible_credit
                 ),
                 visible_credit_text AS MATERIALIZED (
                    SELECT contributor_id,
                           string_agg(DISTINCT credited_name, ' ' ORDER BY credited_name)
                               AS credited_names
                    FROM visible_credits GROUP BY contributor_id
                 ),
                 alias_text AS MATERIALIZED (
                    SELECT alias.contributor_id,
                           string_agg(alias.alias, ' ' ORDER BY alias.alias) AS aliases
                    FROM contributor_aliases alias
                    JOIN visible_credit_text credit
                      ON credit.contributor_id = alias.contributor_id
                    GROUP BY alias.contributor_id
                 ),
                 candidate_text AS MATERIALIZED (
                    SELECT contributor.id, contributor.handle, contributor.display_name,
                           concat_ws(' ', contributor.display_name, aliases.aliases,
                                     credit.credited_names) AS search_text
                    FROM visible_credit_text credit
                    JOIN contributors contributor ON contributor.id = credit.contributor_id
                    LEFT JOIN alias_text aliases ON aliases.contributor_id = contributor.id
                 )
            SELECT 'contributor'::text AS result_type, candidate.id,
                   {_tier_score("candidate.display_name", "candidate.search_text")} AS score,
                   jsonb_build_object('handle', candidate.handle,
                       'display_name', candidate.display_name) AS payload
            FROM candidate_text candidate
            WHERE {_matches("candidate.search_text")}
            ORDER BY score DESC, candidate.display_name ASC, candidate.id ASC
            LIMIT :limit
        )
    """


def _metadata_parts(include: Callable[[str], bool]) -> list[str]:
    """Visible libraries, readings, dossier heads and saved passage anchors."""
    library_name = "CASE WHEN l.is_default THEN 'All' ELSE l.name END"
    reading_blob = """concat_ws(' ', r.question_text, COALESCE(r.folio_motto, ''),
        COALESCE(r.interpretation_text, ''))"""
    anchor_exact = "(pa.selector #>> '{quote,exact}')"
    parts: list[str] = []
    if include("library"):
        parts.append(
            _branch(
                "library",
                f"""l.id, {_tier_score("l.name", "l.name")} AS score,
                jsonb_build_object('name', l.name) AS payload
                FROM (SELECT id, {library_name.replace("l.", "")} AS name FROM libraries) l
                JOIN memberships mem ON mem.library_id = l.id AND mem.user_id = :viewer_id
                WHERE {_matches("l.name")}
                ORDER BY score DESC, l.name ASC, l.id ASC LIMIT :limit""",
            )
        )
    if include("oracle_reading"):
        parts.append(
            _branch(
                "oracle_reading",
                f"""r.id, {_tier_score("r.question_text", reading_blob)} AS score,
                jsonb_build_object('question_text', r.question_text,
                    'blob', {reading_blob}) AS payload
                FROM oracle_readings r
                WHERE r.user_id = :viewer_id AND {_matches(reading_blob)}
                ORDER BY score DESC, r.created_at DESC, r.id ASC LIMIT :limit""",
            )
        )
    if include("artifact"):
        subject_title = """COALESCE(m.title, c.title,
            CASE WHEN l.is_default THEN 'All' ELSE l.name END, p.title, co.display_name,
            pg.title, nb.body_text, idea.display_title, 'Dossier')"""
        blob = f"concat_ws(' ', {subject_title}, a.content_text)"
        parts.append(
            _branch(
                "artifact",
                f"""a.id, {_tier_score(subject_title, blob)} AS score,
                jsonb_build_object('content_text', {blob}) AS payload
                FROM artifacts a
                LEFT JOIN media m ON a.subject_scheme = 'media' AND m.id = a.subject_id
                LEFT JOIN conversations c ON a.subject_scheme = 'conversation' AND c.id = a.subject_id
                LEFT JOIN libraries l ON a.subject_scheme = 'library' AND l.id = a.subject_id
                LEFT JOIN podcasts p ON a.subject_scheme = 'podcast' AND p.id = a.subject_id
                LEFT JOIN contributors co ON a.subject_scheme = 'contributor' AND co.id = a.subject_id
                LEFT JOIN pages pg ON a.subject_scheme = 'page' AND pg.id = a.subject_id
                LEFT JOIN note_blocks nb ON a.subject_scheme = 'note_block' AND nb.id = a.subject_id
                LEFT JOIN artifact_idea_subjects idea ON a.subject_scheme = 'idea' AND idea.id = a.subject_id
                WHERE {head_visible_sql("a")} AND {_matches(blob)}
                ORDER BY score DESC, a.id ASC LIMIT :limit""",
            )
        )
    if include("passage_anchor"):
        parts.append(
            _branch(
                "passage_anchor",
                f"""pa.id, {_tier_score(anchor_exact, anchor_exact)} AS score,
                jsonb_build_object('owner_scheme', pa.owner_scheme, 'owner_id', pa.owner_id,
                    'exact', {anchor_exact}) AS payload
                FROM passage_anchors pa
                WHERE pa.user_id = :viewer_id
                  AND ((pa.owner_scheme = 'media'
                        AND pa.owner_id IN ({visible_media_ids_cte_sql()}))
                    OR (pa.owner_scheme = 'note_block'
                        AND pa.owner_id IN (SELECT id FROM note_blocks
                                            WHERE user_id = :viewer_id)))
                  AND {_matches(anchor_exact)}
                ORDER BY score DESC, pa.created_at DESC, pa.id ASC LIMIT :limit""",
            )
        )
    return parts


def _passage_parts(include: Callable[[str], bool]) -> list[str]:
    parts: list[str] = []
    if include("evidence_span"):
        parts.append(
            _branch(
                "evidence_span",
                f"""es.id, {_tier_score("es.span_text", "es.span_text")} AS score,
                jsonb_build_object('exact', es.span_text) AS payload
                FROM evidence_spans es
                WHERE ((es.owner_kind = 'media'
                        AND es.owner_id IN ({visible_media_ids_cte_sql()}))
                    OR (es.owner_kind = 'note_block' AND es.owner_id IN
                        (SELECT id FROM note_blocks WHERE user_id = :viewer_id)))
                  AND {_matches("es.span_text")}
                ORDER BY score DESC, es.id ASC LIMIT :limit""",
            )
        )
    if include("oracle_passage_anchor"):
        exact = "COALESCE(es.span_text, cc.chunk_text)"
        parts.append(
            _branch(
                "oracle_passage_anchor",
                f"""a.id, {_tier_score("a.display_label", exact)} AS score,
                jsonb_build_object('exact', {exact}) AS payload
                FROM oracle_passage_anchors a
                JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
                JOIN content_chunks cc ON cc.id = a.current_content_chunk_id
                    AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id
                LEFT JOIN evidence_spans es ON es.id = a.current_evidence_span_id
                    AND es.owner_kind = 'media' AND es.owner_id = s.media_id
                WHERE a.resolution_status = 'resolved'
                  AND (a.current_evidence_span_id IS NULL OR es.id IS NOT NULL)
                  AND s.media_id IN ({visible_media_ids_cte_sql()})
                  AND {_matches(f"concat_ws(' ', a.display_label, {exact})")}
                ORDER BY score DESC, a.id ASC LIMIT :limit""",
            )
        )
    return parts


def _union(
    db: Session, parts: list[str], *, viewer_id: UUID, q: str, limit: int
) -> list[TargetCandidate]:
    """Run one UNION ALL over the typed candidate branches and map each row."""
    if not parts:
        return []
    escaped = escape_like(q)
    rows = db.execute(
        text(
            "SELECT result_type, id, score, payload FROM ("
            + " UNION ALL ".join(parts)
            + ") direct_candidates"
        ),
        {
            "viewer_id": viewer_id,
            "query": q,
            "prefix_pattern": f"{escaped}%",
            "contains_pattern": f"%{escaped}%",
            "limit": limit,
        },
    ).all()
    return [_candidate(str(row[0]), row[1], _build_search_score(row[2]), row[3], q) for row in rows]


def _candidate(
    result_type: str, candidate_id: Any, score: _SearchScore, raw: Any, q: str
) -> TargetCandidate:
    if not isinstance(candidate_id, UUID) or not isinstance(raw, dict):
        raise AssertionError("resource candidate row violated its typed SQL contract")
    payload = cast(dict[str, Any], raw)
    text_of = str(payload.get("title") or "")

    if result_type == "page":
        return _RankedPageResult(candidate_id, text_of, _truncate_snippet(text_of), score)
    if result_type == "note_block":
        body = str(payload.get("body_text") or "")
        return _RankedNoteBlockResult(
            candidate_id, _snippet_around_query(body, q) or _truncate_snippet(body), body, score
        )
    if result_type == "media":
        return _RankedMediaResult(
            candidate_id,
            _truncate_snippet(text_of),
            _build_search_source(
                candidate_id,
                str(payload["media_kind"]),
                text_of,
                None,
                payload.get("original_published_date"),
            ),
            score,
        )
    if result_type == "podcast":
        return _RankedPodcastResult(candidate_id, text_of, [], _truncate_snippet(text_of), score)
    if result_type == "contributor":
        name = str(payload["display_name"])
        return _RankedContributorResult(
            candidate_id, str(payload["handle"]), name, _truncate_snippet(name), score
        )
    if result_type == "highlight":
        exact = str(payload.get("exact") or "")
        return _RankedHighlightResult(
            candidate_id,
            _snippet_around_query(exact, q) or _truncate_snippet(exact),
            exact,
            str(payload.get("color") or "yellow"),
            _build_search_source(
                UUID(str(payload["media_id"])),
                str(payload["media_kind"]),
                str(payload.get("media_title") or ""),
                None,
                payload.get("original_published_date"),
            ),
            score,
        )
    if result_type == "conversation":
        title = str(payload.get("title") or "Conversation")
        return _RankedConversationResult(candidate_id, title, _truncate_snippet(title), score)
    if result_type == "message":
        content = str(payload.get("content") or "")
        return _RankedMessageResult(
            candidate_id,
            _snippet_around_query(content, q) or _truncate_snippet(content),
            UUID(str(payload["conversation_id"])),
            int(str(payload["seq"])),
            score,
        )
    if result_type == "library":
        name = str(payload["name"])
        return LibraryCandidate(candidate_id, name, _truncate_snippet(name), score)
    if result_type == "oracle_reading":
        question = str(payload["question_text"])
        blob = str(payload.get("blob") or "")
        return OracleReadingCandidate(
            candidate_id,
            question,
            _snippet_around_query(blob, q) or _truncate_snippet(question),
            score,
        )
    if result_type == "artifact":
        content = str(payload.get("content_text") or "")
        return ArtifactCandidate(
            candidate_id, _snippet_around_query(content, q) or _truncate_snippet(content), score
        )
    if result_type in ("evidence_span", "oracle_passage_anchor"):
        exact = str(payload["exact"])
        return PassageCandidate(
            candidate_id,
            _snippet_around_query(exact, q) or _truncate_snippet(exact),
            score,
            result_type,
        )
    if result_type == "passage_anchor":
        exact = str(payload.get("exact") or "")
        return PassageAnchorCandidate(
            candidate_id,
            str(payload["owner_scheme"]),
            UUID(str(payload["owner_id"])),
            exact,
            _snippet_around_query(exact, q) or _truncate_snippet(exact),
            score,
        )
    raise AssertionError(f"unsupported resource candidate type: {result_type}")
