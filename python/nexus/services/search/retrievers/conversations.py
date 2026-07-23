"""Message and conversation retrievers."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_conversation_ids_cte_sql
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _RankedArtifactResult,
    _RankedConversationResult,
    _RankedMessageResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql


def _search_messages(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Search message content with visibility filtering.

    Message visibility follows the canonical conversation visibility CTE.
    Pending messages are never searchable.

    Library scope includes only messages from conversations actively shared
    to the target library (sharing='library' + share row to scope library).
    Owner/public conversations not shared to the target library are excluded.
    """
    scope_filter = ""
    params: dict = {"viewer_id": viewer_id, "query": q, "limit": limit}

    scope_clause = scope_filter_sql(scope_type, scope_id, "message")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    query = f"""
        WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
        SELECT
            m.id,
            m.conversation_id,
            m.seq,
            m.content,
            ts_rank_cd(m.content_tsv, websearch_to_tsquery('english', :query)) AS score,
            ts_headline('english', m.content, websearch_to_tsquery('english', :query),
                        'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet
        FROM messages m
        JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
        WHERE m.content_tsv @@ websearch_to_tsquery('english', :query)
          AND m.status != 'pending'  -- Pending messages never searchable
        {scope_filter}
        ORDER BY score DESC, m.id ASC
        LIMIT :limit
    """

    result = db.execute(text(query), params)
    rows = result.fetchall()

    return [
        _RankedMessageResult(
            id=row[0],
            snippet=_truncate_snippet(str(row[5] or "")),
            conversation_id=row[1],
            seq=row[2],
            score=_build_search_score(row[4]),
            locator=retrieval_locator_json(
                {
                    "type": "message_offsets",
                    "conversation_id": str(row[1]),
                    "message_id": str(row[0]),
                    "message_seq": int(row[2]),
                    "start_offset": 0,
                    "end_offset": len(str(row[3] or "")),
                }
            )
            if row[3]
            else None,
        )
        for row in rows
    ]


def _search_conversations(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    scope_clause = scope_filter_sql(scope_type, scope_id, "conversation")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    rows = db.execute(
        text(
            f"""
            WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
            SELECT
                c.id,
                c.title,
                ts_rank_cd(
                    to_tsvector('english', COALESCE(c.title, '')),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    COALESCE(c.title, ''),
                    websearch_to_tsquery('english', :query),
                    'MaxWords=24, MinWords=3, MaxFragments=1'
                ) AS snippet
            FROM conversations c
            JOIN visible_conversations vc ON vc.conversation_id = c.id
            WHERE to_tsvector('english', COALESCE(c.title, ''))
                  @@ websearch_to_tsquery('english', :query)
              {scope_filter}
            ORDER BY score DESC, c.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    return [
        _RankedConversationResult(
            id=row[0],
            title=str(row[1] or "Conversation"),
            snippet=_truncate_snippet(str(row[3] or row[1] or "")),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _search_conversation_artifacts(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Lexical FTS over current owner-audience Conversation Dossiers.

    Conversation Dossiers are private to the owning user after the universal
    Dossier cutover. A shared reader may search the conversation itself, but
    cannot retrieve its generated claims.
    """
    scope_clause = scope_filter_sql(scope_type, scope_id, "conversation")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    params.update(scope_params)

    rows = db.execute(
        text(
            f"""
            SELECT
                a.subject_id AS conversation_id,
                r.id AS revision_id,
                ts_rank_cd(
                    to_tsvector('english', COALESCE(r.content_md, '')),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    COALESCE(r.content_md, ''),
                    websearch_to_tsquery('english', :query),
                    'MaxWords=40, MinWords=8, MaxFragments=1'
                ) AS snippet
            FROM artifacts a
            JOIN artifact_revisions r ON r.id = a.current_revision_id
            JOIN conversations c ON c.id = a.subject_id
            WHERE a.subject_scheme = 'conversation'
              AND a.audience_scheme = 'user'
              AND a.audience_id = c.owner_user_id::text
              AND c.owner_user_id = :viewer_id
              AND to_tsvector('english', COALESCE(r.content_md, ''))
                  @@ websearch_to_tsquery('english', :query)
              {_artifact_scope_filter(scope_filter)}
            ORDER BY score DESC, r.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    return [
        _RankedArtifactResult(
            id=row[0],
            revision_id=row[1],
            snippet=_truncate_snippet(str(row[3] or "")),
            score=_build_search_score(row[2]),
        )
        for row in rows
    ]


def _artifact_scope_filter(conversation_scope_filter: str) -> str:
    """Rewrite the conversation-scope filter (``c.id``) onto the artifact subject."""
    return conversation_scope_filter.replace("c.id", "a.subject_id")
