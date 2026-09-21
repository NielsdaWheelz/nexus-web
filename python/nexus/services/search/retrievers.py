"""One retriever, eleven per-kind SQL entries.

Each entry owns a visibility relation, a match/score expression, a projection
and a row mapper. Every match is gated on ``:has_query``, so the same entry
serves discovery (scored, scoped, capped), a structured-filter-only query, and
the by-id reopen a citation re-materializes through.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
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
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import retrieval_locator_json, retrieval_result_ref_json
from nexus.schemas.search import SearchResultSourceOut
from nexus.services.contributor_credits import (
    contributor_credits_rollup_cte_sql,
    contributor_fts_text_sql,
    credit_target_filter_exists_sql,
)
from nexus.services.search.chunks import search_content_chunks, search_note_chunks
from nexus.services.search.projection import _required_locator, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _parse_contributor_credits,
    _RankedArtifactResult,
    _RankedContributorResult,
    _RankedConversationResult,
    _RankedFragmentResult,
    _RankedHighlightResult,
    _RankedMediaResult,
    _RankedMessageResult,
    _RankedPageResult,
    _RankedPodcastResult,
    _RankedReaderApparatusItemResult,
    _RankedWebResult,
    _SearchScore,
)
from nexus.services.search.scope import scope_filter_sql

Row = Mapping[Any, Any]  # a SQLAlchemy RowMapping, read by column name
Fts = tuple[str, str, str]  # (match, score, snippet)

_HEADLINE = "'MaxWords=50, MinWords=10, MaxFragments=1'"
_TSQUERY = "websearch_to_tsquery('english', :query)"
_MEDIA_TYPES: dict[str, Literal["media", "episode", "video"]] = {
    "media": "media",
    "episode": "episode",
    "video": "video",
}
# episode/video are the media relation with one storage kind forced.
_FORCED_STORAGE_KIND = {"episode": "podcast_episode", "video": "video"}
_MEDIA_CTES = f"""visible_media AS ({visible_media_ids_cte_sql()}),
             media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})"""


def _fts(blob: str, fallback: str, *, vector: str | None = None, opts: str = _HEADLINE) -> Fts:
    """Match, rank and headline one blob, all skipped when ``:has_query`` is false.

    The false branch is what a structured-filter-only query and the by-id
    reopen both take: the whole relation matches and the row carries its own
    plain text instead of a headline.
    """
    tsv = vector or f"to_tsvector('english', {blob})"
    return (
        f"(:has_query IS FALSE OR {tsv} @@ {_TSQUERY})",
        f"CASE WHEN :has_query THEN ts_rank_cd({tsv}, {_TSQUERY}) ELSE 0.0 END",
        f"CASE WHEN :has_query THEN ts_headline('english', {blob}, {_TSQUERY}, {opts})"
        f" ELSE {fallback} END",
    )


def _source(row: Row, media_id: Any, media_kind: Any) -> SearchResultSourceOut:
    return _build_search_source(
        media_id,
        media_kind,
        row["title"],
        row["contributor_credits"],
        row["original_published_date"],
    )


@dataclass(frozen=True, slots=True)
class _Filters:
    """The structured refinements only credited relations can honour."""

    contributor_ids: list[UUID] | None = None
    roles: tuple[str, ...] = ()
    content_kinds: tuple[str, ...] = ()

    @property
    def present(self) -> bool:
        return self.contributor_ids is not None or bool(self.roles or self.content_kinds)


@dataclass(frozen=True, slots=True)
class _Kind:
    entity: str  # the scope-matrix key
    tie: str  # deterministic ORDER BY tail after score
    sql: Callable[[str, str, str], str]  # (ident, filters, scope)
    build: Callable[[Row, _SearchScore, str | None, str], InternalSearchResult | None]
    id_column: str | None = None  # None ⇒ discovery-only, reopen is 404
    filters: Callable[[_Filters, dict[str, Any]], str] | None = None


# =============================================================================
# Media, episodes, videos, podcasts
# =============================================================================

_MEDIA_BLOB = """concat_ws(' ', m.title, COALESCE(m.description, ''),
                    COALESCE(m.publisher, ''), COALESCE(mcc.contributor_search_text, ''))"""
_PODCAST_BLOB = """concat_ws(' ', p.title, COALESCE(p.description, ''),
                    COALESCE(pcc.contributor_search_text, ''))"""


def _media_sql(ident: str, filters: str, scope: str) -> str:
    match, score, snippet = _fts(_MEDIA_BLOB, "m.title")
    return f"""
        WITH {_MEDIA_CTES}
        SELECT m.id, m.title, m.kind, m.original_published_date, mcc.contributor_credits,
               {score} AS score, {snippet} AS snippet
        FROM media m
        JOIN visible_media vm ON vm.media_id = m.id
        LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
        WHERE {match} {ident} {scope} {filters}
    """


def _podcast_sql(ident: str, filters: str, scope: str) -> str:
    match, score, snippet = _fts(_PODCAST_BLOB, "p.title")
    return f"""
        WITH visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
             podcast_contributor_credits AS ({contributor_credits_rollup_cte_sql("podcast_id")})
        SELECT p.id, p.title, pcc.contributor_credits, {score} AS score, {snippet} AS snippet
        FROM podcasts p
        JOIN visible_podcasts vp ON vp.podcast_id = p.id
        LEFT JOIN podcast_contributor_credits pcc ON pcc.podcast_id = p.id
        WHERE {match} {scope} {filters}
    """


def _media_filters(filters: _Filters, params: dict[str, Any]) -> str:
    if filters.content_kinds:
        params["content_kinds"] = list(filters.content_kinds)
        clause = "AND m.kind = ANY(:content_kinds)"
    else:
        clause = "AND m.kind NOT IN ('podcast_episode', 'video')"
    return clause + _credit_filter(filters, params, "media_id", "m.id")


def _podcast_filters(filters: _Filters, params: dict[str, Any]) -> str:
    return _credit_filter(filters, params, "podcast_id", "p.id")


def _credit_filter(
    filters: _Filters,
    params: dict[str, Any],
    owner_column: Literal["media_id", "podcast_id"],
    owner_id_expr: str,
) -> str:
    if filters.contributor_ids is None and not filters.roles:
        return ""
    if filters.contributor_ids is not None:
        params["contributor_ids"] = filters.contributor_ids
    if filters.roles:
        params["roles"] = list(filters.roles)
    return credit_target_filter_exists_sql(
        owner_column,
        owner_id_expr,
        filter_contributor_ids=filters.contributor_ids is not None,
        filter_roles=bool(filters.roles),
    )


def _media_row(row: Row, score: _SearchScore, q: str | None, kind: str) -> _RankedMediaResult:
    return _RankedMediaResult(
        id=row["id"],
        snippet=_truncate_snippet(str(row["snippet"] or row["title"])),
        source=_source(row, row["id"], row["kind"]),
        score=score,
        result_type=_MEDIA_TYPES[kind],
    )


def _podcast_row(row: Row, score: _SearchScore, q: str | None, kind: str) -> _RankedPodcastResult:
    return _RankedPodcastResult(
        id=row["id"],
        title=row["title"],
        contributors=_parse_contributor_credits(row["contributor_credits"]),
        snippet=_truncate_snippet(str(row["snippet"] or row["title"])),
        score=score,
    )


# =============================================================================
# Contributors — one surfaces only with at least one visible credited target
# =============================================================================


def _contributor_sql(ident: str, filters: str, scope: str) -> str:
    match, score, snippet = _fts("fts.search_text", "c.display_name")
    return f"""
        WITH scoped_credits AS (
                 SELECT cc.* FROM ({visible_content_credit_rows_sql()}) cc WHERE TRUE {scope}
             ),
             visible_gate AS (SELECT DISTINCT contributor_id FROM scoped_credits),
             contributor_fts AS ({contributor_fts_text_sql()})
        SELECT c.id, c.handle, c.display_name, {score} AS score, {snippet} AS snippet
        FROM contributors c
        JOIN visible_gate cv ON cv.contributor_id = c.id
        JOIN contributor_fts fts ON fts.contributor_id = c.id
        WHERE {match} {filters}
    """


def _contributor_filters(filters: _Filters, params: dict[str, Any]) -> str:
    clause = ""
    if filters.contributor_ids is not None:
        params["contributor_ids"] = filters.contributor_ids
        clause = "AND c.id = ANY(:contributor_ids)"
    if not (filters.roles or filters.content_kinds):
        return clause
    credit_clauses = ["cc_filter.contributor_id = c.id"]
    if filters.roles:
        params["roles"] = list(filters.roles)
        credit_clauses.append("cc_filter.role = ANY(:roles)")
    if filters.content_kinds:
        params["content_kinds"] = list(filters.content_kinds)
        credit_clauses.append(
            """(
                    EXISTS (SELECT 1 FROM media m_filter
                            WHERE m_filter.id = cc_filter.media_id
                              AND m_filter.kind = ANY(:content_kinds))
                    OR ('podcast' = ANY(:content_kinds) AND cc_filter.podcast_id IS NOT NULL)
                )"""
        )
    return f"""{clause}
            AND EXISTS (SELECT 1 FROM scoped_credits cc_filter
                        WHERE {" AND ".join(credit_clauses)})
        """


def _contributor_row(
    row: Row, score: _SearchScore, q: str | None, kind: str
) -> _RankedContributorResult:
    return _RankedContributorResult(
        id=row["id"],
        handle=str(row["handle"]),
        display_name=str(row["display_name"]),
        snippet=_truncate_snippet(str(row["snippet"] or row["display_name"])),
        score=score,
    )


# =============================================================================
# Pages — title only; a page's linked content is indexed as note blocks
# =============================================================================


def _page_sql(ident: str, filters: str, scope: str) -> str:
    tier = """(CASE WHEN lower(p.title) = lower(:query) THEN 4.0
                        WHEN p.title ILIKE :contains_query THEN 2.0 ELSE 0.0 END
                   + ts_rank_cd(to_tsvector('english', p.title), qt.tsq) * 2.0)"""
    headline = "ts_headline('english', p.title, qt.tsq, 'MaxWords=50, MinWords=5, MaxFragments=1')"
    return f"""
        WITH owned_pages AS (SELECT p.id, p.title FROM pages p WHERE p.user_id = :viewer_id),
             query_terms AS (SELECT {_TSQUERY} AS tsq)
        SELECT p.id, p.title,
               CASE WHEN :has_query THEN {tier} ELSE 0.0 END AS score,
               CASE WHEN :has_query THEN {headline} ELSE p.title END AS snippet
        FROM owned_pages p
        CROSS JOIN query_terms qt
        WHERE (:has_query IS FALSE
               OR to_tsvector('english', p.title) @@ qt.tsq
               OR p.title ILIKE :contains_query)
        {ident} {scope}
    """


def _page_row(row: Row, score: _SearchScore, q: str | None, kind: str) -> _RankedPageResult:
    return _RankedPageResult(
        id=row["id"],
        title=row["title"],
        snippet=_truncate_snippet(str(row["snippet"] or row["title"])),
        score=score,
    )


# =============================================================================
# Highlights
# =============================================================================

_HIGHLIGHT_BLOB = "concat_ws(' ', h.exact, COALESCE(h.prefix, ''), COALESCE(h.suffix, ''))"


def _highlight_sql(ident: str, filters: str, scope: str) -> str:
    match, score, snippet = _fts(_HIGHLIGHT_BLOB, "h.exact")
    return f"""
        WITH {_MEDIA_CTES}
        SELECT h.id, h.exact, h.prefix, h.suffix, h.color, h.anchor_kind,
               m.id AS media_id, m.kind, m.title, m.original_published_date,
               mcc.contributor_credits,
               hfa.fragment_id, hfa.start_offset, hfa.end_offset,
               f.canonical_text, f.t_start_ms, f.t_end_ms,
               hpa.page_number, pdf_quads.quads, {score} AS score, {snippet} AS snippet
        FROM highlights h
        JOIN media m ON m.id = h.anchor_media_id
        JOIN visible_media vm ON vm.media_id = h.anchor_media_id
        LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
        LEFT JOIN fragments f ON f.id = hfa.fragment_id
        LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
                'x1', CAST(hpq.x1 AS float), 'y1', CAST(hpq.y1 AS float),
                'x2', CAST(hpq.x2 AS float), 'y2', CAST(hpq.y2 AS float),
                'x3', CAST(hpq.x3 AS float), 'y3', CAST(hpq.y3 AS float),
                'x4', CAST(hpq.x4 AS float), 'y4', CAST(hpq.y4 AS float)
            ) ORDER BY hpq.quad_idx) AS quads
            FROM highlight_pdf_quads hpq WHERE hpq.highlight_id = h.id
        ) pdf_quads ON true
        JOIN content_index_states mcis ON mcis.owner_kind = 'media'
            AND mcis.owner_id = h.anchor_media_id AND mcis.status = 'ready'
        LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
        WHERE h.anchor_media_id IS NOT NULL
          AND ((h.anchor_kind = 'fragment_offsets' AND EXISTS (
                    SELECT 1 FROM highlight_fragment_anchors anchor
                    JOIN fragments af ON af.id = anchor.fragment_id
                    WHERE anchor.highlight_id = h.id AND af.media_id = h.anchor_media_id))
            OR (h.anchor_kind = 'pdf_page_geometry' AND EXISTS (
                    SELECT 1 FROM highlight_pdf_anchors anchor
                    WHERE anchor.highlight_id = h.id AND anchor.media_id = h.anchor_media_id)))
          AND {highlight_visibility_sql("h")}
          AND {match} {ident} {scope}
    """


def _highlight_row(
    row: Row, score: _SearchScore, q: str | None, kind: str
) -> _RankedHighlightResult | None:
    locator = _highlight_locator(row)
    if locator is None:
        return None
    return _RankedHighlightResult(
        id=row["id"],
        exact=str(row["exact"] or ""),
        snippet=_truncate_snippet(str(row["snippet"] or row["exact"] or "")),
        color=str(row["color"] or "yellow"),
        source=_source(row, row["media_id"], row["kind"]),
        score=score,
        citation_label=f"highlight {str(row['id'])[:8]}",
        locator=locator,
    )


def _highlight_locator(row: Row) -> dict[str, Any] | None:
    quote = {
        "exact": str(row["exact"] or ""),
        "prefix": str(row["prefix"] or ""),
        "suffix": str(row["suffix"] or ""),
    }
    if row["anchor_kind"] == "fragment_offsets" and row["fragment_id"] is not None:
        return _direct_fragment_locator(
            media_id=row["media_id"],
            media_kind=str(row["kind"] or ""),
            fragment_id=row["fragment_id"],
            text_value=str(row["canonical_text"] or ""),
            start_offset=int(row["start_offset"]),
            end_offset=int(row["end_offset"]),
            t_start_ms=int(row["t_start_ms"]) if row["t_start_ms"] is not None else None,
            t_end_ms=int(row["t_end_ms"]) if row["t_end_ms"] is not None else None,
            **quote,
        )
    if row["anchor_kind"] != "pdf_page_geometry" or row["page_number"] is None:
        return None
    try:
        return retrieval_locator_json(
            {
                "type": "pdf_page_geometry",
                "media_id": str(row["media_id"]),
                "page_number": int(row["page_number"]),
                "quads": row["quads"] if isinstance(row["quads"], list) else [],
                **quote,
                "text_quote_selector": quote,
            }
        )
    except ValueError:
        return None


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
    t_start_ms: int | None = None,
    t_end_ms: int | None = None,
) -> dict[str, Any] | None:
    """The reader locator for one span of one fragment, or None if inadmissible."""
    quote = {"exact": exact, "prefix": prefix, "suffix": suffix}
    if t_start_ms is not None and t_end_ms is not None:
        if t_end_ms <= t_start_ms or not exact:
            return None
        locator = {
            "type": "transcript_time_range",
            "media_id": str(media_id),
            "t_start_ms": t_start_ms,
            "t_end_ms": t_end_ms,
            "text_quote_selector": quote,
        }
    elif end_offset <= start_offset or len(text_value) < end_offset or media_kind == "pdf":
        return None
    else:
        locator = {
            "type": "epub_fragment_offsets" if media_kind == "epub" else "web_text_offsets",
            "media_id": str(media_id),
            "fragment_id": str(fragment_id),
            "start_offset": start_offset,
            "end_offset": end_offset,
            "media_kind": media_kind,
            "text_quote_selector": quote,
        }
    try:
        return retrieval_locator_json(locator)
    except ValueError:
        return None


# =============================================================================
# Messages, conversations, Conversation Dossiers
# =============================================================================


def _message_sql(ident: str, filters: str, scope: str) -> str:
    match, score, snippet = _fts("m.content", "m.content", vector="m.content_tsv")
    return f"""
        WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
        SELECT m.id, m.conversation_id, m.seq, m.content, {score} AS score, {snippet} AS snippet
        FROM messages m
        JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
        WHERE {match} AND m.status != 'pending' {ident} {scope}
    """


def _message_row(
    row: Row, score: _SearchScore, q: str | None, kind: str
) -> _RankedMessageResult | None:
    content = str(row["content"] or "")
    if not content:
        return None
    return _RankedMessageResult(
        id=row["id"],
        snippet=_truncate_snippet(str(row["snippet"] or content)),
        conversation_id=row["conversation_id"],
        seq=row["seq"],
        score=score,
        locator=retrieval_locator_json(
            {
                "type": "message_offsets",
                "conversation_id": str(row["conversation_id"]),
                "message_id": str(row["id"]),
                "message_seq": int(row["seq"]),
                "start_offset": 0,
                "end_offset": len(content),
            }
        ),
    )


def _conversation_sql(ident: str, filters: str, scope: str) -> str:
    title = "COALESCE(c.title, '')"
    match, score, snippet = _fts(title, title, opts="'MaxWords=24, MinWords=3, MaxFragments=1'")
    return f"""
        WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
        SELECT c.id, c.title, {score} AS score, {snippet} AS snippet
        FROM conversations c
        JOIN visible_conversations vc ON vc.conversation_id = c.id
        WHERE {match} {scope}
    """


def _conversation_row(
    row: Row, score: _SearchScore, q: str | None, kind: str
) -> _RankedConversationResult:
    return _RankedConversationResult(
        id=row["id"],
        title=str(row["title"] or "Conversation"),
        snippet=_truncate_snippet(str(row["snippet"] or row["title"] or "")),
        score=score,
    )


def _artifact_sql(ident: str, filters: str, scope: str) -> str:
    """Conversation Dossiers stay private to the owning user: a shared reader may
    search the conversation itself, never its generated claims."""
    body = "COALESCE(r.content_text, '')"
    match, score, snippet = _fts(body, body, opts="'MaxWords=40, MinWords=8, MaxFragments=1'")
    return f"""
        SELECT a.subject_id AS conversation_id, r.id AS revision_id,
               {score} AS score, {snippet} AS snippet
        FROM artifacts a
        JOIN artifact_revisions r ON r.id = a.current_revision_id
        JOIN conversations c ON c.id = a.subject_id
        WHERE a.subject_scheme = 'conversation'
          AND a.audience_scheme = 'user'
          AND a.audience_id = c.owner_user_id::text
          AND c.owner_user_id = :viewer_id
          AND {match} {scope.replace("c.id", "a.subject_id")}
    """


def _artifact_row(row: Row, score: _SearchScore, q: str | None, kind: str) -> _RankedArtifactResult:
    return _RankedArtifactResult(
        id=row["conversation_id"],
        revision_id=row["revision_id"],
        snippet=_truncate_snippet(str(row["snippet"] or "")),
        score=score,
    )


# =============================================================================
# Reader apparatus
# =============================================================================


def _apparatus_sql(ident: str, filters: str, scope: str) -> str:
    headline = """ts_headline('english', concat_ws(' ', a.label, a.body_text), qt.tsq,
                        'MaxWords=50, MinWords=8, MaxFragments=1')"""
    return f"""
        WITH {_MEDIA_CTES},
             apparatus_text AS (
                 SELECT rai.id, rai.kind, rai.label, rai.body_text, rai.locator, rai.media_id,
                        m.kind AS media_kind, m.title, m.original_published_date,
                        mcc.contributor_credits,
                        to_tsvector('english',
                            concat_ws(' ', rai.label, rai.kind, rai.body_text)) AS text_tsv
                 FROM reader_apparatus_items rai
                 JOIN reader_apparatus_states ras ON ras.id = rai.state_id
                 JOIN media m ON m.id = rai.media_id
                 JOIN visible_media vm ON vm.media_id = rai.media_id
                 LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                 WHERE ras.status IN ('ready', 'partial')
                   AND rai.locator IS NOT NULL
                   AND rai.locator_status != 'missing' {ident} {scope}
             ),
             query_terms AS (SELECT {_TSQUERY} AS tsq)
        SELECT a.id, a.kind, a.label, a.body_text, a.locator, a.media_id, a.media_kind,
               a.title, a.original_published_date, a.contributor_credits,
               CASE WHEN :has_query THEN ts_rank_cd(a.text_tsv, qt.tsq) ELSE 0.0 END AS score,
               CASE WHEN :has_query THEN {headline} ELSE CAST(NULL AS text) END AS snippet
        FROM apparatus_text a
        CROSS JOIN query_terms qt
        WHERE (:has_query IS FALSE OR a.text_tsv @@ qt.tsq)
    """


def _apparatus_row(
    row: Row, score: _SearchScore, q: str | None, kind: str
) -> _RankedReaderApparatusItemResult | None:
    raw = row["locator"]
    if not isinstance(raw, dict):
        return None
    try:
        locator = retrieval_locator_json(raw)
    except ValueError:
        return None
    if locator is None:
        return None
    return _RankedReaderApparatusItemResult(
        id=row["id"],
        snippet=_truncate_snippet(
            str(row["snippet"] or row["body_text"] or row["label"] or row["kind"] or "")
        ),
        apparatus_kind=str(row["kind"]),
        locator=locator,
        source=_source(row, row["media_id"], row["media_kind"]),
        score=score,
    )


# =============================================================================
# Source fragments — ranking carries identity and metadata only; bodies and
# headline excerpts are read for the selected page, after cross-type ranking.
# =============================================================================

_FRAGMENT_ROWS_SQL = """
    FROM fragments f
    JOIN media m ON m.id = f.media_id
    JOIN visible_media vm ON vm.media_id = f.media_id
    JOIN content_index_states mcis ON mcis.owner_kind = 'media'
        AND mcis.owner_id = f.media_id AND mcis.status = 'ready'
"""


def _fragment_sql(ident: str, filters: str, scope: str) -> str:
    rank = f"ts_rank_cd(f.canonical_text_tsv, {_TSQUERY})"
    return f"""
        WITH {_MEDIA_CTES}
        SELECT f.id, f.idx, char_length(f.canonical_text) AS text_length,
               f.t_start_ms, f.t_end_ms,
               m.id AS media_id, m.kind, m.title, m.original_published_date,
               mcc.contributor_credits,
               CASE WHEN :has_query THEN {rank} ELSE 0.0 END AS score
        {_FRAGMENT_ROWS_SQL}
        LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
        WHERE (:has_query IS FALSE OR f.canonical_text_tsv @@ {_TSQUERY})
        {ident} {scope}
    """


def _fragment_row(
    row: Row, score: _SearchScore, q: str | None, kind: str
) -> _RankedFragmentResult | None:
    if not row["text_length"]:
        return None
    if row["t_start_ms"] is not None and row["t_end_ms"] is not None:
        if not 0 <= row["t_start_ms"] < row["t_end_ms"]:
            return None
    elif row["kind"] == "pdf":
        return None
    return _RankedFragmentResult(
        id=row["id"],
        idx=int(row["idx"]),
        query=q,
        source=_source(row, row["media_id"], row["kind"]),
        score=score,
    )


def read_fragment_search_content(
    db: Session, *, viewer_id: UUID, result: _RankedFragmentResult
) -> tuple[str, dict[str, Any]]:
    """Read a selected fragment's original excerpt and complete locator."""
    row = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT f.canonical_text, f.t_start_ms, f.t_end_ms, m.id, m.kind,
                CASE WHEN CAST(:query AS text) IS NULL THEN NULL
                ELSE ts_headline('english', f.canonical_text, {_TSQUERY}, {_HEADLINE})
                END AS snippet
            {_FRAGMENT_ROWS_SQL}
            WHERE f.id = :id
            """
        ),
        {"viewer_id": viewer_id, "id": result.id, "query": result.query},
    ).first()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    body = str(row[0] or "")
    locator = _direct_fragment_locator(
        media_id=row[3],
        media_kind=str(row[4] or ""),
        fragment_id=result.id,
        text_value=body,
        start_offset=0,
        end_offset=len(body),
        exact=body,
        t_start_ms=int(row[1]) if row[1] is not None else None,
        t_end_ms=int(row[2]) if row[2] is not None else None,
    )
    if locator is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    snippet = str(row[5] or body) if result.query is not None else body
    return _truncate_snippet(snippet), locator


# =============================================================================
# Persisted public-web results
# =============================================================================

_WEB_ROW_COLUMNS = """
    mr.id, mr.source_id,
    COALESCE(mr.result_ref->>'result_ref', mr.source_id) AS result_ref,
    COALESCE(NULLIF(mr.result_ref->>'title', ''), mr.source_title, mr.source_id) AS title,
    COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link) AS url,
    NULLIF(mr.result_ref->>'display_url', '') AS display_url,
    mr.result_ref->'extra_snippets' AS extra_snippets,
    NULLIF(mr.result_ref->>'published_at', '') AS published_at,
    NULLIF(mr.result_ref->>'source_name', '') AS source_name,
    CASE WHEN mr.result_ref->>'rank' ~ '^[0-9]+$'
        THEN CAST(mr.result_ref->>'rank' AS integer) ELSE NULL END AS rank,
    NULLIF(mr.result_ref->>'provider', '') AS provider,
    NULLIF(mr.result_ref->>'provider_request_id', '') AS provider_request_id,
    COALESCE(NULLIF(mr.exact_snippet, ''), mr.result_ref->>'snippet', '') AS exact_snippet,
    mr.locator, mr.selected, mr.result_ref AS raw_result_ref
"""

_WEB_ROWS_SQL = """
    FROM message_retrievals mr
    JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
    JOIN visible_conversations vc ON vc.conversation_id = mtc.conversation_id
    JOIN resource_external_snapshots res
      ON res.id = CASE
          WHEN mr.source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN CAST(mr.source_id AS uuid)
          ELSE NULL
      END
     AND res.user_id = :viewer_id
    WHERE mr.result_type = 'web_result'
      AND mr.result_ref->>'type' = 'web_result'
      AND mr.locator IS NOT NULL
      AND mr.locator != 'null'::jsonb
"""

_WEB_SEARCH_TEXT = """concat_ws(' ', mr.source_id, mr.source_title, mr.deep_link,
                        mr.exact_snippet, mr.result_ref->>'title', mr.result_ref->>'url',
                        mr.result_ref->>'display_url', mr.result_ref->>'source_name',
                        mr.result_ref->>'snippet')"""


def _web_sql(ident: str, filters: str, scope: str) -> str:
    match, score, snippet = _fts("search_text", "CAST(NULL AS text)")
    return f"""
        WITH visible_conversations AS ({visible_conversation_ids_cte_sql()}),
             web_rows AS (
                 SELECT {_WEB_ROW_COLUMNS}, {_WEB_SEARCH_TEXT} AS search_text
                 {_WEB_ROWS_SQL} {ident} {scope}
             )
        SELECT id, source_id, result_ref, title, url, display_url, extra_snippets,
               published_at, source_name, rank, provider, provider_request_id,
               exact_snippet, locator, selected, raw_result_ref,
               {score} AS score, {snippet} AS snippet
        FROM web_rows
        WHERE {match} AND (:has_query IS FALSE OR url IS NOT NULL)
    """


def _web_row(row: Row, score: _SearchScore, q: str | None, kind: str) -> _RankedWebResult | None:
    raw = row["raw_result_ref"]
    if not row["url"] or not isinstance(raw, dict):
        return None
    try:
        ref = retrieval_result_ref_json(raw)
    except ValueError:
        return None
    return _RankedWebResult(
        id=str(row["id"]),
        source_id=str(ref["source_id"]),
        result_ref=str(ref["result_ref"]),
        title=str(ref["title"]),
        url=str(ref["url"]),
        display_url=ref.get("display_url"),
        extra_snippets=list(ref.get("extra_snippets", [])),
        published_at=ref.get("published_at"),
        source_name=ref.get("source_name"),
        rank=ref.get("rank"),
        provider=ref.get("provider"),
        provider_request_id=ref.get("provider_request_id"),
        snippet=_truncate_snippet(str(row["snippet"] or row["exact_snippet"] or "")),
        locator=_required_locator("web_result", ref["locator"]),
        selected=bool(row["selected"]),
        score=score,
    )


# =============================================================================
# The table and the one retriever
# =============================================================================

_KINDS: dict[str, _Kind] = {
    "media": _Kind("media", "m.id", _media_sql, _media_row, "m.id", _media_filters),
    "podcast": _Kind("podcast", "p.id", _podcast_sql, _podcast_row, None, _podcast_filters),
    "contributor": _Kind(
        "contributor", "c.handle", _contributor_sql, _contributor_row, None, _contributor_filters
    ),
    "page": _Kind("page", "p.id", _page_sql, _page_row, "p.id"),
    "highlight": _Kind("highlight", "h.id", _highlight_sql, _highlight_row, "h.id"),
    "message": _Kind("message", "m.id", _message_sql, _message_row, "m.id"),
    "conversation": _Kind("conversation", "c.id", _conversation_sql, _conversation_row),
    "artifact": _Kind("conversation", "r.id", _artifact_sql, _artifact_row),
    "reader_apparatus_item": _Kind(
        "reader_apparatus_item", "a.id", _apparatus_sql, _apparatus_row, "rai.id"
    ),
    "fragment": _Kind("fragment", "f.idx ASC, f.id", _fragment_sql, _fragment_row, "f.id"),
    "web_result": _Kind("web_result", "id", _web_sql, _web_row, "mr.id"),
}
# Only these relations honour a format/author/role refinement; for the rest such
# a filter rules out every match.
_CREDITED = frozenset({"media", "episode", "video", "podcast", "contributor", "content_chunk"})


def retrieve(
    db: Session,
    viewer_id: UUID,
    *,
    result_type: str,
    q: str,
    has_query: bool,
    semantic_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    contributor_ids: list[UUID] | None,
    roles: Sequence[str],
    content_kinds: Sequence[str],
    limit: int,
) -> Sequence[InternalSearchResult]:
    """One result type's raw-scored candidates under the viewer's visibility."""
    filters = _Filters(contributor_ids, tuple(roles), tuple(content_kinds))
    if result_type not in _CREDITED and filters.present:
        return []
    if result_type == "content_chunk":
        return search_content_chunks(
            db,
            viewer_id,
            q=q,
            has_query=has_query,
            semantic_embedding=semantic_embedding,
            scope_type=scope_type,
            scope_id=scope_id,
            contributor_ids=contributor_ids,
            roles=list(roles),
            content_kinds=list(content_kinds),
            limit=limit,
        )
    if result_type == "note_block":
        return search_note_chunks(
            db,
            viewer_id,
            q=q,
            semantic_embedding=semantic_embedding,
            scope_type=scope_type,
            scope_id=scope_id,
            limit=limit,
        )

    forced = _FORCED_STORAGE_KIND.get(result_type)
    if forced is not None:
        if filters.content_kinds and forced not in filters.content_kinds:
            return []
        filters = _Filters(filters.contributor_ids, filters.roles, (forced,))
    if (
        result_type == "podcast"
        and filters.content_kinds
        and "podcast" not in filters.content_kinds
    ):
        return []

    kind = _KINDS["media" if forced is not None else result_type]
    cell = scope_filter_sql(scope_type, scope_id, kind.entity)
    if cell is None:
        return []
    scope_sql, params = cell
    params |= _params(viewer_id, q, has_query) | {"limit": limit}
    filter_sql = kind.filters(filters, params) if kind.filters is not None else ""
    statement = (
        kind.sql("", filter_sql, scope_sql) + f"\nORDER BY score DESC, {kind.tie} ASC\nLIMIT :limit"
    )
    built: list[InternalSearchResult] = []
    for row in db.execute(text(statement), params).mappings():
        candidate = kind.build(row, _build_search_score(row["score"]), q, result_type)
        if candidate is not None:
            built.append(candidate)
    return built


def reopen(
    db: Session, viewer_id: UUID, *, result_type: str, result_id: UUID, score: _SearchScore
) -> InternalSearchResult:
    """Re-materialize one visible row from its durable (type, id) identity."""
    kind = _KINDS.get("media" if result_type in _MEDIA_TYPES else result_type)
    if kind is None or kind.id_column is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    params = _params(viewer_id, "", False) | {"id": result_id}
    forced = _FORCED_STORAGE_KIND.get(result_type)
    filters = _Filters(content_kinds=(forced,) if forced else ())
    filter_sql = kind.filters(filters, params) if kind.filters is not None else ""
    statement = kind.sql(f"AND {kind.id_column} = :id", filter_sql, "")
    row = db.execute(text(statement), params).mappings().first()
    candidate = None if row is None else kind.build(row, score, None, result_type)
    if candidate is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    return candidate


def _params(viewer_id: UUID, q: str, has_query: bool) -> dict[str, Any]:
    return {
        "viewer_id": viewer_id,
        "query": q,
        "contains_query": f"%{q}%",
        "has_query": has_query,
    }
