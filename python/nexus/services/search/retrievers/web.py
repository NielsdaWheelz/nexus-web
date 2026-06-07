"""Persisted public-web result retriever."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_conversation_ids_cte_sql
from nexus.services.search.projection import _required_locator, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _RankedWebResult,
    _web_result_ref_json,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql


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
    scope_clause = scope_filter_sql(scope_type, scope_id, "web_result")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

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
            ORDER BY score DESC, id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()

    results: list[InternalSearchResult] = []
    for row in rows:
        result_ref = _web_result_ref_json(row[15])
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
                snippet=_truncate_snippet(str(row[17] or row[12] or "")),
                locator=_required_locator("web_result", result_ref["locator"]),
                selected=bool(row[14]),
                score=_build_search_score(row[16]),
            )
        )
    return results
