"""Reader apparatus search over source-authored apparatus rows."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedReaderApparatusItemResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import contributor_credits_rollup_cte_sql


def _search_reader_apparatus_items(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    if not q.strip():
        return []
    scope_clause = scope_filter_sql(scope_type, scope_id, "reader_apparatus_item")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    rows = (
        db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")}),
                    apparatus_text AS (
                        SELECT
                            rai.id,
                            rai.kind,
                            rai.label,
                            rai.body_text,
                            rai.locator,
                            rai.media_id,
                            m.kind AS media_kind,
                            m.title,
                            m.published_date,
                            mcc.contributor_credits,
                            to_tsvector(
                                'english',
                                concat_ws(' ', rai.label, rai.kind, rai.body_text)
                            ) AS text_tsv
                        FROM reader_apparatus_items rai
                        JOIN reader_apparatus_states ras ON ras.id = rai.state_id
                        JOIN media m ON m.id = rai.media_id
                        JOIN visible_media vm ON vm.media_id = rai.media_id
                        LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                        WHERE ras.status IN ('ready', 'partial')
                          AND rai.locator IS NOT NULL
                          AND rai.locator_status != 'missing'
                          {scope_filter}
                    ),
                    query_terms AS (
                        SELECT websearch_to_tsquery('english', :query) AS tsq
                    )
                SELECT
                    a.id,
                    a.kind,
                    a.locator,
                    a.media_id,
                    a.media_kind,
                    a.title,
                    a.published_date,
                    a.contributor_credits,
                    ts_headline(
                        'english',
                        concat_ws(' ', a.label, a.body_text),
                        qt.tsq,
                        'MaxWords=50, MinWords=8, MaxFragments=1'
                    ) AS snippet,
                    ts_rank_cd(a.text_tsv, qt.tsq) AS score
                FROM apparatus_text a
                CROSS JOIN query_terms qt
                WHERE a.text_tsv @@ qt.tsq
                ORDER BY score DESC, a.id ASC
                LIMIT :limit
                """
            ),
            {"viewer_id": viewer_id, "query": q, "limit": limit, **scope_params},
        )
        .mappings()
        .all()
    )
    return [
        _RankedReaderApparatusItemResult(
            id=row["id"],
            snippet=_truncate_snippet(str(row["snippet"] or "")),
            apparatus_kind=str(row["kind"]),
            locator=dict(row["locator"]),
            source=_build_search_source(
                row["media_id"],
                row["media_kind"],
                row["title"],
                row["contributor_credits"],
                row["published_date"],
            ),
            score=_build_search_score(row["score"]),
        )
        for row in rows
    ]
