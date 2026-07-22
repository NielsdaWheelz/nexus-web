"""Contextual ranking policy and the checked-in Slate semantic calibration."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql, visible_podcast_ids_cte_sql
from nexus.schemas.resonance import ResonanceEdgeOrigin
from nexus.services import library_entries
from nexus.services import media as media_service
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_credits import visible_author_credit_rows_sql
from nexus.services.podcasts.episodes import episode_publication_rows_sql
from nexus.services.resource_graph.connection_summaries import edge_fact_rows_sql
from nexus.services.resource_graph.resolve import resource_owner_rows_sql
from nexus.services.semantic_chunks import (
    media_best_peer_rows_sql,
    transcript_embedding_dimensions,
)

SLATE_LIMIT = 10
SLATE_ANCHOR_LIMIT = 5
SLATE_FAMILY_CANDIDATE_LIMIT = 20
SLATE_UNIQUE_CANDIDATE_LIMIT = 80
CONTINUITY_MAX_IDLE_DAYS = 30
ARRIVAL_WINDOW_DAYS = 14
REDISCOVERY_MIN_AGE_DAYS = 90
RESONANCE_EDGE_ORIGINS: tuple[ResonanceEdgeOrigin, ...] = (
    "user",
    "citation",
    "note_body",
    "highlight_note",
    "document_embed",
    "synapse",
)
SEMANTIC_CHUNK_CANDIDATE_MULTIPLIER = 20
SEMANTIC_CHUNK_CANDIDATE_MINIMUM = 100


@dataclass(frozen=True, slots=True)
class SemanticCalibration:
    provider: str
    model: str
    dimensions: int
    min_similarity: float


# Human-reviewed production evidence is frozen in the test-only calibration
# fixture. Runtime owns only this literal tuple and never reads test data.
SLATE_SEMANTIC_CALIBRATION = SemanticCalibration(
    provider="openai",
    model="openai_text_embedding_3_small_256_v1",
    dimensions=256,
    min_similarity=0.80,
)

_LIBRARY_RECENCY_WEIGHT = 1.0
_LIBRARY_CONNECTION_WEIGHT = 0.1
_LIBRARY_SHARED_AUTHOR_WEIGHT = 0.05
_LIBRARY_SEMANTIC_WEIGHT = 0.05
_LIBRARY_RECENCY_HALF_LIFE_DAYS = 14.0


@dataclass(frozen=True, slots=True)
class RelatedHit:
    media_id: UUID
    best_distance: float | None
    shared_author_count: int


@dataclass(frozen=True, slots=True)
class RankedLibraryEntry:
    hydration: library_entries.LibraryEntryHydrationFact
    score: float


def exact_day_date_sql(value_sql: str) -> str:
    """Return a total PostgreSQL expression for a canonical real calendar date."""
    year = f"substring({value_sql} from 1 for 4)::integer"
    month = f"substring({value_sql} from 6 for 2)::integer"
    day = f"substring({value_sql} from 9 for 2)::integer"
    last_day = f"""
        CASE
            WHEN {month} = 2 THEN
                CASE
                    WHEN {year} % 400 = 0
                      OR ({year} % 4 = 0 AND {year} % 100 <> 0)
                    THEN 29
                    ELSE 28
                END
            WHEN {month} IN (4, 6, 9, 11) THEN 30
            ELSE 31
        END
    """
    return f"""
        CASE
            WHEN {value_sql} ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$' THEN
                CASE
                    WHEN {year} BETWEEN 1 AND 9999
                     AND {month} BETWEEN 1 AND 12
                     AND {day} BETWEEN 1 AND ({last_day})
                    THEN make_date({year}, {month}, {day})
                END
        END
    """


def semantic_chunk_candidate_limit(distinct_media_limit: int) -> int:
    return max(
        distinct_media_limit * SEMANTIC_CHUNK_CANDIDATE_MULTIPLIER,
        SEMANTIC_CHUNK_CANDIDATE_MINIMUM,
    )


def rank_related(hits: list[RelatedHit], *, limit: int) -> list[RelatedHit]:
    return sorted(hits, key=_related_key)[:limit]


def _related_key(hit: RelatedHit) -> tuple[int, float, int, str]:
    if hit.best_distance is not None:
        return (0, hit.best_distance, 0, str(hit.media_id))
    return (1, 0.0, -hit.shared_author_count, str(hit.media_id))


def slate_semantic_qualifies(
    *,
    provider: str,
    model: str,
    dimensions: int,
    similarity: float,
) -> bool:
    calibration = SLATE_SEMANTIC_CALIBRATION
    return (
        provider == calibration.provider
        and model == calibration.model
        and dimensions == calibration.dimensions
        and math.isfinite(similarity)
        and similarity >= calibration.min_similarity
    )


def rank_library_entries(
    db: Session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    as_of: datetime,
    after_score: float | None,
    after_entry_id: UUID | None,
    limit: int,
) -> list[RankedLibraryEntry]:
    """Score complete visible membership before strict score/id keyset paging."""
    eligible_entries = f"""
        SELECT physical.*
        FROM ({library_entries.physical_entry_rows_sql()}) physical
        WHERE physical.podcast_id IN ({visible_podcast_ids_cte_sql()})
           OR physical.media_id IN ({visible_media_ids_cte_sql()})
    """
    eligible_media = f"""
        SELECT DISTINCT media_id
        FROM ({eligible_entries}) eligible
        WHERE media_id IS NOT NULL
    """
    keyset = ""
    params: dict[str, object] = {
        "viewer_id": viewer_id,
        "library_id": library_id,
        "edge_origins": list(RESONANCE_EDGE_ORIGINS),
        "embedding_dimensions": transcript_embedding_dimensions(),
        "as_of": as_of,
        "limit": limit,
    }
    if after_entry_id is not None:
        keyset = """
            WHERE resonance_score < :after_score
               OR (resonance_score = :after_score AND id < :after_entry_id)
        """
        params["after_score"] = after_score
        params["after_entry_id"] = after_entry_id
    rows = db.execute(
        text(f"""
            WITH entries AS ({eligible_entries}),
            engagement AS ({consumption_service.engagement_fact_rows_sql()}),
            episodes AS ({episode_publication_rows_sql()}),
            visible_episode_media AS ({visible_media_ids_cte_sql()}),
            media_candidates AS ({media_service.media_candidate_rows_sql()}),
            edges AS ({edge_fact_rows_sql()}),
            edge_endpoints AS (
                SELECT source_scheme AS scheme, source_id AS id FROM edges
                UNION
                SELECT target_scheme, target_id FROM edges
            ),
            owners AS (
                {
            resource_owner_rows_sql('''
                    SELECT scheme AS resource_scheme, id AS resource_id
                    FROM edge_endpoints
                ''')
        }
            ),
            normalized_edges AS (
                SELECT
                    source.owner_scheme AS source_scheme,
                    source.owner_id AS source_id,
                    target.owner_scheme AS target_scheme,
                    target.owner_id AS target_id,
                    edges.edge_id,
                    edges.created_at
                FROM edges
                JOIN owners source
                  ON source.resource_scheme = edges.source_scheme
                 AND source.resource_id = edges.source_id
                JOIN owners target
                  ON target.resource_scheme = edges.target_scheme
                 AND target.resource_id = edges.target_id
                WHERE (source.owner_scheme, source.owner_id)
                    <> (target.owner_scheme, target.owner_id)
            ),
            incident_edges AS (
                SELECT source_scheme AS entry_scheme, source_id AS entry_id,
                       edge_id, created_at
                FROM normalized_edges
                UNION ALL
                SELECT target_scheme, target_id, edge_id, created_at
                FROM normalized_edges
            ),
            edge_signals AS (
                SELECT
                    entries.id AS library_entry_id,
                    COUNT(DISTINCT incident_edges.edge_id) AS connection_count,
                    MAX(incident_edges.created_at) FILTER (
                        WHERE incident_edges.created_at <= :as_of
                    ) AS last_connected_at
                FROM entries
                LEFT JOIN incident_edges
                  ON incident_edges.entry_scheme = entries.target_scheme
                 AND incident_edges.entry_id = entries.target_id
                GROUP BY entries.id
            ),
            authors AS ({visible_author_credit_rows_sql()}),
            entry_authors AS (
                SELECT DISTINCT entries.id AS library_entry_id, authors.contributor_id
                FROM entries
                JOIN authors ON (
                    (entries.media_id IS NOT NULL AND authors.media_id = entries.media_id)
                    OR (entries.podcast_id IS NOT NULL AND authors.podcast_id = entries.podcast_id)
                )
            ),
            shared_author_signals AS (
                SELECT
                    mine.library_entry_id,
                    COUNT(DISTINCT mine.contributor_id) AS shared_author_hits
                FROM entry_authors mine
                WHERE EXISTS (
                    SELECT 1 FROM entry_authors peer
                    WHERE peer.contributor_id = mine.contributor_id
                      AND peer.library_entry_id <> mine.library_entry_id
                )
                GROUP BY mine.library_entry_id
            ),
            semantic AS ({media_best_peer_rows_sql(eligible_media)}),
            podcast_signals AS (
                SELECT
                    episodes.podcast_id,
                    MAX(engagement.last_engaged_at) FILTER (
                        WHERE visible_episode_media.media_id IS NOT NULL
                          AND engagement.last_engaged_at <= :as_of
                    ) AS last_engaged_at,
                    MAX(episodes.published_at) FILTER (
                        WHERE visible_episode_media.media_id IS NOT NULL
                          AND episodes.published_at <= :as_of
                    ) AS published_at
                FROM episodes
                LEFT JOIN visible_episode_media
                  ON visible_episode_media.media_id = episodes.media_id
                LEFT JOIN engagement
                  ON engagement.media_id = episodes.media_id
                 AND visible_episode_media.media_id IS NOT NULL
                GROUP BY episodes.podcast_id
            ),
            raw_signals AS (
                SELECT
                    entries.*,
                    CASE
                        WHEN entries.media_id IS NOT NULL THEN engagement.last_engaged_at
                        ELSE podcast_signals.last_engaged_at
                    END AS last_engaged_at,
                    edge_signals.last_connected_at,
                    CASE
                        WHEN entries.media_id IS NOT NULL THEN episodes.published_at
                        ELSE podcast_signals.published_at
                    END AS episode_published_at,
                    ({exact_day_date_sql("media_candidates.published_date")})
                        AS published_on,
                    COALESCE(edge_signals.connection_count, 0) AS connection_count,
                    COALESCE(shared_author_signals.shared_author_hits, 0)
                        AS shared_author_hits,
                    CASE
                        WHEN semantic.distance IS NULL THEN 0.0
                        ELSE 1.0 - semantic.distance
                    END AS semantic_similarity
                FROM entries
                LEFT JOIN engagement ON engagement.media_id = entries.media_id
                LEFT JOIN episodes ON episodes.media_id = entries.media_id
                LEFT JOIN podcast_signals
                  ON podcast_signals.podcast_id = entries.podcast_id
                LEFT JOIN media_candidates
                  ON media_candidates.media_id = entries.media_id
                LEFT JOIN edge_signals ON edge_signals.library_entry_id = entries.id
                LEFT JOIN shared_author_signals
                  ON shared_author_signals.library_entry_id = entries.id
                LEFT JOIN semantic ON semantic.anchor_media_id = entries.media_id
            ),
            ages AS (
                SELECT
                    raw_signals.*,
                    LEAST(
                        CASE WHEN created_at <= :as_of
                            THEN EXTRACT(EPOCH FROM (:as_of - created_at)) / 86400.0 END,
                        CASE WHEN last_engaged_at <= :as_of
                            THEN EXTRACT(EPOCH FROM (:as_of - last_engaged_at)) / 86400.0 END,
                        CASE WHEN last_connected_at <= :as_of
                            THEN EXTRACT(EPOCH FROM (:as_of - last_connected_at)) / 86400.0 END,
                        CASE WHEN episode_published_at <= :as_of
                            THEN EXTRACT(EPOCH FROM (:as_of - episode_published_at)) / 86400.0 END,
                        CASE WHEN published_on <= (:as_of AT TIME ZONE 'UTC')::date
                            THEN ((:as_of AT TIME ZONE 'UTC')::date - published_on)::float8 END
                    ) AS recency_age_days
                FROM raw_signals
            ),
            scored AS (
                SELECT
                    id, library_id, media_id, podcast_id, created_at, position,
                    (
                        {_LIBRARY_RECENCY_WEIGHT} * COALESCE(
                            power(
                                0.5,
                                recency_age_days / {_LIBRARY_RECENCY_HALF_LIFE_DAYS}
                            ),
                            0.0
                        )
                        + {_LIBRARY_CONNECTION_WEIGHT} * ln(1.0 + connection_count)
                        + {_LIBRARY_SHARED_AUTHOR_WEIGHT} * shared_author_hits
                        + {_LIBRARY_SEMANTIC_WEIGHT} * semantic_similarity
                    ) AS resonance_score
                FROM ages
            )
            SELECT * FROM scored
            {keyset}
            ORDER BY resonance_score DESC, id DESC
            LIMIT :limit
        """),
        params,
    ).mappings()

    ranked: list[RankedLibraryEntry] = []
    for row in rows:
        media_id = UUID(str(row["media_id"])) if row["media_id"] is not None else None
        podcast_id = UUID(str(row["podcast_id"])) if row["podcast_id"] is not None else None
        if (media_id is None) == (podcast_id is None):
            # justify-defect: physical entry facts preserve the database's exact-one-target
            # constraint across the Resonance-to-Library typed boundary.
            raise AssertionError(f"Library entry {row['id']} has an invalid target")
        created_at = row["created_at"]
        if not isinstance(created_at, datetime):
            # justify-defect: physical Library entry created_at is a non-null timestamptz.
            raise AssertionError(f"Library entry {row['id']} has no creation instant")
        score = float(row["resonance_score"])
        if not math.isfinite(score):
            # justify-defect: bounded persisted evidence always produces a finite score.
            raise AssertionError(f"Library entry {row['id']} has a non-finite score")
        if media_id is not None:
            target = library_entries.media_target(media_id)
        elif podcast_id is not None:
            target = library_entries.podcast_target(podcast_id)
        else:
            # justify-defect: the exact-one-target check above makes this unreachable.
            raise AssertionError(f"Library entry {row['id']} has no target")
        ranked.append(
            RankedLibraryEntry(
                hydration=library_entries.LibraryEntryHydrationFact(
                    id=UUID(str(row["id"])),
                    library_id=UUID(str(row["library_id"])),
                    target=target,
                    created_at=created_at,
                    position=int(row["position"]),
                ),
                score=score,
            )
        )
    return ranked
