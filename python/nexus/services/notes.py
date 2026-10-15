"""Pages, the daily page, quick capture and the note attached to a highlight.

A daily page is bound to its date (I6: one page per date, one date per page); a date's
page id is ``daily_page_id`` (uuid5 of viewer and date), so a latent day already knows
the id its first write creates. Reading a day writes nothing.

Retry rules: ``create_page`` by its client id (same owner: the existing page; another
owner: 409); ``write_title`` absolute with an expected version (current == desired
succeeds); ``delete_page`` and ``detach_highlight_note`` are idempotent;
``ensure_daily_page`` by date; ``capture`` by its client note id (an existing note of
the viewer has landed); ``attach_highlight_note`` by its client note id (that note
already attached has landed). Page delete and detach keep the notes.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, NoteBlock, Page, ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.collection_page import CollectionPage, parse_collection_query
from nexus.schemas.notes import DailyPageOut, NoteBlockOut, NotePageSummaryOut
from nexus.services import note_bodies
from nexus.services.collection_keyset import UPDATED_TITLE_PLANS, keyset_page
from nexus.services.highlights import get_highlight_for_visible_read_or_404
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.cleanup import (
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.highlight_notes import note_blocks_for_highlight
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items import versions
from nexus.services.suggestion_changes import record_input_change

_DAILY = uuid5(NAMESPACE_URL, "nexus:daily-page")


@dataclass(frozen=True, slots=True)
class PageFacts:
    title: str
    daily_date: date | None


@dataclass(frozen=True, slots=True)
class RecentNoteAnchorFact:
    ref: ResourceRef
    activity_at: datetime


def page_ref(page_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="page", id=page_id)


def list_pages(
    db: Session, viewer_id: UUID, items: Sequence[tuple[str, str]]
) -> CollectionPage[NotePageSummaryOut]:
    """One keyset page of the viewer's pages in an updated/title view (as the chats index)."""
    query = parse_collection_query(items, domain_keys={"sort", "direction"})
    plan = UPDATED_TITLE_PLANS.get(
        (query.parameters.get("sort"), query.parameters.get("direction"))
    )
    if plan is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported notes index view")
    rows, cursor = keyset_page(
        db,
        binding={"list": "Pages", "viewer": viewer_id},
        plan=plan,
        cursor=query.cursor,
        limit=query.limit,
        params={"viewer": viewer_id},
        sql=lambda keyset, order: f"""
            WITH facts AS (
                SELECT p.id, p.title, p.updated_at, p.title AS presented_title,
                    lower(p.title) AS title_key
                FROM pages p
                WHERE p.user_id = :viewer
            )
            SELECT * FROM facts WHERE true {keyset}
            ORDER BY {order}
            LIMIT :limit
        """,
    )
    return CollectionPage[NotePageSummaryOut](
        items=[
            NotePageSummaryOut(id=row["id"], title=row["title"], updated_at=row["updated_at"])
            for row in rows
        ],
        next_cursor=cursor,
    )


def create_page(db: Session, viewer_id: UUID, page_id: UUID, title: str) -> NotePageSummaryOut:
    def op() -> NotePageSummaryOut:
        page = db.get(Page, page_id)
        created = page is None
        if page is None:
            page = _new_page(db, viewer_id, page_id, title)
        elif page.user_id != viewer_id:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Page id is taken")
        out = NotePageSummaryOut(id=page.id, title=page.title, updated_at=page.updated_at)
        if created:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "create_page", op)


def write_title(
    db: Session, *, viewer_id: UUID, page_id: UUID, title: str, expected_version: int
) -> None:
    """409 E_RESOURCE_CONFLICT with ``details.current`` {title, title_version} when stale."""
    page = _owned_page(db, viewer_id, page_id)
    if page.title == title:
        return
    ref = page_ref(page_id)
    current = versions.ensure_version(db, viewer_id=viewer_id, ref=ref, lane="title").version
    if current != expected_version:
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT,
            "Page title changed elsewhere",
            details={"current": {"title": page.title, "title_version": current}},
        )
    page.title = title
    page.updated_at = func.now()
    versions.bump_version(db, viewer_id=viewer_id, ref=ref, lane="title")


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    """The page, its links, binding and dossier state; its notes stay."""
    from nexus.services.dossier import engine as dossier_engine

    def op() -> None:
        page = db.get(Page, page_id)
        if page is not None and page.user_id == viewer_id:
            ref = page_ref(page_id)
            dossier_engine.on_subject_deleted(db, ref)
            delete_edges_for_deleted_resource(db, ref=ref)
            db.execute(delete(DailyPageBinding).where(DailyPageBinding.page_id == page_id))
            delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
            db.delete(page)
            record_input_change(db)
        db.commit()

    retry_serializable(db, "delete_page", op)


def page_facts(db: Session, viewer_id: UUID, page_ids: Sequence[UUID]) -> dict[UUID, PageFacts]:
    rows = db.execute(
        select(Page.id, Page.title, DailyPageBinding.local_date)
        .outerjoin(DailyPageBinding, DailyPageBinding.page_id == Page.id)
        .where(Page.user_id == viewer_id, Page.id.in_(page_ids))
    )
    return {row.id: PageFacts(title=row.title, daily_date=row.local_date) for row in rows}


def read_daily_page(db: Session, viewer_id: UUID, local_date: date) -> DailyPageOut:
    from nexus.services import outline

    page_id = _bound_page_id(db, viewer_id, local_date)
    if page_id is not None:
        out = outline.read(db, viewer_id=viewer_id, ref=page_ref(page_id))
        return DailyPageOut(local_date=local_date, materialized=True, outline=out)
    latent = outline.latent_daily_outline(
        page_id=daily_page_id(viewer_id, local_date),
        local_date=local_date,
        title=_daily_title(local_date),
    )
    return DailyPageOut(local_date=local_date, materialized=False, outline=latent)


def daily_page_id(viewer_id: UUID, local_date: date) -> UUID:
    return uuid5(_DAILY, f"{viewer_id}:{local_date.isoformat()}")


def ensure_daily_page(db: Session, viewer_id: UUID, local_date: date) -> ResourceRef:
    """The date's page, created with its binding on first use."""
    page_id = _bound_page_id(db, viewer_id, local_date)
    if page_id is None:
        page_id = daily_page_id(viewer_id, local_date)
        _new_page(db, viewer_id, page_id, _daily_title(local_date))
        db.add(DailyPageBinding(user_id=viewer_id, local_date=local_date, page_id=page_id))
        db.flush()
    return page_ref(page_id)


def capture(db: Session, viewer_id: UUID, *, local_date: date, note_id: UUID, text: str) -> UUID:
    """Append the text as one note at the end of the date's page; returns the page id."""

    def op() -> UUID:
        body = note_bodies.pm_doc_from_markdown_projection(text)
        page_id = capture_in_current_transaction(
            db, viewer_id, local_date=local_date, note_id=note_id, body_pm_json=body
        )
        record_input_change(db)
        db.commit()
        return page_id

    return retry_serializable(db, "daily_capture", op)


def capture_in_current_transaction(
    db: Session, viewer_id: UUID, *, local_date: date, note_id: UUID, body_pm_json: dict[str, Any]
) -> UUID:
    if not note_bodies.text_from_pm_json(body_pm_json).strip():
        raise InvalidRequestError(ApiErrorCode.E_EMPTY_NOTE_BODY, "A capture needs text")
    page = ensure_daily_page(db, viewer_id, local_date)
    if not note_bodies.note_exists(db, viewer_id=viewer_id, note_id=note_id):
        append_note_in_current_transaction(
            db, viewer_id, page_id=page.id, note_id=note_id, body_pm_json=body_pm_json
        )
    return page.id


def append_note_in_current_transaction(
    db: Session, viewer_id: UUID, *, page_id: UUID, note_id: UUID, body_pm_json: dict[str, Any]
) -> None:
    """Create the note (or reuse an own one) and link it last on the page."""
    from nexus.services import outline

    page = page_ref(_owned_page(db, viewer_id, page_id).id)
    note_bodies.ensure_note(
        db, viewer_id=viewer_id, note_id=note_id, body_pm_json=body_pm_json, reason="capture"
    )
    after = outline.last_link_id(db, viewer_id, page)
    outline.link(db, viewer_id, page, note_bodies.note_ref(note_id), uuid4(), after)


def attach_highlight_note(
    db: Session, viewer_id: UUID, *, highlight_id: UUID, note_id: UUID, body_pm_json: dict[str, Any]
) -> NoteBlockOut:
    def op() -> NoteBlockOut:
        attach_highlight_note_in_current_transaction(
            db, viewer_id, highlight_id=highlight_id, note_id=note_id, body_pm_json=body_pm_json
        )
        out = note_bodies.read_note(db, viewer_id=viewer_id, note_id=note_id)
        record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "attach_highlight_note", op)


def attach_highlight_note_in_current_transaction(
    db: Session, viewer_id: UUID, *, highlight_id: UUID, note_id: UUID, body_pm_json: dict[str, Any]
) -> None:
    """Create the highlight's one note and attach it; another note attached is 409."""
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    attached = [block.id for block in note_blocks_for_highlight(db, viewer_id, highlight_id)]
    if note_id in attached:
        return
    if attached or note_bodies.note_exists(db, viewer_id=viewer_id, note_id=note_id):
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight already has a note")
    note_bodies.ensure_note(
        db, viewer_id=viewer_id, note_id=note_id, body_pm_json=body_pm_json, reason="highlight_note"
    )
    edges.create_edge(
        db,
        viewer_id=viewer_id,
        input=edges.EdgeCreate(
            source=ResourceRef(scheme="highlight", id=highlight_id),
            target=note_bodies.note_ref(note_id),
            kind="context",
            origin="highlight_note",
        ),
    )


def detach_highlight_note(
    db: Session, viewer_id: UUID, *, highlight_id: UUID, note_id: UUID
) -> None:
    """Delete the attachment edge only; a missing one is already detached."""

    def op() -> None:
        get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
        db.execute(
            delete(ResourceEdge).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                edges.source_is(ResourceRef(scheme="highlight", id=highlight_id)),
                edges.target_is(note_bodies.note_ref(note_id)),
            )
        )
        record_input_change(db)
        db.commit()

    retry_serializable(db, "detach_highlight_note", op)


def count_retained_note_blocks(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Surviving viewer-owned note blocks by creation time."""
    query = select(func.count()).where(NoteBlock.user_id == viewer_id, NoteBlock.created_at < end)
    if start is not None:
        query = query.where(NoteBlock.created_at >= start)
    return int(db.scalar(query) or 0)


def recent_note_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[RecentNoteAnchorFact, ...]:
    """Recent note-block and page edits, each source capped at ``limit``."""
    if limit < 1:
        return ()
    rows = db.execute(
        text(
            """
            (SELECT 'note_block' AS scheme, id, updated_at FROM note_blocks
             WHERE user_id = :viewer ORDER BY updated_at DESC, id LIMIT :limit)
            UNION ALL
            (SELECT 'page' AS scheme, id, updated_at FROM pages
             WHERE user_id = :viewer ORDER BY updated_at DESC, id LIMIT :limit)
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


def _new_page(db: Session, viewer_id: UUID, page_id: UUID, title: str) -> Page:
    page = Page(id=page_id, user_id=viewer_id, title=title)
    db.add(page)
    db.flush()
    for lane in ("title", "links"):
        versions.ensure_version(db, viewer_id=viewer_id, ref=page_ref(page_id), lane=lane)
    db.refresh(page)
    return page


def _owned_page(db: Session, viewer_id: UUID, page_id: UUID) -> Page:
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    return page


def _bound_page_id(db: Session, viewer_id: UUID, local_date: date) -> UUID | None:
    return db.scalar(
        select(DailyPageBinding.page_id).where(
            DailyPageBinding.user_id == viewer_id, DailyPageBinding.local_date == local_date
        )
    )


def _daily_title(local_date: date) -> str:
    return f"{local_date.strftime('%B')} {local_date.day}, {local_date.year}"
