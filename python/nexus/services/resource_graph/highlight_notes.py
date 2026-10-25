"""Highlight ↔ note adjacency over the viewer's live authored links.

Any live authored link between a highlight and a note attaches that note: there is no
singleton annotation slot and no attachment origin. A highlight lists its notes in its
own endpoint order (fractional position, byte-ordered, then link id); a note's excerpt
is its first readable highlight in the note's endpoint order.
"""

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_readability_sql
from nexus.db.models import NoteBlock
from nexus.services.resource_graph.liveness import AUTHORED_LINK_ORIGINS, edge_live_sql

# (link, the endpoint ordering it, its far end, that endpoint's position); a link may
# store either direction. Callers order by ``_ORDER``.
_ADJACENT = f"""
    SELECT e.id AS link_id,
        CASE WHEN e.source_scheme = :near THEN e.source_id ELSE e.target_id END AS near_id,
        CASE WHEN e.source_scheme = :near THEN e.target_id ELSE e.source_id END AS far_id,
        (SELECT place.order_key FROM resource_view_states place
         WHERE place.edge_id = e.id AND place.user_id = :viewer_id
           AND place.surface_scheme = :near
           AND place.surface_id = CASE WHEN e.source_scheme = :near
               THEN e.source_id ELSE e.target_id END) AS position_key
    FROM resource_edges e
    WHERE e.user_id = :viewer_id AND e.origin = ANY(:origins) AND {edge_live_sql("e")}
      AND ((e.source_scheme = :near AND e.source_id = ANY(:ids) AND e.target_scheme = :far)
        OR (e.target_scheme = :near AND e.target_id = ANY(:ids) AND e.source_scheme = :far))
"""
_ORDER = 'adjacent.near_id, adjacent.position_key COLLATE "C" NULLS LAST, adjacent.link_id'


def linked_note_blocks_for_highlights(
    db: Session, viewer_id: UUID, highlight_ids: list[UUID]
) -> dict[UUID, list[tuple[UUID, NoteBlock]]]:
    """Each highlight's attached visible notes with their link ids, in highlight order."""
    if not highlight_ids:
        return {}
    rows = db.execute(
        text(f"SELECT * FROM ({_ADJACENT}) adjacent ORDER BY {_ORDER}"),
        {
            "viewer_id": viewer_id,
            "origins": list(AUTHORED_LINK_ORIGINS),
            "near": "highlight",
            "far": "note_block",
            "ids": highlight_ids,
        },
    ).all()
    notes = {
        note.id: note
        for note in db.scalars(
            select(NoteBlock).where(
                NoteBlock.id.in_([row.far_id for row in rows]), NoteBlock.user_id == viewer_id
            )
        )
    }
    result: dict[UUID, list[tuple[UUID, NoteBlock]]] = {}
    for row in rows:
        note = notes.get(row.far_id)
        if note is not None:
            result.setdefault(row.near_id, []).append((row.link_id, note))
    return result


def highlight_excerpts_for_note_blocks(
    db: Session, viewer_id: UUID, note_ids: list[UUID]
) -> dict[UUID, str]:
    """The first readable attached highlight's exact text per note, in note order."""
    if not note_ids:
        return {}
    excerpts: dict[UUID, str] = {}
    for row in db.execute(
        text(f"""
            SELECT adjacent.near_id, h.exact FROM ({_ADJACENT}) adjacent
            JOIN highlights h ON h.id = adjacent.far_id AND {highlight_readability_sql("h")}
            ORDER BY {_ORDER}
        """),
        {
            "viewer_id": viewer_id,
            "origins": list(AUTHORED_LINK_ORIGINS),
            "near": "note_block",
            "far": "highlight",
            "ids": note_ids,
        },
    ):
        excerpts.setdefault(row.near_id, str(row.exact or ""))
    return excerpts
