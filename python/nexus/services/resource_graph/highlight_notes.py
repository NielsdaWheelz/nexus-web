"""Highlight ↔ note projections over the viewer's ``origin='highlight_note'`` edges."""

from uuid import UUID

from sqlalchemy import ColumnElement, select
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_readability_filter
from nexus.db.models import Highlight, NoteBlock, ResourceEdge


def _attachments(viewer_id: UUID) -> list[ColumnElement[bool]]:
    return [
        ResourceEdge.user_id == viewer_id,
        ResourceEdge.origin == "highlight_note",
        ResourceEdge.source_scheme == "highlight",
        ResourceEdge.target_scheme == "note_block",
    ]


def linked_note_blocks_for_highlights(
    db: Session, viewer_id: UUID, highlight_ids: list[UUID]
) -> dict[UUID, list[NoteBlock]]:
    """Attached notes per highlight, ordered by note creation, then attachment."""
    if not highlight_ids:
        return {}
    rows = db.execute(
        select(ResourceEdge.source_id, NoteBlock)
        .join(NoteBlock, ResourceEdge.target_id == NoteBlock.id)
        .where(
            *_attachments(viewer_id),
            ResourceEdge.source_id.in_(highlight_ids),
            NoteBlock.user_id == viewer_id,
        )
        .order_by(
            ResourceEdge.source_id, NoteBlock.created_at, ResourceEdge.created_at, ResourceEdge.id
        )
    ).all()
    result: dict[UUID, list[NoteBlock]] = {}
    for highlight_id, block in rows:
        result.setdefault(highlight_id, []).append(block)
    return result


def note_blocks_for_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> list[NoteBlock]:
    """All attached notes of one highlight, oldest attachment first."""
    return list(
        db.scalars(
            select(NoteBlock)
            .join(ResourceEdge, ResourceEdge.target_id == NoteBlock.id)
            .where(
                *_attachments(viewer_id),
                ResourceEdge.source_id == highlight_id,
                NoteBlock.user_id == viewer_id,
            )
            .order_by(ResourceEdge.created_at, ResourceEdge.id, NoteBlock.id)
        )
    )


def highlight_excerpts_for_note_blocks(
    db: Session, viewer_id: UUID, note_ids: list[UUID]
) -> dict[UUID, str]:
    """The first readable attached highlight's exact text per note block."""
    if not note_ids:
        return {}
    excerpts: dict[UUID, str] = {}
    for note_id, exact in db.execute(
        select(ResourceEdge.target_id, Highlight.exact)
        .join(Highlight, Highlight.id == ResourceEdge.source_id)
        .where(
            *_attachments(viewer_id),
            ResourceEdge.target_id.in_(note_ids),
            highlight_readability_filter(viewer_id),
        )
        .order_by(ResourceEdge.created_at, ResourceEdge.id)
    ):
        excerpts.setdefault(note_id, str(exact or ""))
    return excerpts
