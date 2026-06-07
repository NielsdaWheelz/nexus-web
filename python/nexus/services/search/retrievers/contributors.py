"""Contributor identity retriever and its FTS text SQL."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    visible_contributor_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _parse_contributor,
    _RankedContributorResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql


def _contributor_fts_text_sql() -> str:
    """The single full-text blob for a contributor — display/sort name, disambiguation, and the
    aggregated alias/external-id/credit text from this query's CTEs. The rank, headline, and
    match expressions all derive from it so they can never drift apart."""
    return """concat_ws(
                    ' ',
                    c.display_name,
                    COALESCE(c.sort_name, ''),
                    COALESCE(c.disambiguation, ''),
                    COALESCE(alias_text.aliases, ''),
                    COALESCE(external_id_text.external_ids, ''),
                    COALESCE(credit_text.credited_names, '')
                )"""


def _search_contributors(
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

    if contributor_ids is not None:
        handle_filter = "AND c.id = ANY(:contributor_ids)"
        params["contributor_ids"] = contributor_ids

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
                        'podcast' = ANY(:content_kinds)
                        AND cc_filter.podcast_id IS NOT NULL
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

    scope_clause = scope_filter_sql(scope_type, scope_id, "contributor")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_credit_filter, scope_params = scope_clause
    params.update(scope_params)

    # Unscoped search shows every visible contributor (credit OR viewer object-link), the
    # single-owner predicate. A content scope narrows to contributors credited within it.
    visible_contributors_cte = (
        f"visible_contributors AS ({visible_contributor_ids_cte_sql()})"
        if scope_type == "all"
        else "visible_contributors AS (SELECT DISTINCT contributor_id FROM visible_scoped_credits)"
    )

    fts_text = _contributor_fts_text_sql()
    query = f"""
        WITH
            visible_media AS ({visible_media_ids_cte_sql()}),
            visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
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
            {visible_contributors_cte},
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
                to_tsvector('english', {fts_text}),
                websearch_to_tsquery('english', :query)
            ) ELSE 0.0 END AS score,
            CASE WHEN :has_query THEN ts_headline(
                'english',
                {fts_text},
                websearch_to_tsquery('english', :query),
                'MaxWords=50, MinWords=10, MaxFragments=1'
            ) ELSE c.display_name END AS snippet
        FROM contributors c
        LEFT JOIN alias_text ON alias_text.contributor_id = c.id
        LEFT JOIN external_id_text ON external_id_text.contributor_id = c.id
        LEFT JOIN credit_text ON credit_text.contributor_id = c.id
        JOIN visible_contributors vc ON vc.contributor_id = c.id
        WHERE c.status NOT IN ('merged', 'tombstoned')
          AND (:has_query IS FALSE OR to_tsvector('english', {fts_text})
                @@ websearch_to_tsquery('english', :query))
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
