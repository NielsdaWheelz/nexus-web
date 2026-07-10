"""Grand atlas read model + on-demand projection trigger (grand-atlas §6).

- GET  /atlas          the celestial chart read model, ETag-cacheable
- GET  /atlas/status   projection coverage for the "chart is computing" UI
- POST /atlas/project  enqueue an atlas_project_job for the requesting user

The route builds the read model with three user-scoped queries; the spatial
substrate and projection live in ``services/atlas_projection.py``.
"""

from __future__ import annotations

import hashlib
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.atlas import (
    AtlasEdgeOut,
    AtlasOut,
    AtlasStatusOut,
    ConstellationOut,
    StarOut,
)
from nexus.services.atlas_projection import try_enqueue_atlas_project

router = APIRouter(prefix="/atlas", tags=["atlas"])


def _compute_etag(max_computed_at: object) -> str:
    seed = max_computed_at.isoformat() if max_computed_at is not None else "empty"  # type: ignore[attr-defined]
    return hashlib.md5(seed.encode()).hexdigest()  # noqa: S324 - cache tag, not security


@router.get("", response_model=None)
def read_atlas(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
) -> dict | Response:
    """Return the grand atlas read model, ETag-cacheable by max(computed_at)."""
    params = {"user_id": viewer.user_id}

    star_rows = db.execute(
        text(
            """
            SELECT m.id AS media_id, m.title, m.kind,
                   p.x, p.y, p.computed_at,
                   COUNT(DISTINCT h.id) AS magnitude
            FROM media m
            JOIN library_entries le ON le.media_id = m.id
            JOIN libraries l ON l.id = le.library_id
            LEFT JOIN media_atlas_positions p ON p.media_id = m.id
            LEFT JOIN highlights h
                   ON h.anchor_media_id = m.id AND h.user_id = :user_id
            WHERE l.owner_user_id = :user_id
            GROUP BY m.id, m.title, m.kind, p.x, p.y, p.computed_at
            """
        ),
        params,
    ).all()

    max_computed_at = max(
        (row.computed_at for row in star_rows if row.computed_at is not None),
        default=None,
    )
    etag = _compute_etag(max_computed_at)
    if if_none_match is not None and if_none_match.strip('"') == etag:
        return Response(status_code=304, headers={"ETag": f'"{etag}"'})

    stars = [
        StarOut(
            media_id=row.media_id,
            x=row.x,
            y=row.y,
            title=row.title,
            kind=row.kind,
            magnitude=int(row.magnitude),
        )
        for row in star_rows
    ]

    constellation_rows = db.execute(
        text(
            """
            SELECT l.id AS library_id, l.name,
                   array_agg(le.media_id) AS member_media_ids
            FROM libraries l
            JOIN library_entries le ON le.library_id = l.id
            WHERE l.owner_user_id = :user_id AND le.media_id IS NOT NULL
            GROUP BY l.id, l.name
            """
        ),
        params,
    ).all()
    constellations = [
        ConstellationOut(
            library_id=row.library_id,
            name=row.name,
            member_media_ids=list(row.member_media_ids),
        )
        for row in constellation_rows
    ]

    edge_rows = db.execute(
        text(
            """
            SELECT re.source_id, re.target_id, re.kind, re.origin
            FROM resource_edges re
            WHERE re.user_id = :user_id
              AND re.source_scheme = 'media'
              AND re.target_scheme = 'media'
              AND (
                  (re.origin = 'synapse' AND re.kind = 'context')
                  OR re.kind = 'contradicts'
              )
              AND re.source_id IN (
                  SELECT le.media_id FROM library_entries le
                  JOIN libraries l ON l.id = le.library_id
                  WHERE l.owner_user_id = :user_id AND le.media_id IS NOT NULL
              )
              AND re.target_id IN (
                  SELECT le.media_id FROM library_entries le
                  JOIN libraries l ON l.id = le.library_id
                  WHERE l.owner_user_id = :user_id AND le.media_id IS NOT NULL
              )
            """
        ),
        params,
    ).all()
    edges = [
        AtlasEdgeOut(
            source_media_id=row.source_id,
            target_media_id=row.target_id,
            kind=row.kind,
            origin=row.origin,
        )
        for row in edge_rows
    ]

    response.headers["ETag"] = f'"{etag}"'
    return ok(AtlasOut(stars=stars, constellations=constellations, edges=edges))


@router.get("/status")
def read_atlas_status(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Projection coverage for the "chart is computing" UI state."""
    row = db.execute(
        text(
            """
            SELECT
                (SELECT max(p.projection_version)
                   FROM media_atlas_positions p
                   JOIN library_entries le ON le.media_id = p.media_id
                   JOIN libraries l ON l.id = le.library_id
                   WHERE l.owner_user_id = :user_id) AS projection_version,
                (SELECT count(DISTINCT v.media_id) FROM (
                    SELECT le.media_id FROM library_entries le
                    JOIN libraries l ON l.id = le.library_id
                    WHERE l.owner_user_id = :user_id AND le.media_id IS NOT NULL
                 ) v) AS total_count,
                (SELECT count(DISTINCT p.media_id)
                   FROM media_atlas_positions p
                   JOIN library_entries le ON le.media_id = p.media_id
                   JOIN libraries l ON l.id = le.library_id
                   WHERE l.owner_user_id = :user_id) AS positioned_count,
                (SELECT max(p.computed_at)
                   FROM media_atlas_positions p
                   JOIN library_entries le ON le.media_id = p.media_id
                   JOIN libraries l ON l.id = le.library_id
                   WHERE l.owner_user_id = :user_id) AS last_run
            """
        ),
        {"user_id": viewer.user_id},
    ).one()
    total = int(row.total_count or 0)
    positioned = int(row.positioned_count or 0)
    return ok(
        AtlasStatusOut(
            projection_version=row.projection_version,
            positioned_count=positioned,
            total_count=total,
            stale_count=max(0, total - positioned),
            last_run=row.last_run.isoformat() if row.last_run is not None else None,
        )
    )


@router.post("/project", status_code=202)
def request_projection(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Enqueue an on-demand projection for the requesting user (202)."""
    queued = try_enqueue_atlas_project(db, user_id=viewer.user_id, force=True)
    db.commit()
    return {"queued": queued}
