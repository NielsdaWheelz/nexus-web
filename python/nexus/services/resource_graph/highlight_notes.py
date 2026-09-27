"""Highlight ↔ note projections over ``origin='highlight_note'`` edges."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_readability_filter
from nexus.db.models import Highlight, NoteBlock, ResourceEdge


def linked_note_blocks_for_highlights(
    db: Session, viewer_id: UUID, highlight_ids: list[UUID]
) -> dict[UUID, list[NoteBlock]]:
    """Attached notes per highlight, ordered by canonical attachment creation."""
    if not highlight_ids:
        return {}
    rows = db.execute(
        select(ResourceEdge.source_id, NoteBlock)
        .join(
            NoteBlock,
            (ResourceEdge.target_scheme == "note_block") & (ResourceEdge.target_id == NoteBlock.id),
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
            NoteBlock.created_at.asc(),
            ResourceEdge.created_at.asc(),
            ResourceEdge.id.asc(),
        )
    ).all()
    result: dict[UUID, list[NoteBlock]] = {}
    for highlight_id, block in rows:
        result.setdefault(highlight_id, []).append(block)
    return result


def note_blocks_for_highlight(db: Session, viewer_id: UUID, highlight_id: UUID) -> list[NoteBlock]:
    """All attached notes for one highlight, oldest attachment first."""
    return list(
        db.scalars(
            select(NoteBlock)
            .join(
                ResourceEdge,
                (ResourceEdge.target_scheme == "note_block")
                & (ResourceEdge.target_id == NoteBlock.id),
            )
            .where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                ResourceEdge.source_scheme == "highlight",
                ResourceEdge.source_id == highlight_id,
                NoteBlock.user_id == viewer_id,
            )
            .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc(), NoteBlock.id.asc())
        )
    )


def first_note_block_for_highlight(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> NoteBlock | None:
    blocks = note_blocks_for_highlight(db, viewer_id, highlight_id)
    return blocks[0] if blocks else None


def note_block_ids_with_highlight_notes(
    db: Session, viewer_id: UUID, block_ids: list[UUID]
) -> set[UUID]:
    """Which of the given note blocks are attached to a highlight."""
    if not block_ids:
        return set()
    return set(
        db.scalars(
            select(ResourceEdge.target_id).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                ResourceEdge.target_scheme == "note_block",
                ResourceEdge.target_id.in_(block_ids),
            )
        )
    )


def highlight_excerpts_for_note_blocks(
    db: Session, viewer_id: UUID, note_ids: list[UUID]
) -> dict[UUID, str]:
    """The first attached highlight's exact text per note block."""
    if not note_ids:
        return {}
    excerpts: dict[UUID, str] = {}
    for note_id, exact in db.execute(
        select(ResourceEdge.target_id, Highlight.exact)
        .join(
            Highlight,
            (ResourceEdge.source_scheme == "highlight") & (Highlight.id == ResourceEdge.source_id),
        )
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "highlight_note",
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id.in_(note_ids),
            highlight_readability_filter(viewer_id),
        )
        .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
    ):
        excerpts.setdefault(note_id, str(exact or ""))
    return excerpts
