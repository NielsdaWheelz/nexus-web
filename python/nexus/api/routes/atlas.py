"""Grand atlas read model + on-demand projection trigger (grand-atlas §6).

- GET  /atlas          the celestial chart read model, ETag-cacheable
- GET  /atlas/status   projection coverage for the "chart is computing" UI
- POST /atlas/project  enqueue an atlas_project_job for the requesting user

The route builds the read model with user-scoped queries; the spatial
substrate and projection live in ``services/atlas_projection.py``.

Every query below is scoped to the viewer's personal Default virtual
relation (spec S4.1, ``library_entries.library_media_ids_cte_sql``): every
media id reachable through any of the viewer's CURRENT non-system
memberships. This keeps Oracle's system-only works out of Atlas even when
the viewer holds a system-library membership (AC2), while a shared
non-default library the viewer merely belongs to (not owns) still
contributes its media, both to the flat star list and to its own
constellation.
"""

from __future__ import annotations

import hashlib
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.permissions import visible_media_ids_cte_sql
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
from nexus.services.library_entries import library_media_ids_cte_sql

router = APIRouter(prefix="/atlas", tags=["atlas"])

# The viewer's personal Default virtual media set (AC2). Binds :viewer_id and
# :library_id (the viewer's own Default library id, always available on
# ``Viewer`` — no extra round trip needed).
_PERSONAL_MEDIA_SQL = library_media_ids_cte_sql()


def _personal_media_params(viewer: Viewer) -> dict[str, UUID]:
    return {"viewer_id": viewer.user_id, "library_id": viewer.default_library_id}


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
    params = _personal_media_params(viewer)

    star_rows = db.execute(
        text(
            f"""
            SELECT m.id AS media_id, m.title, m.kind,
                   p.x, p.y, p.computed_at,
                   COUNT(DISTINCT h.id) AS magnitude
            FROM media m
            JOIN ({_PERSONAL_MEDIA_SQL}) v ON v.media_id = m.id
            LEFT JOIN media_atlas_positions p ON p.media_id = m.id
            LEFT JOIN highlights h
                   ON h.anchor_media_id = m.id AND h.user_id = :viewer_id
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

    # Constellations are per-library groupings, so unlike the flattened star
    # list this covers every non-system library the viewer belongs to (owned
    # or merely joined). The viewer's own Default row reuses the star media
    # ids directly (they are, by construction, the same relation) instead of
    # re-querying it. Every other membership is resolved by one grouped query
    # over the same visible-media relation `library_media_ids_cte_sql` uses
    # for its non-default branch, minus the single-library filter, instead of
    # issuing one query per membership.
    constellation_lib_rows = db.execute(
        text(
            """
            SELECT l.id AS library_id, l.name, l.is_default
            FROM libraries l
            JOIN memberships m ON m.library_id = l.id
            WHERE m.user_id = :viewer_id AND l.system_key IS NULL
            """
        ),
        params,
    ).all()
    default_media_ids = [row.media_id for row in star_rows]
    non_default_rows = db.execute(
        text(
            f"""
            SELECT le.library_id, array_agg(DISTINCT le.media_id) AS media_ids
            FROM library_entries le
            JOIN libraries l ON l.id = le.library_id
            JOIN memberships m ON m.library_id = l.id AND m.user_id = :viewer_id
            WHERE l.is_default = false
              AND l.system_key IS NULL
              AND le.media_id IS NOT NULL
              AND le.media_id IN ({visible_media_ids_cte_sql()})
            GROUP BY le.library_id
            """
        ),
        params,
    ).all()
    non_default_media_ids_by_library = {
        row.library_id: list(row.media_ids) for row in non_default_rows
    }
    constellations: list[ConstellationOut] = []
    for lib_row in constellation_lib_rows:
        if bool(lib_row.is_default):
            member_media_ids = default_media_ids
        else:
            member_media_ids = non_default_media_ids_by_library.get(lib_row.library_id, [])
        if not member_media_ids:
            continue
        constellations.append(
            ConstellationOut(
                library_id=lib_row.library_id,
                name=lib_row.name,
                member_media_ids=member_media_ids,
            )
        )

    edge_rows = db.execute(
        text(
            f"""
            SELECT re.source_id, re.target_id, re.kind, re.origin
            FROM resource_edges re
            WHERE re.user_id = :viewer_id
              AND re.source_scheme = 'media'
              AND re.target_scheme = 'media'
              AND (
                  (re.origin = 'synapse' AND re.kind = 'context')
                  OR re.kind = 'contradicts'
              )
              AND re.source_id IN ({_PERSONAL_MEDIA_SQL})
              AND re.target_id IN ({_PERSONAL_MEDIA_SQL})
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
            f"""
            SELECT
                (SELECT max(p.projection_version)
                   FROM media_atlas_positions p
                   JOIN ({_PERSONAL_MEDIA_SQL}) v ON v.media_id = p.media_id) AS projection_version,
                (SELECT count(DISTINCT v.media_id)
                   FROM ({_PERSONAL_MEDIA_SQL}) v) AS total_count,
                (SELECT count(DISTINCT p.media_id)
                   FROM media_atlas_positions p
                   JOIN ({_PERSONAL_MEDIA_SQL}) v ON v.media_id = p.media_id) AS positioned_count,
                (SELECT max(p.computed_at)
                   FROM media_atlas_positions p
                   JOIN ({_PERSONAL_MEDIA_SQL}) v ON v.media_id = p.media_id) AS last_run
            """
        ),
        _personal_media_params(viewer),
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
