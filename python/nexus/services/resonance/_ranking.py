"""Contextual ranking policy and the checked-in Slate semantic calibration."""

from __future__ import annotations

import math
from dataclasses import dataclass
from uuid import UUID

from nexus.schemas.resonance import ResonanceEdgeOrigin

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


@dataclass(frozen=True, slots=True)
class RelatedHit:
    media_id: UUID
    best_distance: float | None
    shared_author_count: int


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
