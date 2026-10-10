"""The atlas: one global 2-d frame of media, drawn per viewer over what they can see.

``project_all`` (the periodic ``atlas_project_job``) is the sole writer of
``media_atlas_positions``: the mean of each filed media's active-model embeddings,
one pure-python power-iteration PCA over all of them, normalized to [0, 1], one
repulsion pass, upserted; positions outside the frame are deleted. New media wait
unpositioned (the nebula) for the next sweep. ``read_atlas`` reads the viewer's
personal relation (every media of their non-system memberships), so corpus works
never become stars.
"""

import math
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.session import get_session_factory
from nexus.schemas.atlas import AtlasEdgeOut, AtlasOut, ConstellationOut, StarOut
from nexus.services.embeddings import EMBEDDING_PROVIDER, embedding_model
from nexus.services.library_entries import library_media_ids_cte_sql

_PERSONAL = library_media_ids_cte_sql()  # binds :viewer_id and :library_id (their Default)


def read_atlas(db: Session, *, viewer_id: UUID, default_library_id: UUID) -> AtlasOut:
    params = {"viewer_id": viewer_id, "library_id": default_library_id}
    stars = db.execute(
        text(
            f"""
            SELECT m.id AS media_id, p.x, p.y, m.title, m.kind,
                   (SELECT count(*) FROM highlights h
                    WHERE h.anchor_media_id = m.id AND h.user_id = :viewer_id) AS magnitude
            FROM media m
            JOIN ({_PERSONAL}) personal ON personal.media_id = m.id
            LEFT JOIN media_atlas_positions p ON p.media_id = m.id
            """
        ),
        params,
    ).mappings()
    star_outs = [StarOut.model_validate(row) for row in stars]
    # One constellation per non-system membership; the viewer's Default is "All".
    libraries = db.execute(
        text(
            f"""
            SELECT l.id AS library_id, CASE WHEN l.is_default THEN 'All' ELSE l.name END AS name,
                   CASE WHEN l.is_default THEN ARRAY(SELECT media_id FROM ({_PERSONAL}) a)
                        ELSE ARRAY(SELECT DISTINCT le.media_id FROM library_entries le
                                   WHERE le.library_id = l.id AND le.media_id IS NOT NULL
                                     AND le.media_id IN ({visible_media_ids_cte_sql()}))
                   END AS member_media_ids
            FROM libraries l
            JOIN memberships ms ON ms.library_id = l.id AND ms.user_id = :viewer_id
            WHERE l.system_key IS NULL
            """
        ),
        params,
    ).mappings()
    # Discovery context links target evidence spans; a span stands for its media.
    edges = db.execute(
        text(
            f"""
            SELECT DISTINCT e.source_id AS source_media_id,
                   COALESCE(es.owner_id, e.target_id) AS target_media_id, e.kind, e.origin
            FROM resource_edges e
            LEFT JOIN evidence_spans es ON e.target_scheme = 'evidence_span'
                AND es.id = e.target_id AND es.owner_kind = 'media'
            WHERE e.user_id = :viewer_id AND e.source_scheme = 'media'
              AND (e.target_scheme = 'media' OR es.id IS NOT NULL)
              AND ((e.origin = 'discovery' AND e.kind = 'context') OR e.kind = 'contradicts')
              AND e.source_id IN ({_PERSONAL})
              AND COALESCE(es.owner_id, e.target_id) IN ({_PERSONAL})
              AND COALESCE(es.owner_id, e.target_id) <> e.source_id
            """
        ),
        params,
    ).mappings()
    return AtlasOut(
        stars=star_outs,
        constellations=[
            ConstellationOut.model_validate(row) for row in libraries if row["member_media_ids"]
        ],
        edges=[AtlasEdgeOut.model_validate(row) for row in edges],
    )


def project_all(db: Session) -> int:
    """Recompute the one frame; flush only. Returns the positioned count."""
    rows = db.execute(
        text(
            """
            SELECT cc.owner_id, avg(ce.embedding_vector)
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
            """
        ),
        {
            "provider": EMBEDDING_PROVIDER,
            "model": embedding_model(),
        },
    ).all()
    # pgvector's avg() reaches python as its text literal, "[a,b,...]".
    vectors = [[float(v) for v in str(mean).strip("[]").split(",")] for _, mean in rows]
    positions = _repulse(_pca(vectors))
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


def atlas_project_job() -> dict[str, int]:
    with get_session_factory()() as db:
        positioned = project_all(db)
        db.commit()
    return {"positioned": positioned}


def _pca(vectors: list[list[float]]) -> list[tuple[float, float]]:
    """The first two principal components, min-max normalized; a ring below three vectors.

    Deterministic: component 1 iterates from the unit axis e0, component 2 from e1 and is
    re-orthogonalized against component 1 on every step, so a dominant first eigenvalue
    cannot drag it back onto the first axis.
    """
    n = len(vectors)
    if n < 3:  # degenerate: nothing, a point, or a pair
        return [(0.5, 0.5)] if n == 1 else [(0.9, 0.5), (0.1, 0.5)][:n]
    dims = len(vectors[0])
    mean = [math.fsum(vector[i] for vector in vectors) / n for i in range(dims)]
    centered = [[value - mean[i] for i, value in enumerate(vector)] for vector in vectors]
    pc1 = _component(centered, [1.0] + [0.0] * (dims - 1), [])
    seed = [0.0, 1.0] + [0.0] * (dims - 2)
    pc2 = _component(centered, [s - pc1[1] * p for s, p in zip(seed, pc1, strict=True)], [pc1])
    xs = _unit_interval([_dot(row, pc1) for row in centered])
    ys = _unit_interval([_dot(row, pc2) for row in centered])
    return list(zip(xs, ys, strict=True))


def _component(rows: list[list[float]], seed: list[float], basis: list[list[float]]) -> list[float]:
    v = _normalize(seed)
    for _ in range(20):
        w = [0.0] * len(v)
        for row in rows:
            projection = _dot(row, v)
            for i, value in enumerate(row):
                w[i] += value * projection
        for b in basis:
            overlap = _dot(w, b)
            w = [wi - overlap * bi for wi, bi in zip(w, b, strict=True)]
        v = _normalize(w)
    return v


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


def _unit_interval(values: list[float]) -> list[float]:
    low, span = min(values), max(values) - min(values)
    return [0.5 if span == 0 else (value - low) / span for value in values]


def _dot(a: list[float], b: list[float]) -> float:
    return math.fsum(x * y for x, y in zip(a, b, strict=True))


def _normalize(v: list[float]) -> list[float]:
    norm = math.sqrt(_dot(v, v))
    return v if norm == 0.0 else [x / norm for x in v]
