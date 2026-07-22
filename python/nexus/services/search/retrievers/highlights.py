"""Source-highlight retriever."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_shared_library_exists_sql,
    visible_media_ids_cte_sql,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.search.projection import _direct_fragment_locator, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedHighlightResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import contributor_credits_rollup_cte_sql


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

    scope_clause = scope_filter_sql(scope_type, scope_id, "highlight")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
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
                f.t_start_ms,
                f.t_end_ms,
                hpa.page_number,
                pdf_quads.quads,
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
            JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                AND mcis.owner_id = h.anchor_media_id
                AND mcis.status = 'ready'
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
              AND {highlight_shared_library_exists_sql("h")}
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
                t_start_ms=int(row[15]) if row[15] is not None else None,
                t_end_ms=int(row[16]) if row[16] is not None else None,
            )
        elif row[10] == "pdf_page_geometry" and row[17] is not None:
            try:
                locator = retrieval_locator_json(
                    {
                        "type": "pdf_page_geometry",
                        "media_id": str(row[5]),
                        "page_number": int(row[17]),
                        "quads": row[18] if isinstance(row[18], list) else [],
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
                snippet=_truncate_snippet(str(row[20] or row[1] or "")),
                color=str(row[4] or "yellow"),
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=_build_search_score(row[19]),
                citation_label=f"highlight {str(row[0])[:8]}",
                locator=locator,
            )
        )
    return results
