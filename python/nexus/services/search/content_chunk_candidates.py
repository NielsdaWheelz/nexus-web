"""Shared semantic content-chunk candidate retrieval.

The one ANN-over-``content_embeddings`` primitive scoped to visible media/owned
notes with the active embedding model/provider from ``content_index_states``.
Oracle consumes this for both its public-domain (library-scoped) and personal
(unscoped) candidate retrieval instead of owning vector SQL (spec §10.2, G7). It
returns enough locator/source data to build a ``ResourceRef`` citation and knows
nothing about Oracle phases, plates, or candidate balancing.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.services.search.query import SearchScope
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import query_embedding_cte_sql
from nexus.services.semantic_chunks import (
    to_pgvector_literal,
    transcript_embedding_dimensions,
    transcript_embedding_provider_for_model,
)


@dataclass(frozen=True)
class ContentChunkCandidate:
    """One semantically-ranked content chunk with its citation/source anchoring."""

    content_chunk_id: UUID
    owner_kind: str  # "media" | "note_block"
    owner_id: UUID
    chunk_text: str
    source_kind: str
    heading_path: list[str]
    primary_evidence_span_id: UUID | None
    title: str  # media title, or "Note" for note-owned chunks
    semantic_score: float


def retrieve_content_chunk_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    query_embedding: tuple[str, list[float]],
    scope: SearchScope,
    limit: int = 200,
) -> list[ContentChunkCandidate]:
    """Semantic chunk candidates for ``viewer_id``, ordered by ANN distance.

    ``scope=all`` returns visible media + owned-note chunks; ``scope=library:<id>``
    returns that library's media chunks (the content_chunk scope cell is media-only).
    Only chunks whose owner index is ``ready`` on the query's active model/provider
    are eligible; an unsupported scope yields ``[]``.
    """
    embedding_model, embedding = query_embedding
    embedding_provider = transcript_embedding_provider_for_model(embedding_model)
    embedding_dims = transcript_embedding_dimensions()
    scope_clause = scope_filter_sql(scope.kind, scope.id, "content_chunk")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    rows = (
        db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    {query_embedding_cte_sql(embedding_dims)}
                SELECT
                    cc.id AS content_chunk_id,
                    cc.owner_kind,
                    cc.owner_id,
                    cc.chunk_text,
                    cc.source_kind,
                    cc.heading_path,
                    cc.primary_evidence_span_id,
                    COALESCE(m.title, 'Note') AS title,
                    (1 - (ce.embedding_vector <=> qe.embedding)) AS semantic_score
                FROM content_chunks cc
                LEFT JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                    AND mcis.owner_id = cc.owner_id
                    AND mcis.status = 'ready'
                JOIN content_embeddings ce ON ce.chunk_id = cc.id
                    AND ce.embedding_provider = mcis.active_embedding_provider
                    AND ce.embedding_model = mcis.active_embedding_model
                    AND ce.embedding_dimensions = :embedding_dims
                    AND ce.embedding_vector IS NOT NULL
                JOIN query_embedding qe ON true
                WHERE btrim(cc.chunk_text) <> ''
                  AND mcis.active_embedding_provider = :query_embedding_provider
                  AND mcis.active_embedding_model = :query_embedding_model
                  AND (
                    (cc.owner_kind = 'media' AND cc.owner_id IN (SELECT media_id FROM visible_media))
                    OR (cc.owner_kind = 'note_block' AND cc.owner_id IN (
                        SELECT id FROM note_blocks WHERE user_id = :viewer_id))
                  )
                  {scope_filter}
                ORDER BY ce.embedding_vector <=> qe.embedding ASC, cc.id ASC
                LIMIT :limit
                """
            ),
            {
                "viewer_id": viewer_id,
                "query_embedding_provider": embedding_provider,
                "query_embedding_model": embedding_model,
                "query_embedding": to_pgvector_literal(embedding),
                "embedding_dims": embedding_dims,
                "limit": limit,
                **scope_params,
            },
        )
        .mappings()
        .all()
    )
    return [
        ContentChunkCandidate(
            content_chunk_id=row["content_chunk_id"],
            owner_kind=str(row["owner_kind"]),
            owner_id=row["owner_id"],
            chunk_text=str(row["chunk_text"] or ""),
            source_kind=str(row["source_kind"]),
            heading_path=[str(part) for part in row["heading_path"] or [] if str(part).strip()],
            primary_evidence_span_id=row["primary_evidence_span_id"],
            title=str(row["title"] or "Untitled"),
            semantic_score=float(row["semantic_score"] or 0.0),
        )
        for row in rows
    ]


def ordered_media_content_chunk_ids(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    limit: int,
) -> list[UUID]:
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT cc.id
            FROM content_chunks cc
            JOIN visible_media vm ON vm.media_id = cc.owner_id
            JOIN content_index_states cis ON cis.owner_kind = cc.owner_kind
                AND cis.owner_id = cc.owner_id
                AND cis.status = 'ready'
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                AND es.owner_kind = cc.owner_kind
                AND es.owner_id = cc.owner_id
            WHERE cc.owner_kind = 'media'
              AND cc.owner_id = :media_id
            ORDER BY cc.chunk_idx ASC, cc.id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id, "limit": limit},
    ).scalars()
    return [UUID(str(chunk_id)) for chunk_id in rows]


def has_retrievable_content_chunks(
    db: Session,
    *,
    viewer_id: UUID,
    scope: SearchScope,
) -> bool:
    scope_clause = scope_filter_sql(scope.kind, scope.id, "content_chunk")
    if isinstance(scope_clause, ScopeUnsupported):
        return False
    scope_filter, scope_params = scope_clause

    note_exists = ""
    note_clause = scope_filter_sql(scope.kind, scope.id, "note_block")
    if not isinstance(note_clause, ScopeUnsupported):
        note_scope_filter, note_scope_params = note_clause
        scope_params = {**scope_params, **note_scope_params}
        note_exists = f"""
            OR EXISTS (
                SELECT 1
                FROM content_chunks cc
                JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
                    AND nb.user_id = :viewer_id
                JOIN content_index_states ncis ON ncis.owner_kind = cc.owner_kind
                    AND ncis.owner_id = cc.owner_id AND ncis.status = 'ready'
                WHERE btrim(cc.chunk_text) <> ''
                {note_scope_filter}
                LIMIT 1
            )
        """

    return bool(
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT EXISTS (
                    SELECT 1
                    FROM content_chunks cc
                    JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                    JOIN visible_media vm ON vm.media_id = cc.owner_id
                    JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                        AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                    JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                        AND es.owner_kind = cc.owner_kind AND es.owner_id = cc.owner_id
                    WHERE btrim(cc.chunk_text) <> ''
                    {scope_filter}
                    LIMIT 1
                )
                {note_exists}
                """
            ),
            {"viewer_id": viewer_id, **scope_params},
        ).scalar_one()
    )


def has_searchable_content_chunks(
    db: Session,
    *,
    viewer_id: UUID,
    scope: SearchScope,
    exclude_media_ids: set[UUID] | None = None,
) -> bool:
    """Whether the viewer has any ready, non-empty chunks under ``scope``.

    This is the shared existence probe for callers that need to decide whether a
    semantic retrieval pass is meaningful without building an embedding first. It
    uses the same visibility and scope owner as ``retrieve_content_chunk_candidates``;
    callers may exclude media already consumed by a higher-priority corpus/library.
    """
    scope_clause = scope_filter_sql(scope.kind, scope.id, "content_chunk")
    if isinstance(scope_clause, ScopeUnsupported):
        return False
    scope_filter, scope_params = scope_clause
    note_clause = scope_filter_sql(scope.kind, scope.id, "note_block")
    note_exists = ""
    if not isinstance(note_clause, ScopeUnsupported):
        note_scope_filter, _ = note_clause
        note_exists = f"""
            OR EXISTS (
                SELECT 1
                FROM content_chunks cc
                JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
                    AND nb.user_id = :viewer_id
                JOIN content_index_states ncis ON ncis.owner_kind = cc.owner_kind
                    AND ncis.owner_id = cc.owner_id AND ncis.status = 'ready'
                WHERE btrim(cc.chunk_text) <> ''
                {note_scope_filter}
                LIMIT 1
            )
        """
    excluded_media = tuple(exclude_media_ids or ())
    exclude_clause = (
        "AND NOT (cc.owner_kind = 'media' AND cc.owner_id = ANY(:exclude_media_ids))"
        if excluded_media
        else ""
    )
    return bool(
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT EXISTS (
                    SELECT 1
                    FROM content_chunks cc
                    JOIN visible_media vm ON vm.media_id = cc.owner_id
                        AND cc.owner_kind = 'media'
                    JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                        AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                    WHERE btrim(cc.chunk_text) <> ''
                    {exclude_clause}
                    {scope_filter}
                    LIMIT 1
                )
                {note_exists}
                """
            ),
            {
                "viewer_id": viewer_id,
                "exclude_media_ids": list(excluded_media),
                **scope_params,
            },
        ).scalar_one()
    )
