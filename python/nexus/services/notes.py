"""Server reads of the page projection: titles, daily bindings and account facts.

Pages are projections of canonical authored state; only ``authored_visible`` rows
exist for readers. A page's stored title may be empty: a daily page then presents
its date-derived default, which is never written into the title CRDT.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import cast
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, NoteBlock, Page
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme


@dataclass(frozen=True, slots=True)
class PageFacts:
    title: str
    daily_date: date | None


@dataclass(frozen=True, slots=True)
class RecentNoteAnchorFact:
    ref: ResourceRef
    activity_at: datetime


def page_title_sql(page_alias: str) -> str:
    """SQL text: the page's presented title, its daily default when the title is empty."""
    return f"""COALESCE(NULLIF({page_alias}.title, ''), (
        SELECT to_char(title_day.local_date, 'FMMonth FMDD, YYYY')
        FROM daily_page_bindings title_day WHERE title_day.page_id = {page_alias}.id
    ), '')"""


def daily_page_title(local_date: date) -> str:
    """The date's default title, also presented before its page exists."""
    return f"{local_date.strftime('%B')} {local_date.day}, {local_date.year}"


def page_facts(db: Session, viewer_id: UUID, page_ids: Sequence[UUID]) -> dict[UUID, PageFacts]:
    rows = db.execute(
        select(Page.id, Page.title, DailyPageBinding.local_date)
        .outerjoin(DailyPageBinding, DailyPageBinding.page_id == Page.id)
        .where(Page.user_id == viewer_id, Page.id.in_(page_ids), Page.authored_visible)
    )
    return {
        row.id: PageFacts(
            title=row.title or (daily_page_title(row.local_date) if row.local_date else ""),
            daily_date=row.local_date,
        )
        for row in rows
    }


def count_retained_note_blocks(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Visible viewer-owned note blocks by creation time."""
    query = select(func.count()).where(
        NoteBlock.user_id == viewer_id, NoteBlock.authored_visible, NoteBlock.created_at < end
    )
    if start is not None:
        query = query.where(NoteBlock.created_at >= start)
    return int(db.scalar(query) or 0)


def recent_note_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[RecentNoteAnchorFact, ...]:
    """Recent visible note-block and page edits, each source capped at ``limit``."""
    if limit < 1:
        return ()
    rows = db.execute(
        text(
            """
            (SELECT 'note_block' AS scheme, id, updated_at FROM note_blocks
             WHERE user_id = :viewer AND authored_visible ORDER BY updated_at DESC, id LIMIT :limit)
            UNION ALL
            (SELECT 'page' AS scheme, id, updated_at FROM pages
             WHERE user_id = :viewer AND authored_visible ORDER BY updated_at DESC, id LIMIT :limit)
            ORDER BY updated_at DESC, scheme, id
            """
        ),
        {"viewer": viewer_id, "limit": limit},
    )
    return tuple(
        RecentNoteAnchorFact(
            ref=ResourceRef(scheme=cast(ResourceScheme, row.scheme), id=row.id),
            activity_at=row.updated_at,
        )
        for row in rows
    )
