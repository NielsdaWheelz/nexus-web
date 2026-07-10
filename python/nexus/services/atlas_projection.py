"""Grand atlas projection: the sole writer of ``media_atlas_positions``.

Computes a persistent 2D position per work from its mean content embedding via
pure-Python power-iteration PCA (no numpy — grand-atlas §D-2/G1), normalizes to
[0, 1], runs one bounded repulsion pass, and upserts. Positions map to celestial
coordinates at render time (§4.2).
"""

from __future__ import annotations

import math
from collections import defaultdict
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_unique_job
from nexus.logging import get_logger

logger = get_logger(__name__)

# Batch the nightly re-projection only when the unpositioned backlog is
# meaningful, so a single ingest does not churn the whole map (§S1.5).
ATLAS_REPROJECT_TRIGGER_MIN_UNPOSITIONED = 20

_EMBEDDING_DIMS = 256
_PCA_ITERATIONS = 20
# Fewer works than components requested makes PCA degenerate (§R-1): fall back to
# an evenly-spaced ring, which the repulsion pass then leaves alone.
_MIN_PCA_VECTORS = 3


# ---------- mean embeddings -------------------------------------------------


def _visible_media_sql() -> str:
    """SQL predicate subquery listing the user's visible media ids."""
    return (
        "SELECT le.media_id FROM library_entries le"
        " JOIN libraries l ON l.id = le.library_id"
        " WHERE l.owner_user_id = :user_id AND le.media_id IS NOT NULL"
    )


def _parse_pgvector_literal(raw: object) -> list[float]:
    """Parse a pgvector text literal ``[a,b,...]`` into a list of floats.

    The PGVector column has no SQLAlchemy result processor, so both a raw select
    and an ``avg()`` aggregate come back as the pgvector text representation.
    """
    if isinstance(raw, (list, tuple)):
        return [float(value) for value in raw]
    body = str(raw).strip().lstrip("[").rstrip("]")
    if not body:
        return []
    return [float(token) for token in body.split(",")]


def fetch_mean_embeddings(db: Session, user_id: UUID) -> list[tuple[UUID, list[float]]]:
    """Return ``(media_id, mean_vector)`` for each visible work with embeddings.

    Uses the pgvector ``avg()`` aggregate (§D-1); falls back to Python averaging
    if the installed image lacks ``avg(vector)`` (§R-3).
    """
    try:
        rows = db.execute(
            text(
                f"""
                SELECT c.owner_id AS media_id, avg(e.embedding_vector) AS mean
                FROM content_chunks c
                JOIN content_embeddings e ON e.chunk_id = c.id
                WHERE c.owner_kind = 'media'
                  AND c.owner_id IN ({_visible_media_sql()})
                  AND e.embedding_vector IS NOT NULL
                GROUP BY c.owner_id
                HAVING count(e.id) > 0
                """
            ),
            {"user_id": user_id},
        ).all()
        return [(row.media_id, _parse_pgvector_literal(row.mean)) for row in rows]
    except ProgrammingError as exc:
        if "avg(vector)" not in str(exc) and "function avg" not in str(exc):
            raise
        logger.warning("atlas_avg_vector_unavailable_fallback_python", error=str(exc))
        db.rollback()
        return _fetch_mean_embeddings_python(db, user_id)


def _fetch_mean_embeddings_python(db: Session, user_id: UUID) -> list[tuple[UUID, list[float]]]:
    rows = db.execute(
        text(
            f"""
            SELECT c.owner_id AS media_id, e.embedding_vector AS vec
            FROM content_chunks c
            JOIN content_embeddings e ON e.chunk_id = c.id
            WHERE c.owner_kind = 'media'
              AND c.owner_id IN ({_visible_media_sql()})
              AND e.embedding_vector IS NOT NULL
            """
        ),
        {"user_id": user_id},
    ).all()
    sums: dict[UUID, list[float]] = {}
    counts: dict[UUID, int] = defaultdict(int)
    for row in rows:
        vec = _parse_pgvector_literal(row.vec)
        if row.media_id not in sums:
            sums[row.media_id] = [0.0] * len(vec)
        acc = sums[row.media_id]
        for i, value in enumerate(vec):
            acc[i] += value
        counts[row.media_id] += 1
    return [
        (media_id, [component / counts[media_id] for component in acc])
        for media_id, acc in sums.items()
    ]


# ---------- pure-Python PCA -------------------------------------------------


def _dot(a: list[float], b: list[float]) -> float:
    return math.fsum(x * y for x, y in zip(a, b, strict=False))


def _normalize(v: list[float]) -> list[float]:
    norm = math.sqrt(_dot(v, v))
    if norm == 0.0:
        return v
    return [x / norm for x in v]


def _power_iteration(
    centered: list[list[float]],
    seed: list[float],
    orthogonal_to: list[list[float]] | None = None,
) -> list[float]:
    """Dominant eigenvector of the covariance (X^T X) via power iteration.

    ``orthogonal_to`` deflates the iterate against already-found components on
    every step (not just the seed): with a dominant eigenvalue (λ1 ≫ λ2),
    floating-point drift re-amplifies the first component, so component 2 needs
    per-iteration Gram-Schmidt to converge to the true second-largest variance
    direction instead of collapsing back onto component 1 (a diagonal streak).
    """
    v = _normalize(seed)
    for _ in range(_PCA_ITERATIONS):
        # w = X^T (X v): project rows onto v, then accumulate back.
        projections = [_dot(row, v) for row in centered]
        w = [0.0] * len(v)
        for row, p in zip(centered, projections, strict=False):
            for i, value in enumerate(row):
                w[i] += value * p
        if orthogonal_to:
            for basis in orthogonal_to:
                overlap = _dot(w, basis)
                for i in range(len(w)):
                    w[i] -= overlap * basis[i]
        v = _normalize(w)
    return v


def _ring_layout(count: int) -> list[tuple[float, float]]:
    """Evenly-spaced ring — the degenerate-corpus fallback (§R-1)."""
    if count == 1:
        return [(0.5, 0.5)]
    return [
        (
            0.5 + 0.4 * math.cos(2 * math.pi * i / count),
            0.5 + 0.4 * math.sin(2 * math.pi * i / count),
        )
        for i in range(count)
    ]


def pca_2d(vectors: list[list[float]]) -> list[tuple[float, float]]:
    """Project N vectors to 2D via power-iteration PCA, normalized to [0, 1].

    Deterministic: component 1 seeds from the unit axis e0, component 2 from e1
    made orthogonal to component 1. Fewer than 3 vectors → ring fallback.
    """
    n = len(vectors)
    if n == 0:
        return []
    if n < _MIN_PCA_VECTORS:
        return _ring_layout(n)

    dims = len(vectors[0])
    mean = [math.fsum(vec[i] for vec in vectors) / n for i in range(dims)]
    centered = [[vec[i] - mean[i] for i in range(dims)] for vec in vectors]

    seed1 = [0.0] * dims
    seed1[0] = 1.0
    pc1 = _power_iteration(centered, seed1)

    seed2 = [0.0] * dims
    seed2[1 if dims > 1 else 0] = 1.0
    # Orthogonalize seed2 against pc1 (Gram-Schmidt) so component 2 starts in the
    # orthogonal complement; ``orthogonal_to`` then keeps it there on every
    # iteration so it converges to the second-largest variance direction rather
    # than re-amplifying pc1 (which would degenerate the map toward a diagonal).
    dot_s2_pc1 = _dot(seed2, pc1)
    seed2 = [seed2[i] - dot_s2_pc1 * pc1[i] for i in range(dims)]
    pc2 = _power_iteration(centered, seed2, orthogonal_to=[pc1])

    xs = [_dot(row, pc1) for row in centered]
    ys = [_dot(row, pc2) for row in centered]
    return list(zip(_min_max_normalize(xs), _min_max_normalize(ys), strict=False))


def _min_max_normalize(values: list[float]) -> list[float]:
    lo = min(values)
    hi = max(values)
    span = hi - lo
    if span == 0.0:
        return [0.5 for _ in values]
    return [min(1.0, max(0.0, (v - lo) / span)) for v in values]


# ---------- repulsion -------------------------------------------------------


def repulse(
    positions: list[tuple[float, float]], *, min_dist: float = 0.02
) -> list[tuple[float, float]]:
    """One O(N²) pass pushing overlapping pairs apart along their connecting vector."""
    pts = [[x, y] for x, y in positions]
    n = len(pts)
    for i in range(n):
        for j in range(i + 1, n):
            dx = pts[j][0] - pts[i][0]
            dy = pts[j][1] - pts[i][1]
            dist = math.hypot(dx, dy)
            if dist >= min_dist:
                continue
            if dist == 0.0:
                # Coincident: nudge along a stable pseudo-random-ish axis.
                dx, dy, dist = min_dist, 0.0, min_dist
            shove = (min_dist - dist) / 2.0
            ux, uy = dx / dist, dy / dist
            pts[i][0] -= ux * shove
            pts[i][1] -= uy * shove
            pts[j][0] += ux * shove
            pts[j][1] += uy * shove
    return [(min(1.0, max(0.0, x)), min(1.0, max(0.0, y))) for x, y in pts]


# ---------- upsert + orchestration ------------------------------------------


def upsert_positions(db: Session, positions: dict[UUID, tuple[float, float]]) -> int:
    """UPSERT positions, bumping ``projection_version`` on conflict. Returns rows written."""
    count = 0
    for media_id, (x, y) in positions.items():
        db.execute(
            text(
                """
                INSERT INTO media_atlas_positions (media_id, x, y)
                VALUES (:media_id, :x, :y)
                ON CONFLICT (media_id) DO UPDATE SET
                    x = EXCLUDED.x,
                    y = EXCLUDED.y,
                    projection_version = media_atlas_positions.projection_version + 1,
                    computed_at = now()
                """
            ),
            {"media_id": media_id, "x": float(x), "y": float(y)},
        )
        count += 1
    return count


def run_projection(db: Session, user_id: UUID) -> dict:
    """Fetch → PCA → repulse → upsert for one user. Flush-only; caller commits."""
    means = fetch_mean_embeddings(db, user_id)
    if not means:
        return {"positioned": 0, "skipped_no_embeddings": 0}
    media_ids = [media_id for media_id, _ in means]
    vectors = [vec for _, vec in means]
    projected = repulse(pca_2d(vectors))
    positions = dict(zip(media_ids, projected, strict=False))
    written = upsert_positions(db, positions)
    return {"positioned": written, "skipped_no_embeddings": 0}


def count_unpositioned(db: Session, user_id: UUID) -> int:
    """How many visible works have no atlas position row yet."""
    return int(
        db.execute(
            text(
                f"""
                SELECT count(DISTINCT v.media_id)
                FROM ({_visible_media_sql()}) v(media_id)
                LEFT JOIN media_atlas_positions p ON p.media_id = v.media_id
                WHERE p.media_id IS NULL
                """
            ),
            {"user_id": user_id},
        ).scalar_one()
    )


def list_projectable_user_ids(db: Session) -> list[UUID]:
    """Users owning at least one library entry — the periodic sweep scope."""
    rows = db.execute(
        text(
            "SELECT DISTINCT l.owner_user_id"
            " FROM libraries l JOIN library_entries le ON le.library_id = l.id"
            " WHERE le.media_id IS NOT NULL"
        )
    ).all()
    return [row[0] for row in rows]


# ---------- enqueue ---------------------------------------------------------


def _atlas_dedupe_key(user_id: UUID) -> str:
    return f"atlas_project:{user_id}"


def try_enqueue_atlas_project(db: Session, *, user_id: UUID, force: bool = False) -> bool:
    """Soft-enqueue one projection for ``user_id``; never breaks the host write.

    Rides the caller's transaction (flush-only) behind a SAVEPOINT so a queue
    defect cannot fail an ingest/promote commit. When ``force`` is False, only
    enqueues once the unpositioned backlog exceeds the trigger threshold (§S1.5),
    so a single ingest does not re-project the whole map. Returns True only when
    a new job row was inserted.
    """
    try:
        with db.begin_nested():
            if not force:
                if count_unpositioned(db, user_id) <= ATLAS_REPROJECT_TRIGGER_MIN_UNPOSITIONED:
                    return False
            dedupe_key = _atlas_dedupe_key(user_id)
            db.execute(
                text(
                    "DELETE FROM background_jobs"
                    " WHERE dedupe_key = :k AND status IN ('succeeded', 'dead')"
                ),
                {"k": dedupe_key},
            )
            _, inserted = enqueue_unique_job(
                db,
                kind="atlas_project_job",
                payload={"user_id": str(user_id)},
                dedupe_key=dedupe_key,
            )
        return inserted
    except SQLAlchemyError as exc:
        logger.warning("atlas_project_enqueue_failed", user_id=str(user_id), error=str(exc))
        return False
