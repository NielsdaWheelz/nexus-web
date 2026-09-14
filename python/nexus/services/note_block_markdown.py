"""Markdown snippets derived from intrinsic note/page fields."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page


def page_outline_markdown(db: Session, *, viewer_id: UUID, page_id: UUID) -> str:
    title = db.scalar(select(Page.title).where(Page.id == page_id, Page.user_id == viewer_id))
    return title or ""


def note_block_outline_markdown(db: Session, *, viewer_id: UUID, block_id: UUID) -> str:
    body = db.scalar(
        select(NoteBlock.body_text).where(NoteBlock.id == block_id, NoteBlock.user_id == viewer_id)
    )
    return body or ""


def note_block_markdown(block: NoteBlock, depth: int = 0) -> str:
    indent = "  " * depth
    return "\n".join(f"{indent}{line}".rstrip() for line in (block.body_text or "").splitlines())
