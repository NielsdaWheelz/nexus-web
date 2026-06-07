"""Media and podcast retrievers."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _parse_contributor_credits,
    _RankedMediaResult,
    _RankedPodcastResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import contributor_credits_rollup_cte_sql


def _search_media(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_ids: list[UUID] | None,
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

    if contributor_ids is not None or roles:
        credit_clauses = ["cc_filter.media_id = m.id"]
        if contributor_ids is not None:
            credit_clauses.append("cc_filter.contributor_id = ANY(:contributor_ids)")
            params["contributor_ids"] = contributor_ids
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                WHERE {" AND ".join(credit_clauses)}
            )
        """

    scope_clause = scope_filter_sql(scope_type, scope_id, "media")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
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
    contributor_ids: list[UUID] | None,
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search visible podcast metadata."""
    if content_kinds and "podcast" not in content_kinds:
        return []

    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "has_query": has_query, "limit": limit}
    contributor_credit_filter = ""

    if contributor_ids is not None or roles:
        credit_clauses = ["cc_filter.podcast_id = p.id"]
        if contributor_ids is not None:
            credit_clauses.append("cc_filter.contributor_id = ANY(:contributor_ids)")
            params["contributor_ids"] = contributor_ids
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                WHERE {" AND ".join(credit_clauses)}
            )
        """

    scope_clause = scope_filter_sql(scope_type, scope_id, "podcast")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    query = f"""
        WITH visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
        podcast_contributor_credits AS ({contributor_credits_rollup_cte_sql("podcast_id")})
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
