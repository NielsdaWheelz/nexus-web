"""Deterministic "related media" for the collection surface (spec S5).

Two precomputed signals, no request-time LLM anywhere on this path:

* **Embedding NN (media-owner seeded).** Unlike the query-vector-seeded
  ``content_chunk_candidates`` primitive, the seed here is the *target media's
  own* first active ``content_embeddings`` row. That single query vector uses the
  existing ivfflat ANN shape (``ORDER BY embedding_vector <=> seed LIMIT``) over
  visible peer chunks, then dedupes to distinct peer media. Both sides are pinned
  to the target's active embedding model/provider (``content_index_states``) so
  vectors are comparable.
* **Shared-author.** Other visible media sharing an ``author`` contributor with
  the target (``contributor_credits``), mirroring ``resolve._load_media``'s author
  join.

The two signals are unioned and deduped (the target itself excluded), then
hydrated as ``ConnectionEndpoint`` values through the SAME ``resolve_refs`` +
``resource_activation_for_ref`` helpers ``query_connections`` and
``connection_summaries`` use, so each peer carries ``label``/``href`` and a
deleted/forbidden peer comes back ``missing=True`` and is never leaked.

Ordering is deterministic: similarity peers first (ascending best distance),
then shared-author-only peers (descending shared-author count), each tier broken
by ``media_id`` ascending, and the union is capped at ``limit``.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import resolve_refs
from nexus.services.resource_graph.schemas import ConnectionEndpoint
from nexus.services.resource_items.routing import resource_activation_for_ref
from nexus.services.semantic_chunks import transcript_embedding_dimensions


@dataclass(frozen=True, slots=True)
class _RelatedHit:
    """One candidate peer media id with its two raw signal values."""

    media_id: UUID
    best_distance: float | None  # min cosine distance over chunk pairs; None = no NN
    shared_author_count: int  # distinct shared author contributors; 0 = none


def related_media(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    limit: int = 8,
) -> list[ConnectionEndpoint]:
    """Deterministic related peers for ``media_id``, hydrated for display.

    Combines embedding nearest-neighbours (seeded by the target media's own
    chunk vectors) with shared-author media, dedups to distinct peers (the
    target excluded), orders deterministically (similarity then shared-author,
    ``media_id`` tiebreak), caps at ``limit``, and hydrates each as a
    ``ConnectionEndpoint``. No provider/LLM call on this path.
    """
    if limit < 1:
        return []
    similar = _similar_media(db, viewer_id=viewer_id, media_id=media_id, limit=limit)
    shared = _shared_author_media(db, viewer_id=viewer_id, media_id=media_id, limit=limit)

    hits: dict[UUID, _RelatedHit] = {}
    for peer_id, distance in similar:
        hits[peer_id] = _RelatedHit(media_id=peer_id, best_distance=distance, shared_author_count=0)
    for peer_id, author_count in shared:
        existing = hits.get(peer_id)
        if existing is None:
            hits[peer_id] = _RelatedHit(
                media_id=peer_id, best_distance=None, shared_author_count=author_count
            )
        else:
            hits[peer_id] = _RelatedHit(
                media_id=peer_id,
                best_distance=existing.best_distance,
                shared_author_count=author_count,
            )

    ordered = sorted(hits.values(), key=_rank_key)[:limit]
    return _hydrate_related(db, viewer_id=viewer_id, hits=ordered)


def _rank_key(hit: _RelatedHit) -> tuple[int, float, int, str]:
    """Deterministic total order: similarity peers first (ascending distance),
    then shared-author-only peers (descending count), ``media_id`` tiebreak.

    A peer with a similarity distance sorts in tier 0 ahead of every
    similarity-less peer (tier 1); within tier 0 the smaller distance wins, and
    within tier 1 the larger shared-author count wins. ``media_id`` ascending is
    the stable final tiebreak so identical input yields one fixed order.
    """
    if hit.best_distance is not None:
        return (0, hit.best_distance, 0, str(hit.media_id))
    return (1, 0.0, -hit.shared_author_count, str(hit.media_id))


def _similar_media(
    db: Session, *, viewer_id: UUID, media_id: UUID, limit: int
) -> list[tuple[UUID, float]]:
    """Nearest distinct peer media to the target's first active chunk vector.

    One SQL: a deterministic seed vector from the target media (pinned to its
    active embedding model/provider) drives an ANN-shaped nearest-chunk query
    over every other visible media on the SAME active model/provider. Candidate
    chunks are limited before deduping by peer media, preserving the vector-index
    query shape and avoiding a target-chunk x visible-chunk scan. The target
    media is excluded.
    """
    candidate_limit = max(limit * 20, 100)
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
            target_state AS (
                SELECT cis.active_embedding_provider AS provider,
                       cis.active_embedding_model AS model
                FROM content_index_states cis
                WHERE cis.owner_kind = 'media'
                  AND cis.owner_id = :media_id
                  AND cis.status = 'ready'
                  AND cis.active_embedding_provider IS NOT NULL
                  AND cis.active_embedding_model IS NOT NULL
            ),
            target_vector AS (
                SELECT ce.embedding_vector AS vec
                FROM content_chunks cc
                JOIN content_embeddings ce ON ce.chunk_id = cc.id
                JOIN target_state ts
                  ON ce.embedding_provider = ts.provider
                 AND ce.embedding_model = ts.model
                WHERE cc.owner_kind = 'media'
                  AND cc.owner_id = :media_id
                  AND ce.embedding_dimensions = :embedding_dims
                  AND ce.embedding_vector IS NOT NULL
                ORDER BY cc.chunk_idx ASC, cc.id ASC
                LIMIT 1
            ),
            nearest_chunks AS (
                SELECT cc.owner_id AS peer_media_id,
                       (ce.embedding_vector <=> tv.vec) AS distance
                FROM target_vector tv
                JOIN content_embeddings ce
                  ON ce.embedding_dimensions = :embedding_dims
                 AND ce.embedding_vector IS NOT NULL
                JOIN content_chunks cc ON cc.id = ce.chunk_id
                JOIN visible_media vm ON vm.media_id = cc.owner_id
                JOIN content_index_states pcis
                  ON pcis.owner_kind = 'media'
                 AND pcis.owner_id = cc.owner_id
                 AND pcis.status = 'ready'
                JOIN target_state ts
                  ON pcis.active_embedding_provider = ts.provider
                 AND pcis.active_embedding_model = ts.model
                 AND ce.embedding_provider = ts.provider
                 AND ce.embedding_model = ts.model
                WHERE cc.owner_kind = 'media'
                  AND cc.owner_id <> :media_id
                ORDER BY ce.embedding_vector <=> tv.vec ASC, cc.owner_id ASC, cc.id ASC
                LIMIT :candidate_limit
            )
            SELECT peer_media_id, MIN(distance) AS best_distance
            FROM nearest_chunks
            GROUP BY peer_media_id
            ORDER BY best_distance ASC, peer_media_id ASC
            LIMIT :limit
            """
        ),
        {
            "viewer_id": viewer_id,
            "media_id": media_id,
            "embedding_dims": transcript_embedding_dimensions(),
            "candidate_limit": candidate_limit,
            "limit": limit,
        },
    ).fetchall()
    return [(UUID(str(row[0])), float(row[1])) for row in rows]


def _shared_author_media(
    db: Session, *, viewer_id: UUID, media_id: UUID, limit: int
) -> list[tuple[UUID, int]]:
    """Other visible media sharing an ``author`` contributor with the target.

    Joins the target's ``author`` credits to other media's ``author`` credits on
    ``contributor_id`` (the same identity ``resolve._load_media`` aggregates),
    counts the distinct shared author contributors per peer, scoped to visible
    media, with the target excluded.
    """
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT other.media_id AS peer_media_id,
                   COUNT(DISTINCT other.contributor_id) AS shared_authors
            FROM contributor_credits target
            JOIN contributor_credits other
              ON other.contributor_id = target.contributor_id
             AND other.role = 'author'
             AND other.media_id IS NOT NULL
             AND other.media_id <> :media_id
            WHERE target.media_id = :media_id
              AND target.role = 'author'
              AND other.media_id IN (SELECT media_id FROM visible_media)
            GROUP BY other.media_id
            ORDER BY shared_authors DESC, peer_media_id ASC
            LIMIT :limit
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id, "limit": limit},
    ).fetchall()
    return [(UUID(str(row[0])), int(row[1])) for row in rows]


def _hydrate_related(
    db: Session, *, viewer_id: UUID, hits: list[_RelatedHit]
) -> list[ConnectionEndpoint]:
    """Resolve every peer media:<id> ref in one batch (mirrors ``_hydrate_peer_endpoints``)."""
    refs = [ResourceRef(scheme="media", id=hit.media_id) for hit in hits]
    resolved = resolve_refs(db, viewer_id=viewer_id, refs=refs)
    endpoints: list[ConnectionEndpoint] = []
    for ref, item in zip(refs, resolved, strict=True):
        activation = resource_activation_for_ref(
            db, viewer_id=viewer_id, ref=ref, missing=item.missing
        )
        endpoints.append(
            ConnectionEndpoint(
                ref=ref,
                label=item.label,
                description=item.summary or None,
                activation=activation,
                href=activation.href,
                missing=item.missing,
            )
        )
    return endpoints
