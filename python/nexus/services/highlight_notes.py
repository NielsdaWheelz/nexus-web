"""Highlight-linked note projections."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, aliased

from nexus.db.models import NoteBlock, ResourceEdge


def linked_note_blocks_for_highlights(
    db: Session,
    viewer_id: UUID,
    highlight_ids: list[UUID],
) -> dict[UUID, list[NoteBlock]]:
    """Attached notes per highlight: ``origin=highlight_note`` edges."""

    if not highlight_ids:
        return {}
    containment = aliased(ResourceEdge)
    rows = db.execute(
        select(ResourceEdge.source_id, NoteBlock)
        .join(
            NoteBlock,
            (ResourceEdge.target_scheme == "note_block") & (ResourceEdge.target_id == NoteBlock.id),
        )
        .outerjoin(
            containment,
            (containment.user_id == ResourceEdge.user_id)
            & (containment.origin == "note_containment")
            & (containment.target_scheme == "note_block")
            & (containment.target_id == NoteBlock.id),
        )
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "highlight_note",
            ResourceEdge.source_scheme == "highlight",
            ResourceEdge.source_id.in_(highlight_ids),
            NoteBlock.user_id == viewer_id,
        )
        .order_by(
            ResourceEdge.source_id.asc(),
            containment.source_order_key.asc().nulls_last(),
            NoteBlock.created_at.asc(),
            ResourceEdge.created_at.asc(),
            ResourceEdge.id.asc(),
        )
    ).all()
    result: dict[UUID, list[NoteBlock]] = {}
    for highlight_id, block in rows:
        result.setdefault(highlight_id, []).append(block)
    return result
