"""Markdown rendering of note blocks for prompt and object-ref contexts."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import NOTE_BLOCK_SIBLING_ORDER, NoteBlock


def ordered_note_blocks_for_page(db: Session, page_id: UUID) -> list[NoteBlock]:
    return list(
        db.scalars(
            select(NoteBlock)
            .where(NoteBlock.page_id == page_id)
            .order_by(
                NoteBlock.parent_block_id.asc().nullsfirst(),
                *NOTE_BLOCK_SIBLING_ORDER,
            )
        )
    )


def note_outline_markdown(
    blocks: list[NoteBlock],
    parent_id: UUID | None,
    *,
    root_block: NoteBlock | None = None,
) -> str:
    blocks_by_parent: dict[UUID | None, list[NoteBlock]] = {}
    for block in blocks:
        blocks_by_parent.setdefault(block.parent_block_id, []).append(block)

    lines: list[str] = []

    def visit(block: NoteBlock, depth: int) -> None:
        lines.append(note_block_markdown(block, depth))
        for child in blocks_by_parent.get(block.id, []):
            visit(child, depth + 1)

    if root_block is not None:
        visit(root_block, 0)
    else:
        for block in blocks_by_parent.get(parent_id, []):
            visit(block, 0)

    return "\n".join(lines).strip()


def note_block_markdown(block: NoteBlock, depth: int) -> str:
    indent = "  " * depth
    text_value = (block.body_markdown or block.body_text or "").strip()
    lines = text_value.splitlines() or [""]
    if block.block_kind == "heading":
        level = min(depth + 1, 6)
        rendered = [f"{indent}{'#' * level} {lines[0]}".rstrip()]
        rendered.extend(f"{indent}{line}".rstrip() for line in lines[1:])
        return "\n".join(rendered)
    if block.block_kind == "todo":
        rendered = [f"{indent}- [ ] {lines[0]}".rstrip()]
        rendered.extend(f"{indent}  {line}".rstrip() for line in lines[1:])
        return "\n".join(rendered)
    if block.block_kind == "quote":
        return "\n".join(f"{indent}> {line}".rstrip() for line in lines)
    if block.block_kind == "code":
        return "\n".join([f"{indent}```", *[f"{indent}{line}" for line in lines], f"{indent}```"])
    rendered = [f"{indent}- {lines[0]}".rstrip()]
    rendered.extend(f"{indent}  {line}".rstrip() for line in lines[1:])
    return "\n".join(rendered)
