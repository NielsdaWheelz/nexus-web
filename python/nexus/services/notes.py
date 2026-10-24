"""Pages, captured daily dates and exact annotation attachments.

Publication recognizes lifetime identities before initialization. A recognized
root never recreates missing children. Daily capture resolves its captured date
only for its first accepted note/link; the link's retained source freezes the
daily page incarnation across retries and deletion.

Absolute titles and annotation bodies require their observed versions unless
already equal. Fresh attachments carry fixed edge ids and exact loaded empty-slot
fences. Retired attachments never reattach. Detach removes only reviewed edge ids;
global deletion retires content identities before physical teardown. Shared owners
collect compact facts; each committing wrapper records real changes once, last.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, cast
from uuid import UUID, uuid4, uuid5

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, Highlight, NoteBlock, Page, ResourceEdge
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.collection_page import CollectionPage, parse_collection_query
from nexus.schemas.highlights import HighlightNoteExpected
from nexus.schemas.notes import (
    DailyPageOut,
    EnsureDaily,
    InitialItem,
    InsertLink,
    InsertNote,
    NotePageSummaryOut,
)
from nexus.schemas.resource_graph import LinkResourceEndpoint
from nexus.schemas.writing import IdentityKind, WritingAck, WritingInsertion
from nexus.services import authored_identities, note_bodies, writing
from nexus.services.collection_keyset import UPDATED_TITLE_PLANS, keyset_page
from nexus.services.highlights import get_highlight_for_visible_read_or_404
from nexus.services.resource_graph import edges, retention
from nexus.services.resource_graph.cleanup import (
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.highlight_notes import note_blocks_for_highlight
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme, require_ref
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


def page_index_rows_sql() -> str:
    """Complete owned page summaries and their updated/title order facts; binds :viewer."""
    return """
                SELECT p.id, p.title, p.updated_at, p.title AS presented_title,
                    lower(p.title) AS title_key
                FROM pages p
                WHERE p.user_id = :viewer
    """


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
                {page_index_rows_sql()}
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
) -> WritingAck:
    """Publish once; a recognized root addresses only its already bound children."""
    from nexus.services import outline

    def op() -> WritingAck:
        binding = authored_identities.recognize(db, viewer_id=viewer_id, kind="page", id=page_id)
        if binding is None:
            if initial_item.kind == "note" and retention.canonical_blank(initial_item.body_pm_json):
                raise InvalidRequestError(
                    ApiErrorCode.E_EMPTY_NOTE_BODY, "A page needs a real item"
                )
            if not _new_page(db, viewer_id, page_id, title):
                binding = authored_identities.recognize(
                    db, viewer_id=viewer_id, kind="page", id=page_id
                )
                if binding is None:
                    raise RuntimeError("Accepted page insert has no identity")
        if binding is not None:
            writing.identity(db, binding.out())
            children: list[tuple[IdentityKind, UUID]] = [("link", initial_item.link_id)]
            if initial_item.kind == "note":
                children.append(("note_block", initial_item.note_id))
            for kind, id in children:
                child = authored_identities.recognize(db, viewer_id=viewer_id, kind=kind, id=id)
                if child is None:
                    if binding.deleted:
                        continue
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT,
                        "Initialized page cannot take new initial children",
                    )
                writing.identity(db, child.out())
                if kind == "link" and not child.deleted:
                    source_ref = child.row.source_ref
                    if source_ref is None or source_ref != page_ref(page_id).uri:
                        raise ConflictError(
                            ApiErrorCode.E_RESOURCE_CONFLICT,
                            "Initial link belongs to a different page",
                        )
                    writing.effects(db).insertions[id] = WritingInsertion(
                        requested_link_id=id,
                        source_ref=source_ref,
                        canonical_link_id=child.canonical.resource_id,
                        created=child.row.canonical_identity_id is None,
                    )
        else:
            for kind, id in [("link", initial_item.link_id)] + (
                [("note_block", initial_item.note_id)] if initial_item.kind == "note" else []
            ):
                if (
                    authored_identities.recognize(
                        db, viewer_id=viewer_id, kind=cast(IdentityKind, kind), id=id
                    )
                    is not None
                ):
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "Initial child id is taken"
                    )
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
                    require_created=False,
                )
            )
            outline.apply_in_current_transaction(db, viewer_id=viewer_id, commands=[command])
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
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
    writing.effects(db).addressed.add(page_ref(page_id))
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
    writing.lane(
        db, viewer_id=viewer_id, ref=ref, name="title", before=current, checked=expected_version
    )
    page.title = title
    page.updated_at = func.now()
    retention.touch_owners(db, [ref])
    versions.bump_version(db, viewer_id=viewer_id, ref=ref, lane="title")


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> WritingAck:
    """Idempotent committing wrapper; the page's notes stay."""

    def op() -> WritingAck:
        delete_page_in_current_transaction(db, viewer_id, page_id)
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "delete_page", op)


def delete_page_in_current_transaction(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    """Lock the root before its canonical teardown. Flush only; its notes stay."""

    page = db.scalar(
        select(Page)
        .where(Page.id == page_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if page is not None and page.user_id != viewer_id:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Page id is taken")
    binding = authored_identities.retire(db, viewer_id=viewer_id, kind="page", id=page_id)
    writing.identity(db, binding.out())
    if page is None:
        return
    ref = page_ref(page_id)
    delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(delete(DailyPageBinding).where(DailyPageBinding.page_id == page_id))
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(page)
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
    if not _new_page(db, viewer_id, page_id, daily_page_title(local_date)):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Page id is taken")
    db.add(DailyPageBinding(user_id=viewer_id, local_date=local_date, page_id=page_id))
    db.flush()
    return page_ref(page_id)


def capture(
    db: Session, viewer_id: UUID, *, local_date: date, note_id: UUID, link_id: UUID, text: str
) -> WritingAck:
    proposed_page_id = uuid4()

    def op() -> WritingAck:
        capture_in_current_transaction(
            db,
            viewer_id,
            local_date=local_date,
            note_id=note_id,
            link_id=link_id,
            body_pm_json=note_bodies.pm_doc_from_markdown_projection(text),
            proposed_page_id=proposed_page_id,
        )
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "daily_capture", op)


def capture_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    local_date: date,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    proposed_page_id: UUID | None = None,
    link_id: UUID | None = None,
) -> UUID | None:
    """The accepted link source freezes the daily incarnation across every retry."""
    from nexus.services import outline

    link_id = link_id or uuid5(note_id, "daily-capture-link")
    known = authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=link_id)
    if known is not None:
        writing.identity(db, known.out())
        child = authored_identities.recognize(
            db, viewer_id=viewer_id, kind="note_block", id=note_id
        )
        if child is None:
            if not known.deleted:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT, "Capture cannot initialize a new note"
                )
        else:
            writing.identity(db, child.out())
        if known.row.source_ref is None and known.deleted:
            return None
        source = require_ref(known.row.source_ref or "")
        if source.scheme != "page":
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Capture id is not a daily placement"
            )
        page_identity = authored_identities.recognize(
            db, viewer_id=viewer_id, kind="page", id=source.id
        )
        if page_identity is not None:
            writing.identity(db, page_identity.out())
        if not known.deleted:
            state = writing.effects(db)
            state.addressed.add(source)
            state.insertions[link_id] = WritingInsertion(
                requested_link_id=link_id,
                source_ref=source.uri,
                canonical_link_id=known.canonical.resource_id,
                created=known.row.canonical_identity_id is None,
            )
        return source.id
    if not note_bodies.text_from_pm_json(body_pm_json).strip():
        raise InvalidRequestError(ApiErrorCode.E_EMPTY_NOTE_BODY, "A capture needs text")
    if (
        authored_identities.recognize(db, viewer_id=viewer_id, kind="note_block", id=note_id)
        is not None
    ):
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Capture note id is taken")
    bound = _bound_page_id(db, viewer_id, local_date)
    page_id = bound or proposed_page_id or uuid4()
    outline.apply_in_current_transaction(
        db,
        viewer_id=viewer_id,
        commands=[
            EnsureDaily(kind="ensure_daily", local_date=local_date, page_id=page_id),
            InsertNote(
                kind="insert_note",
                source=LinkResourceEndpoint(ref=page_ref(page_id).uri),
                link_id=link_id,
                note_id=note_id,
                body_pm_json=body_pm_json,
                position=None,
            ),
        ],
    )
    return page_id


def append_note_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    page_id: UUID,
    note_id: UUID,
    body_pm_json: dict[str, Any],
    link_id: UUID | None = None,
) -> None:
    """A tool's stable note id deterministically supplies its stable link id."""
    from nexus.services import outline

    page = page_ref(_owned_page(db, viewer_id, page_id).id)
    outline.apply_in_current_transaction(
        db,
        viewer_id=viewer_id,
        commands=[
            InsertNote(
                kind="insert_note",
                source=LinkResourceEndpoint(ref=page.uri),
                link_id=link_id or uuid5(note_id, "page-note-link"),
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
    link_id: UUID,
    body_pm_json: dict[str, Any],
    expected: HighlightNoteExpected,
) -> WritingAck:
    def op() -> WritingAck:
        if expected.kind == "absent":
            attach_highlight_note_in_current_transaction(
                db,
                viewer_id,
                highlight_id=highlight_id,
                note_id=note_id,
                link_id=link_id,
                body_pm_json=body_pm_json,
                expected_version=expected.version,
            )
        else:
            source = _lock_highlight_note_source(db, viewer_id, highlight_id)
            edge = db.get(ResourceEdge, link_id)
            if (
                edge is None
                or edge.user_id != viewer_id
                or edge.origin != "highlight_note"
                or (edge.source_id != highlight_id or edge.target_id != note_id)
            ):
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight note changed")
            writing.effects(db).addressed.add(source)
            note_bodies.write_body(
                db,
                viewer_id=viewer_id,
                note_id=note_id,
                body_pm_json=body_pm_json,
                expected_version=expected.version,
                reason="highlight_note_update",
            )
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
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
    link_id: UUID | None = None,
) -> bool:
    """Recognized attachment ids never repeat initialization after detachment."""
    link_id = link_id or uuid5(note_id, "highlight-note-link")
    known = authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=link_id)
    if known is not None:
        writing.identity(db, known.out())
        child = authored_identities.recognize(
            db, viewer_id=viewer_id, kind="note_block", id=note_id
        )
        if child is None:
            raise ConflictError(
                ApiErrorCode.E_NOTE_CONFLICT, "Initialized attachment cannot take a new note"
            )
        writing.identity(db, child.out())
        return False
    source = _lock_highlight_note_source(db, viewer_id, highlight_id)
    attached = [block.id for block in note_blocks_for_highlight(db, viewer_id, highlight_id)]
    if (
        attached
        or authored_identities.recognize(db, viewer_id=viewer_id, kind="note_block", id=note_id)
        is not None
    ):
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight already has a note")
    current = versions.versions_for_ref(db, viewer_id=viewer_id, ref=source).get("links", 1)
    if current != expected_version:
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT,
            "Highlight note attachment changed",
            details={"current": {"links_version": current}},
        )
    writing.lane(db, viewer_id=viewer_id, ref=source, name="links", before=current, checked=current)
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
            id=link_id,
        ),
    )
    writing.effects(db).addressed.add(source)
    return True


def _lock_highlight_note_source(db: Session, viewer_id: UUID, highlight_id: UUID) -> ResourceRef:
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    locked = db.scalar(select(Highlight).where(Highlight.id == highlight_id).with_for_update())
    if locked is None or locked.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Not found")
    return ResourceRef(scheme="highlight", id=highlight_id)


def detach_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_id: UUID,
    link_id: UUID,
) -> WritingAck:
    def op() -> WritingAck:
        known = authored_identities.recognize(db, viewer_id=viewer_id, kind="link", id=link_id)
        if known is not None and known.deleted:
            writing.identity(db, known.out())
        else:
            edge = db.get(ResourceEdge, link_id)
            if edge is not None:
                _lock_highlight_note_source(db, viewer_id, highlight_id)
                if (
                    edge.user_id != viewer_id
                    or edge.origin != "highlight_note"
                    or (edge.source_id != highlight_id or edge.target_id != note_id)
                ):
                    raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight note changed")
                edges.delete_edge(db, viewer_id=viewer_id, edge_id=edge.id)
            else:
                binding = authored_identities.retire(
                    db,
                    viewer_id=viewer_id,
                    kind="link",
                    id=link_id,
                    source_ref=f"highlight:{highlight_id}",
                )
                writing.identity(db, binding.out())
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "detach_highlight_note", op)


def delete_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_id: UUID,
    expected_version: int,
) -> WritingAck:
    def op() -> WritingAck:
        block = db.get(NoteBlock, note_id)
        if block is not None:
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
        out = writing.ack(db, viewer_id)
        if writing.effects(db).changed:
            record_input_change(db)
        db.commit()
        return out

    return retry_serializable(db, "delete_highlight_note", op)


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


def _new_page(db: Session, viewer_id: UUID, page_id: UUID, title: str) -> bool:
    known = authored_identities.recognize(db, viewer_id=viewer_id, kind="page", id=page_id)
    if known is not None:
        authored_identities.require_live(known)
        return False
    created = db.scalar(
        insert(Page)
        .values(id=page_id, user_id=viewer_id, title=title)
        .on_conflict_do_nothing(index_elements=["id"])
        .returning(Page.id)
    )
    page = db.get(Page, page_id)
    if page is None:
        known = authored_identities.recognize(db, viewer_id=viewer_id, kind="page", id=page_id)
        if known is not None:
            authored_identities.require_live(known)
        raise RuntimeError("Accepted page insert has no row")
    if page.user_id != viewer_id:
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Page id is taken")
    binding = authored_identities.register(db, viewer_id=viewer_id, kind="page", id=page_id)
    authored_identities.require_live(binding)
    writing.identity(db, binding.out())
    if created is None:
        if binding.newly_registered:
            raise RuntimeError("Existing page has no authored identity")
        return False
    writing.changed(db, viewer_id)
    for lane in ("title", "links"):
        writing.lane(
            db, viewer_id=viewer_id, ref=page_ref(page_id), name=lane, before=None, checked=1
        )
        versions.ensure_version(db, viewer_id=viewer_id, ref=page_ref(page_id), lane=lane)
    return True


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
