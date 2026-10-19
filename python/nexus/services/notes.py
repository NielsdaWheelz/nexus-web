"""Pages, the daily page, quick capture and the note attached to a highlight.

A daily date is a read-only locator. A latent outline proposes a fresh uuid; its
first item creates that exact page and binding atomically. Reads write nothing.

Retry rules: ``create_page`` by its client id (same owner: the existing page before
resolving its first item; another owner: 409); ``write_title`` absolute with an
expected version (current == desired succeeds); page delete and highlight detach
are idempotent. ``ensure_daily_page`` requires the proposed page id to match any
live binding. Capture replays require the existing note's live date placement;
a removed placement conflicts without creating a replacement day. Highlight note
creation reuses the same attached note id;
otherwise its loaded empty-slot version must match. Edits require the exact current
attachment and the note body version. Page delete and detach keep the notes;
``delete_highlight_note`` deletes the note globally and is idempotent when absent.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, Highlight, NoteBlock, Page, ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.collection_page import CollectionPage, parse_collection_query
from nexus.schemas.highlights import HighlightNoteExpected
from nexus.schemas.notes import (
    DailyPageOut,
    InitialItem,
    InsertLink,
    InsertNote,
    NoteBlockOut,
    NotePageSummaryOut,
)
from nexus.schemas.resource_graph import LinkResourceEndpoint
from nexus.services import note_bodies
from nexus.services.collection_keyset import UPDATED_TITLE_PLANS, keyset_page
from nexus.services.highlights import get_highlight_for_visible_read_or_404
from nexus.services.resource_graph import edges, retention
from nexus.services.resource_graph.cleanup import (
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.highlight_notes import note_blocks_for_highlight
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_items import versions
from nexus.services.suggestion_changes import record_input_change


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


def create_page(
    db: Session, viewer_id: UUID, page_id: UUID, title: str, initial_item: InitialItem
) -> NotePageSummaryOut:
    """Publish a page and its first real item together; owned-id replays return current."""
    from nexus.services import outline

    def op() -> NotePageSummaryOut:
        page = db.get(Page, page_id)
        if page is not None:
            if page.user_id != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Page id is taken")
        else:
            if db.get(ResourceEdge, initial_item.link_id) is not None:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Initial link id is taken")
            if initial_item.kind == "note" and retention.canonical_blank(initial_item.body_pm_json):
                raise InvalidRequestError(
                    ApiErrorCode.E_EMPTY_NOTE_BODY, "A page needs a real item"
                )
            if initial_item.kind == "note" and db.get(NoteBlock, initial_item.note_id) is not None:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Initial note id is taken")
            page = _new_page(db, viewer_id, page_id, title)
            source = LinkResourceEndpoint(ref=page_ref(page_id).uri)
            command = (
                InsertNote(
                    kind="insert_note",
                    source=source,
                    link_id=initial_item.link_id,
                    note_id=initial_item.note_id,
                    body_pm_json=initial_item.body_pm_json,
                    position=None,
                )
                if initial_item.kind == "note"
                else InsertLink(
                    kind="insert_link",
                    source=source,
                    link_id=initial_item.link_id,
                    target=initial_item.target,
                    position=None,
                )
            )
            outline.execute_in_current_transaction(db, viewer_id=viewer_id, commands=[command])
        out = NotePageSummaryOut(id=page.id, title=page.title, updated_at=page.updated_at)
        db.commit()
        return out

    return retry_serializable(db, "create_page", op)


def write_title(
    db: Session, *, viewer_id: UUID, page_id: UUID, title: str, expected_version: int
) -> None:
    """409 E_RESOURCE_CONFLICT with ``details.current`` {title, title_version} when stale."""
    page = db.scalar(
        select(Page)
        .where(Page.id == page_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
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
    retention.touch_owners(db, [ref])
    versions.bump_version(db, viewer_id=viewer_id, ref=ref, lane="title")


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    """Idempotent committing wrapper; the page's notes stay."""

    def op() -> None:
        delete_page_in_current_transaction(db, viewer_id, page_id)
        db.commit()

    retry_serializable(db, "delete_page", op)


def delete_page_in_current_transaction(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    """Lock the root before its canonical teardown. Flush only; its notes stay."""
    from nexus.services.dossier import engine as dossier_engine

    page = db.scalar(
        select(Page)
        .where(Page.id == page_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if page is None or page.user_id != viewer_id:
        return
    ref = page_ref(page_id)
    dossier_engine.on_subject_deleted(db, ref)
    delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(delete(DailyPageBinding).where(DailyPageBinding.page_id == page_id))
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(page)
    record_input_change(db)
    db.flush()


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
        page_id=uuid4(),
        local_date=local_date,
        title=daily_page_title(local_date),
    )
    return DailyPageOut(local_date=local_date, materialized=False, outline=latent)


def ensure_daily_page(db: Session, viewer_id: UUID, local_date: date, page_id: UUID) -> ResourceRef:
    """Bind the proposed page id; refuse a different live incarnation. Flush only."""
    bound = _bound_page_id(db, viewer_id, local_date)
    if bound is not None:
        if bound != page_id:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT,
                "This day has a different page",
                details={"current_page_ref": page_ref(bound).uri},
            )
        _owned_page(db, viewer_id, bound)
        return page_ref(bound)
    if db.get(Page, page_id) is not None:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Page id is taken")
    _new_page(db, viewer_id, page_id, daily_page_title(local_date))
    db.add(DailyPageBinding(user_id=viewer_id, local_date=local_date, page_id=page_id))
    db.flush()
    return page_ref(page_id)


def capture(db: Session, viewer_id: UUID, *, local_date: date, note_id: UUID, text: str) -> UUID:
    """Append the text as one note at the end of the date's page; returns the page id."""

    proposed_page_id = uuid4()

    def op() -> UUID:
        body = note_bodies.pm_doc_from_markdown_projection(text)
        page_id = capture_in_current_transaction(
            db,
            viewer_id,
            local_date=local_date,
            note_id=note_id,
            body_pm_json=body,
            proposed_page_id=proposed_page_id,
        )
        db.commit()
        return page_id

    return retry_serializable(db, "daily_capture", op)


def capture_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    local_date: date,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    proposed_page_id: UUID | None = None,
) -> UUID:
    if not note_bodies.text_from_pm_json(body_pm_json).strip():
        raise InvalidRequestError(ApiErrorCode.E_EMPTY_NOTE_BODY, "A capture needs text")
    bound = _bound_page_id(db, viewer_id, local_date)
    if note_bodies.note_exists(db, viewer_id=viewer_id, note_id=note_id):
        if bound is not None and db.get(Page, bound) is not None:
            page = page_ref(bound)
            note = note_bodies.note_ref(note_id)
            placed = db.scalar(
                select(ResourceEdge.id)
                .where(
                    ResourceEdge.user_id == viewer_id,
                    ResourceEdge.origin == "user",
                    or_(
                        edges.source_is(page) & edges.target_is(note),
                        edges.source_is(note) & edges.target_is(page),
                    ),
                )
                .limit(1)
            )
            if placed is not None:
                return bound
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT, "Capture's date placement is no longer available"
        )
    page = ensure_daily_page(db, viewer_id, local_date, bound or proposed_page_id or uuid4())
    append_note_in_current_transaction(
        db, viewer_id, page_id=page.id, note_id=note_id, body_pm_json=body_pm_json
    )
    return page.id


def append_note_in_current_transaction(
    db: Session, viewer_id: UUID, *, page_id: UUID, note_id: UUID, body_pm_json: dict[str, Any]
) -> None:
    """Create/reuse the note and append it through the canonical insertion composer."""
    from nexus.services import outline

    page = page_ref(_owned_page(db, viewer_id, page_id).id)
    outline.execute_in_current_transaction(
        db,
        viewer_id=viewer_id,
        commands=[
            InsertNote(
                kind="insert_note",
                source=LinkResourceEndpoint(ref=page.uri),
                link_id=uuid4(),
                note_id=note_id,
                body_pm_json=body_pm_json,
                position=None,
            )
        ],
    )


def set_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    expected: HighlightNoteExpected,
) -> NoteBlockOut:
    def op() -> NoteBlockOut:
        if expected.kind == "absent":
            changed = attach_highlight_note_in_current_transaction(
                db,
                viewer_id,
                highlight_id=highlight_id,
                note_id=note_id,
                body_pm_json=body_pm_json,
                expected_version=expected.version,
            )
        else:
            _lock_highlight_note_source(db, viewer_id, highlight_id)
            if note_id not in {
                block.id for block in note_blocks_for_highlight(db, viewer_id, highlight_id)
            }:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight note changed")
            changed = note_bodies.write_body(
                db,
                viewer_id=viewer_id,
                note_id=note_id,
                body_pm_json=body_pm_json,
                expected_version=expected.version,
                reason="highlight_note_update",
            )
        out = note_bodies.read_note(db, viewer_id=viewer_id, note_id=note_id)
        if changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "set_highlight_note", op)


def attach_highlight_note_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    expected_version: int,
) -> bool:
    """Create in the loaded empty slot; return false when the same note is attached."""
    source = _lock_highlight_note_source(db, viewer_id, highlight_id)
    attached = [block.id for block in note_blocks_for_highlight(db, viewer_id, highlight_id)]
    if note_id in attached:
        return False
    if attached or note_bodies.note_exists(db, viewer_id=viewer_id, note_id=note_id):
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight already has a note")
    current = versions.versions_for_ref(db, viewer_id=viewer_id, ref=source).get("links", 1)
    if current != expected_version:
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT,
            "Highlight note attachment changed",
            details={"current": {"links_version": current}},
        )
    note_bodies.ensure_note(
        db, viewer_id=viewer_id, note_id=note_id, body_pm_json=body_pm_json, reason="highlight_note"
    )
    edges.create_edge(
        db,
        viewer_id=viewer_id,
        input=edges.EdgeCreate(
            source=source,
            target=note_bodies.note_ref(note_id),
            kind="context",
            origin="highlight_note",
        ),
    )
    versions.bump_version(db, viewer_id=viewer_id, ref=source, lane="links")
    return True


def _lock_highlight_note_source(db: Session, viewer_id: UUID, highlight_id: UUID) -> ResourceRef:
    """Keep the readable parent alive through an annotation mutation."""
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    locked = db.scalar(select(Highlight.id).where(Highlight.id == highlight_id).with_for_update())
    if locked is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return ResourceRef(scheme="highlight", id=highlight_id)


def detach_highlight_note(
    db: Session, viewer_id: UUID, *, highlight_id: UUID, note_id: UUID
) -> None:
    """Delete the attachment edge only; a missing one is already detached."""

    def op() -> None:
        source = _lock_highlight_note_source(db, viewer_id, highlight_id)
        edge_id = db.scalar(
            select(ResourceEdge.id).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                edges.source_is(source),
                edges.target_is(note_bodies.note_ref(note_id)),
            )
        )
        if edge_id is not None:
            edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
            record_input_change(db)
        db.commit()

    retry_serializable(db, "detach_highlight_note", op)


def delete_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_id: UUID,
    expected_version: int,
) -> None:
    """Delete the exact attached note everywhere; an already absent note stays absent."""

    def op() -> None:
        block = db.get(NoteBlock, note_id)
        if block is None:
            db.commit()
            return
        if block.user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note not found")
        _lock_highlight_note_source(db, viewer_id, highlight_id)
        if note_id not in {
            note.id for note in note_blocks_for_highlight(db, viewer_id, highlight_id)
        }:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight note changed")
        note_bodies.require_version(
            db, viewer_id=viewer_id, note_id=note_id, version=expected_version
        )
        note_bodies.delete_note(db, viewer_id=viewer_id, note_id=note_id)
        record_input_change(db)
        db.commit()

    retry_serializable(db, "delete_highlight_note", op)


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


def daily_page_title(local_date: date) -> str:
    """The date's default title, also used before its page exists."""
    return f"{local_date.strftime('%B')} {local_date.day}, {local_date.year}"
