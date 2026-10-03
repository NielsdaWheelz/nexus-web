"""Grand atlas read model (grand-atlas §6).

- GET  /atlas          the celestial chart read model, ETag-cacheable

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

from fastapi import APIRouter, Depends, Header, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.session import get_db
from nexus.responses import Data
from nexus.schemas.atlas import (
    AtlasEdgeOut,
    AtlasOut,
    ConstellationOut,
    StarOut,
)
from nexus.services.library_entries import library_media_ids_cte_sql

router = APIRouter(prefix="/atlas", tags=["atlas"])

# The viewer's personal Default virtual media set (AC2). Binds :viewer_id and
# :library_id (the viewer's own Default library id, always available on
# ``Viewer`` — no extra round trip needed).
_PERSONAL_MEDIA_SQL = library_media_ids_cte_sql()


@router.get("", response_model=Data[AtlasOut], responses={304: {"description": "not modified"}})
def read_atlas(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
) -> Response:
    """return the scoped atlas; its tag identifies the exact rendered representation."""
    params = {"viewer_id": viewer.user_id, "library_id": viewer.default_library_id}

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
                # The viewer's own Default constellation presents as "All".
                name="All" if bool(lib_row.is_default) else lib_row.name,
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

    representation = Data(data=AtlasOut(stars=stars, constellations=constellations, edges=edges))
    # one conditional http owner renders once; preserve standard-json float bytes.
    response = JSONResponse(content=representation.model_dump(mode="json", by_alias=True))
    etag = hashlib.sha256(response.body).hexdigest()
    headers = {"ETag": f'"{etag}"'}
    if if_none_match is not None and if_none_match.strip('"') == etag:
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return response
