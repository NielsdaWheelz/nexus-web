"""The atlas: one global 2-d frame of media, drawn per viewer over what they can see.

The periodic ``atlas_project_job`` is the sole writer of ``media_atlas_positions``: the mean
active-model embedding of each media filed in any non-system library, one deterministic
power-iteration PCA, min-max normalized, one repulsion pass, upserted; positions outside
the frame are deleted. New media wait unpositioned (the nebula) for the next sweep.
``read_atlas`` reads the viewer's personal relation, so corpus works never become stars.
"""

import math
from collections.abc import Mapping
from typing import Any
from uuid import UUID

import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext
from nexus.schemas.atlas import AtlasEdgeOut, AtlasOut, ConstellationOut, StarOut
from nexus.services.embeddings import EMBEDDING_PROVIDER, embedding_model
from nexus.services.library_entries import library_media_ids_cte_sql

_PERSONAL = library_media_ids_cte_sql()  # :library_id is own all: physical non-system memberships


def read_atlas(db: Session, *, viewer_id: UUID, default_library_id: UUID) -> AtlasOut:
    params = {"viewer_id": viewer_id, "library_id": default_library_id}
    stars = db.execute(
        text(f"""
            SELECT m.id AS media_id, p.x, p.y, m.title, m.kind,
                   (SELECT count(*) FROM highlights h
                    WHERE h.anchor_media_id = m.id AND h.user_id = :viewer_id
                      AND h.authored_visible) AS magnitude
            FROM media m
            JOIN ({_PERSONAL}) personal ON personal.media_id = m.id
            LEFT JOIN media_atlas_positions p ON p.media_id = m.id
        """),
        params,
    ).mappings()
    # One constellation per non-system membership; the Default holds every star ("All").
    # `lib` must not be an alias the relation uses inside (le, l, m, dl): it would shadow it.
    libraries = db.execute(
        text(f"""
            SELECT lib.id AS library_id,
                   CASE WHEN lib.is_default THEN 'All' ELSE lib.name END AS name,
                   ARRAY({library_media_ids_cte_sql(library_param="lib.id")}) AS member_media_ids
            FROM libraries lib
            JOIN memberships ms ON ms.library_id = lib.id AND ms.user_id = :viewer_id
            WHERE lib.system_key IS NULL
        """),
        params,
    ).mappings()
    # A discovery link targets an evidence span, which stands for its media.
    edges = db.execute(
        text(f"""
            SELECT DISTINCT e.source_id AS source_media_id,
                   COALESCE(es.owner_id, e.target_id) AS target_media_id, e.kind
            FROM resource_edges e
            LEFT JOIN evidence_spans es ON e.target_scheme = 'evidence_span'
                AND es.id = e.target_id AND es.owner_kind = 'media'
            WHERE e.user_id = :viewer_id AND e.source_scheme = 'media'
              AND (e.target_scheme = 'media' OR es.id IS NOT NULL)
              AND ((e.origin = 'discovery' AND e.kind = 'context') OR e.kind = 'contradicts')
              AND e.source_id IN ({_PERSONAL})
              AND COALESCE(es.owner_id, e.target_id) IN ({_PERSONAL})
              AND COALESCE(es.owner_id, e.target_id) <> e.source_id
        """),
        params,
    ).mappings()
    return AtlasOut(
        stars=[StarOut.model_validate(row) for row in stars],
        constellations=[
            ConstellationOut.model_validate(row) for row in libraries if row["member_media_ids"]
        ],
        edges=[AtlasEdgeOut.model_validate(row) for row in edges],
    )


def project_all(db: Session) -> int:
    """Recompute the one frame; flush only. Returns the positioned count."""
    rows = db.execute(
        text("""
            SELECT cc.owner_id, CAST(avg(ce.embedding_vector) AS real[])
            FROM content_chunks cc
            JOIN content_index_states cis ON cis.owner_kind = 'media'
                AND cis.owner_id = cc.owner_id AND cis.status = 'ready'
                AND cis.active_embedding_provider = :provider
                AND cis.active_embedding_model = :model
            JOIN content_embeddings ce ON ce.chunk_id = cc.id
                AND ce.embedding_provider = :provider AND ce.embedding_model = :model
                AND ce.embedding_vector IS NOT NULL
            WHERE cc.owner_kind = 'media' AND EXISTS (
                SELECT 1 FROM library_entries le JOIN libraries l ON l.id = le.library_id
                WHERE le.media_id = cc.owner_id AND l.system_key IS NULL)
            GROUP BY cc.owner_id
        """),
        {"provider": EMBEDDING_PROVIDER, "model": embedding_model()},
    ).all()
    positions = _repulse(_frame(np.array([mean for _, mean in rows], dtype=np.float64)))
    db.execute(
        text("DELETE FROM media_atlas_positions WHERE media_id <> ALL(:ids)"),
        {"ids": [media_id for media_id, _ in rows]},
    )
    if rows:
        db.execute(
            text(
                "INSERT INTO media_atlas_positions (media_id, x, y) VALUES (:id, :x, :y)"
                " ON CONFLICT (media_id) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y"
            ),
            [{"id": row[0], "x": x, "y": y} for row, (x, y) in zip(rows, positions, strict=True)],
        )
    return len(rows)


def atlas_project_job(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> dict[str, int]:
    """A retry recomputes the whole frame in one transaction (idempotent)."""
    with get_session_factory()() as db:
        positioned = project_all(db)
        db.commit()
    return {"positioned": positioned}


def _frame(vectors: np.ndarray) -> list[tuple[float, float]]:
    """The first two principal components, min-max normalized; fixed spots below three.

    Deterministic: component 1 iterates 20 times from the unit axis e0, component 2 from e1
    and is re-orthogonalized against component 1 on every step, so a dominant first
    eigenvalue cannot drag it back onto the first axis.
    """
    n = len(vectors)
    if n < 3:
        return [(0.5, 0.5)] if n == 1 else [(0.9, 0.5), (0.1, 0.5)][:n]
    centered = vectors - vectors.mean(axis=0)
    e0, e1 = np.eye(2, centered.shape[1])
    pc1 = _component(centered, e0, None)
    pc2 = _component(centered, e1 - pc1[1] * pc1, pc1)
    return list(zip(_unit_interval(centered @ pc1), _unit_interval(centered @ pc2), strict=True))


def _component(rows: np.ndarray, seed: np.ndarray, against: np.ndarray | None) -> np.ndarray:
    v = _normalize(seed)
    for _ in range(20):
        w = rows.T @ (rows @ v)
        if against is not None:
            w -= (w @ against) * against
        v = _normalize(w)
    return v


def _normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v)
    return v if norm == 0.0 else v / norm


def _unit_interval(values: np.ndarray) -> list[float]:
    low, span = values.min(), values.max() - values.min()
    return [0.5] * len(values) if span == 0 else ((values - low) / span).tolist()


def _repulse(points: list[tuple[float, float]], gap: float = 0.02) -> list[tuple[float, float]]:
    """One O(n²) pass pushing pairs closer than ``gap`` apart along their line."""
    pts = [list(point) for point in points]
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            dx, dy = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
            dist = math.hypot(dx, dy)
            if dist >= gap:
                continue
            if dist == 0.0:
                dx, dist = gap, gap
            shove = (gap - dist) / 2
            for k, d in ((0, dx), (1, dy)):
                pts[i][k] -= d / dist * shove
                pts[j][k] += d / dist * shove
    return [(min(1.0, max(0.0, x)), min(1.0, max(0.0, y))) for x, y in pts]
