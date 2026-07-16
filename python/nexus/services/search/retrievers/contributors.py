"""Contributor identity retriever, composed on the canonical credit relation."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_contributor_ids_cte_sql
from nexus.services.contributor_credits import (
    contributor_fts_text_sql,
    visible_credit_rows_sql,
)
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _RankedContributorResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql


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
    *,
    broad_visibility: bool = False,
) -> list[InternalSearchResult]:
    """Search contributor identities by display name, aliases, and visible credited names.

    Composes the canonical read relation (``contributor_credits.visible_credit_rows_sql``
    for the credited-visible predicate, ``contributor_fts_text_sql`` for the blob) rather
    than reading raw credit SQL. On the discovery surfaces a contributor surfaces only with
    at least one visible credited target (spec §2.8 / D-8): retained key owners and
    graph-referenced identities with zero visible credits never appear. The FTS blob is
    display name + every human alias + visible credited names — never an external key (AC 24).

    ``broad_visibility=True`` is the durable-ref re-resolution mode used by
    ``get_search_result`` (id-pinned, ``has_query=False``): it uses the BROAD contributor
    visibility predicate (visible credit OR viewer-owned graph edge) so a chat citation to a
    contributor that is reachable only via a ``resource_edges`` endpoint — with zero visible
    credits — still re-materializes, matching ``hydrate_contributor_object_ref`` /
    ``resolve.py::_load_contributor``. Discovery keeps the narrow credited-visible gate.
    """
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "query": q,
        "has_query": has_query,
        "limit": limit,
    }
    handle_filter = ""
    credit_filter = ""

    if contributor_ids is not None:
        handle_filter = "AND c.id = ANY(:contributor_ids)"
        params["contributor_ids"] = contributor_ids

    scope_clause = scope_filter_sql(scope_type, scope_id, "contributor")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_credit_filter, scope_params = scope_clause
    params.update(scope_params)

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
                FROM scoped_credits cc_filter
                WHERE {" AND ".join(credit_clauses)}
            )
        """

    visibility_gate_sql = (
        visible_contributor_ids_cte_sql()
        if broad_visibility
        else "SELECT DISTINCT contributor_id FROM scoped_credits"
    )

    query = f"""
        WITH
            scoped_credits AS (
                SELECT cc.*
                FROM ({visible_credit_rows_sql()}) cc
                WHERE TRUE
                {scope_credit_filter}
            ),
            visible_gate AS ({visibility_gate_sql}),
            contributor_fts AS ({contributor_fts_text_sql()})
        SELECT
            c.id,
            c.handle,
            c.display_name,
            CASE WHEN :has_query THEN ts_rank_cd(
                to_tsvector('english', fts.search_text),
                websearch_to_tsquery('english', :query)
            ) ELSE 0.0 END AS score,
            CASE WHEN :has_query THEN ts_headline(
                'english',
                fts.search_text,
                websearch_to_tsquery('english', :query),
                'MaxWords=50, MinWords=10, MaxFragments=1'
            ) ELSE c.display_name END AS snippet
        FROM contributors c
        JOIN visible_gate cv ON cv.contributor_id = c.id
        JOIN contributor_fts fts ON fts.contributor_id = c.id
        WHERE (:has_query IS FALSE OR to_tsvector('english', fts.search_text)
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
            display_name=str(row[2]),
            snippet=_truncate_snippet(str(row[4] or row[2])),
            score=_build_search_score(row[3]),
        )
        for row in rows
    ]
