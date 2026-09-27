"""Pages, note blocks, the daily page, and the note attached to a highlight."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import DailyPageBinding, NoteBlock, Page, ResourceEdge
from nexus.db.retries import retry_read_committed, retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.notes import (
    CreatePageRequest,
    DailyCaptureRequest,
    DailyCaptureResult,
    DailyPageDescriptor,
    DailyPageSummaryOut,
    LatentDailyPageDescriptor,
    MaterializedDailyPageDescriptor,
    NoteBlockOut,
    NotePageOut,
    NotePageSummaryOut,
    UpdatePageRequest,
)
from nexus.schemas.presence import presence_from_nullable
from nexus.schemas.resource_items import ExpectedNoteBody
from nexus.services import note_bodies, passage_anchors
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.highlights import get_highlight_for_visible_read_or_404
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import highlight_notes as graph_highlight_notes
from nexus.services.resource_graph.cleanup import (
    clear_edge_view_state,
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.edges import create_edge, delete_edge
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_items import surfaces as resource_surfaces
from nexus.services.resource_items import versions
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

NotesIndexView = Literal["updated_desc", "updated_asc", "title_asc", "title_desc"]

_INDEX_VIEWS: dict[tuple[str | None, str | None], NotesIndexView] = {
    (None, None): "updated_desc",
    ("updated", "asc"): "updated_asc",
    ("title", "asc"): "title_asc",
    ("title", "desc"): "title_desc",
}


@dataclass(frozen=True, slots=True)
class RecentNoteAnchorFact:
    ref: ResourceRef
    activity_at: datetime


def count_retained_note_blocks(
    db: Session, *, viewer_id: UUID, start: datetime | None, end: datetime
) -> int:
    """Surviving viewer-owned note blocks by database creation time."""
    return int(
        db.scalar(
            text(
                """
                SELECT count(*)
                FROM note_blocks
                WHERE user_id = :viewer_id
                  AND (
                    CAST(:start AS timestamptz) IS NULL
                    OR created_at >= CAST(:start AS timestamptz)
                  )
                  AND created_at < :end
                """
            ),
            {"viewer_id": viewer_id, "start": start, "end": end},
        )
        or 0
    )


def recent_note_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[RecentNoteAnchorFact, ...]:
    """Recent note-block and page edits, each source capped at ``limit``."""
    if limit < 1:
        return ()
    rows = db.execute(
        text(
            """
            WITH recent_note_blocks AS (
                SELECT
                    'note_block'::text AS resource_scheme,
                    id AS resource_id,
                    updated_at AS activity_at
                FROM note_blocks
                WHERE user_id = :viewer_id
                ORDER BY updated_at DESC, id ASC
                LIMIT :limit
            ),
            recent_pages AS (
                SELECT
                    'page'::text AS resource_scheme,
                    id AS resource_id,
                    updated_at AS activity_at
                FROM pages
                WHERE user_id = :viewer_id
                ORDER BY updated_at DESC, id ASC
                LIMIT :limit
            )
            SELECT resource_scheme, resource_id, activity_at
            FROM recent_note_blocks
            UNION ALL
            SELECT resource_scheme, resource_id, activity_at
            FROM recent_pages
            ORDER BY activity_at DESC, resource_scheme ASC, resource_id ASC
            """
        ),
        {"viewer_id": viewer_id, "limit": limit},
    ).mappings()
    return tuple(
        RecentNoteAnchorFact(
            ref=ResourceRef(
                scheme=cast(ResourceScheme, str(row["resource_scheme"])),
                id=UUID(str(row["resource_id"])),
            ),
            activity_at=row["activity_at"],
        )
        for row in rows
    )


def parse_notes_index_query(items: Sequence[tuple[str, str]]) -> NotesIndexView:
    """The Pages index has no cursor or revision, so ``sort``/``direction`` are the
    only keys it accepts, each at most once, and every view has exactly one URL."""
    parameters: dict[str, str] = {}
    for key, value in items:
        if key not in {"sort", "direction"} or key in parameters:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Unsupported notes index view"
            )
        parameters[key] = value
    view = _INDEX_VIEWS.get((parameters.get("sort"), parameters.get("direction")))
    if view is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unsupported notes index view")
    return view


def list_pages(db: Session, viewer_id: UUID, *, view: NotesIndexView) -> list[NotePageSummaryOut]:
    """Every owned page in one total order; equal titles read newest-first."""
    folded = func.lower(func.btrim(Page.title))
    order = {
        "updated_desc": (Page.updated_at.desc(), Page.title.asc(), Page.id.asc()),
        "updated_asc": (Page.updated_at.asc(), Page.title.asc(), Page.id.asc()),
        "title_asc": (folded.asc(), Page.title.asc(), Page.updated_at.desc(), Page.id.asc()),
        "title_desc": (folded.desc(), Page.title.desc(), Page.updated_at.desc(), Page.id.asc()),
    }[view]
    pages = db.scalars(select(Page).where(Page.user_id == viewer_id).order_by(*order)).all()
    return [NotePageSummaryOut.model_validate(page, from_attributes=True) for page in pages]


def get_page_for_owner_or_404(db: Session, viewer_id: UUID, page_id: UUID) -> Page:
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    return page


def create_page(db: Session, viewer_id: UUID, request: CreatePageRequest) -> NotePageOut:
    """Idempotent by the client-chosen page id; a different owner or title conflicts."""

    def op() -> UUID:
        with transaction(db):
            page = db.get(Page, request.page_id)
            if page is None:
                page = Page(id=request.page_id, user_id=viewer_id, title=request.title)
                db.add(page)
                db.flush()
            elif page.user_id != viewer_id or page.title != request.title:
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT,
                    "Page create id is already bound to a different resource",
                )
            _ensure_page_versions(db, viewer_id, page.id)
            return page.id

    page_id = retry_serializable(db, "create_page", op)
    return _page_out(db, viewer_id, get_page_for_owner_or_404(db, viewer_id, page_id))


def get_page(db: Session, viewer_id: UUID, page_id: UUID) -> NotePageOut:
    return _page_out(db, viewer_id, get_page_for_owner_or_404(db, viewer_id, page_id))


def update_page(
    db: Session, viewer_id: UUID, page_id: UUID, request: UpdatePageRequest
) -> NotePageOut:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    if page.title != request.title:
        page.title = request.title
        page.updated_at = func.now()
        versions.bump_version(db, viewer_id=viewer_id, ref=_page_ref(page.id), lane="title")
    db.commit()
    db.refresh(page)
    return _page_out(db, viewer_id, page)


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    def attempt() -> None:
        delete_page_in_current_transaction(db, viewer_id, page_id)
        db.commit()

    retry_read_committed(db, "delete_page", attempt)


def delete_page_in_current_transaction(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    """Stage one page deletion inside the composing caller's retry attempt."""
    from nexus.services.artifacts import engine as artifact_engine

    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    ref = _page_ref(page.id)
    artifact_engine.on_subject_deleted(db, ref)
    delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(
        delete(DailyPageBinding).where(
            DailyPageBinding.user_id == viewer_id, DailyPageBinding.page_id == page.id
        )
    )
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(page)


def read_daily_page(db: Session, viewer_id: UUID, local_date: date) -> DailyPageDescriptor:
    binding = db.scalar(
        select(DailyPageBinding).where(
            DailyPageBinding.user_id == viewer_id, DailyPageBinding.local_date == local_date
        )
    )
    if binding is None:
        return LatentDailyPageDescriptor(
            kind="Latent",
            local_date=local_date,
            default_title=_default_daily_page_title(local_date),
        )
    page = get_page_for_owner_or_404(db, viewer_id, binding.page_id)
    return MaterializedDailyPageDescriptor(
        kind="Materialized",
        local_date=local_date,
        page=_page_out(db, viewer_id, page),
        surface=resource_surfaces.get_surface(db, viewer_id=viewer_id, source=_page_ref(page.id)),
    )


def capture_daily_page_note(
    db: Session, viewer_id: UUID, *, local_date: date, request: DailyCaptureRequest
) -> DailyCaptureResult:
    page_id_candidate = uuid4()

    def op() -> DailyCaptureResult:
        with transaction(db):
            return capture_daily_page_note_in_current_transaction(
                db,
                viewer_id,
                local_date=local_date,
                request=request,
                page_id_candidate=page_id_candidate,
            )

    return retry_serializable(db, "capture_daily_page_note", op)


def capture_daily_page_note_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    local_date: date,
    request: DailyCaptureRequest,
    page_id_candidate: UUID,
) -> DailyCaptureResult:
    """Append one capture to the end of the viewer's daily page surface."""
    if not note_bodies.text_from_pm_json(request.body_pm_json).strip():
        raise InvalidRequestError(
            ApiErrorCode.E_EMPTY_NOTE_BODY, "Daily capture requires a meaningful note body"
        )
    request_bytes = canonical_json_bytes(
        {**request.model_dump(mode="json", by_alias=True), "localDate": local_date.isoformat()}
    )
    replay = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope="daily:capture",
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
    )
    if replay is not None:
        return DailyCaptureResult.model_validate(replay)

    binding = db.scalar(
        select(DailyPageBinding).where(
            DailyPageBinding.user_id == viewer_id, DailyPageBinding.local_date == local_date
        )
    )
    page = (
        _materialize_daily_page(db, viewer_id, local_date, page_id_candidate)
        if binding is None
        else get_page_for_owner_or_404(db, viewer_id, binding.page_id)
    )
    page_ref = _page_ref(page.id)
    resource_surfaces.insert_note_occurrence_without_commit(
        db,
        viewer_id=viewer_id,
        source=page_ref,
        note_id=request.note_id,
        body_pm_json=request.body_pm_json,
        position="end",
        reindex_reason="daily_capture",
    )
    response = DailyCaptureResult(
        client_mutation_id=request.client_mutation_id,
        local_date=local_date,
        page_id=page.id,
        surface=resource_surfaces.get_surface(db, viewer_id=viewer_id, source=page_ref),
    )
    record_replay(
        db,
        viewer_id=viewer_id,
        scope="daily:capture",
        client_mutation_id=request.client_mutation_id,
        request_bytes=request_bytes,
        response_json=response.model_dump(mode="json", by_alias=True),
    )
    db.flush()
    return response


def append_note_block_to_page_in_current_transaction(
    db: Session, viewer_id: UUID, *, page_id: UUID, note_id: UUID, body_pm_json: dict[str, Any]
) -> NoteBlockOut:
    """Append one client-stable note inside the assistant step transaction."""
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    block = resource_surfaces.insert_note_occurrence_without_commit(
        db,
        viewer_id=viewer_id,
        source=_page_ref(page.id),
        note_id=note_id,
        body_pm_json=body_pm_json,
        position="end",
        reindex_reason="assistant_jot_note",
    )
    return _note_block_out(db, viewer_id, block)


def get_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlockOut:
    return _note_block_out(
        db, viewer_id, note_bodies.get_note_block_for_owner_or_404(db, viewer_id, block_id)
    )


def remove_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> None:
    """Delete one owned note block. An already-absent block is a no-op."""

    def attempt() -> None:
        if remove_note_block_in_current_transaction(db, viewer_id, block_id):
            db.commit()

    retry_read_committed(db, "remove_note_block", attempt)


def remove_note_block_in_current_transaction(db: Session, viewer_id: UUID, block_id: UUID) -> bool:
    block = db.get(NoteBlock, block_id)
    if block is None or block.user_id != viewer_id:
        return False
    _delete_note_block(db, viewer_id, block)
    return True


def set_highlight_note_body_pm_json(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    block_id: UUID,
    body_pm_json: dict[str, Any],
    expected_body: ExpectedNoteBody,
    client_mutation_id: str,
) -> NoteBlockOut:
    def op() -> NoteBlockOut:
        response = set_highlight_note_body_pm_json_in_current_transaction(
            db,
            viewer_id,
            highlight_id=highlight_id,
            block_id=block_id,
            body_pm_json=body_pm_json,
            expected_body=expected_body,
            client_mutation_id=client_mutation_id,
        )
        db.commit()
        return response

    return retry_serializable(db, "set_highlight_note_body_pm_json", op)


def set_highlight_note_body_pm_json_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    block_id: UUID,
    body_pm_json: dict[str, Any],
    expected_body: ExpectedNoteBody,
    client_mutation_id: str,
) -> NoteBlockOut:
    """Create or update exactly one attached note with a canonical body base."""
    scope = f"highlight_note:{highlight_id}"
    request_bytes = canonical_json_bytes(
        {
            "operation": "put",
            "blockId": str(block_id),
            "bodyPmJson": body_pm_json,
            "expectedBody": expected_body.model_dump(mode="json"),
        }
    )
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    replay = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
    )
    if replay is not None:
        return NoteBlockOut.model_validate(replay)

    attached = graph_highlight_notes.note_blocks_for_highlight(db, viewer_id, highlight_id)
    if expected_body.kind == "absent":
        if attached:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight already has a note")
    elif not any(block.id == block_id for block in attached):
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note is no longer attached")
    note_bodies.require_expected_body(
        db, viewer_id=viewer_id, block_id=block_id, expected_body=expected_body
    )
    block = note_bodies.upsert_note_body(
        db, viewer_id=viewer_id, block_id=block_id, body_pm_json=body_pm_json
    )
    enqueue_note_reindex(db, note_block_id=block.id, reason="highlight_note")
    if expected_body.kind == "absent":
        create_edge(
            db,
            viewer_id=viewer_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="highlight", id=highlight_id),
                target=note_bodies.note_ref(block.id),
                kind="context",
                origin="highlight_note",
            ),
        )
    response = _note_block_out(db, viewer_id, block)
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
        response_json=response.model_dump(mode="json", by_alias=True),
    )
    db.flush()
    return response


def detach_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_block_id: UUID,
    client_mutation_id: str,
) -> None:
    def op() -> None:
        detach_highlight_note_in_current_transaction(
            db,
            viewer_id,
            highlight_id=highlight_id,
            note_block_id=note_block_id,
            client_mutation_id=client_mutation_id,
        )
        db.commit()

    retry_serializable(db, "detach_highlight_note", op)


def detach_highlight_note_in_current_transaction(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_block_id: UUID,
    client_mutation_id: str,
) -> None:
    """Detach the exact annotation; its canonical note and other links survive."""
    scope = f"highlight_note:{highlight_id}"
    request_bytes = canonical_json_bytes({"operation": "detach", "noteBlockId": str(note_block_id)})
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    replay = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
    )
    if replay is not None:
        return
    edge_ids = list(
        db.scalars(
            select(ResourceEdge.id).where(
                ResourceEdge.user_id == viewer_id,
                ResourceEdge.origin == "highlight_note",
                ResourceEdge.source_scheme == "highlight",
                ResourceEdge.source_id == highlight_id,
                ResourceEdge.target_scheme == "note_block",
                ResourceEdge.target_id == note_block_id,
            )
        )
    )
    if not edge_ids:
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note is no longer attached")
    for edge_id in edge_ids:
        clear_edge_view_state(db, edge_id=edge_id)
        delete_edge(db, viewer_id=viewer_id, edge_id=edge_id)
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=scope,
        client_mutation_id=client_mutation_id,
        request_bytes=request_bytes,
        response_json={},
    )
    db.flush()


def _delete_note_block(db: Session, viewer_id: UUID, block: NoteBlock) -> None:
    """The one note-block teardown: subject state, edges, anchors, index, row."""
    from nexus.services.artifacts import engine as artifact_engine

    ref = note_bodies.note_ref(block.id)
    artifact_engine.on_subject_deleted(db, ref)
    delete_edges_for_deleted_resource(db, ref=ref)
    passage_anchors.delete_for_owner(db, owner_scheme="note_block", owner_id=block.id)
    delete_content_index(db, owner=IndexOwner("note_block", block.id))
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(block)


def _note_block_out(db: Session, viewer_id: UUID, block: NoteBlock) -> NoteBlockOut:
    return NoteBlockOut(
        id=block.id,
        body_pm_json=block.body_pm_json,
        body_text=block.body_text,
        created_at=block.created_at,
        updated_at=block.updated_at,
        version_by_lane=versions.versions_for_ref(
            db, viewer_id=viewer_id, ref=note_bodies.note_ref(block.id)
        ),
    )


def _materialize_daily_page(db: Session, viewer_id: UUID, local_date: date, page_id: UUID) -> Page:
    page = Page(id=page_id, user_id=viewer_id, title=_default_daily_page_title(local_date))
    db.add(page)
    db.flush()
    _ensure_page_versions(db, viewer_id, page.id)
    db.add(DailyPageBinding(user_id=viewer_id, local_date=local_date, page_id=page.id))
    db.flush()
    return page


def _ensure_page_versions(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    for lane in ("title", "outgoing_edges"):
        versions.ensure_version(db, viewer_id=viewer_id, ref=_page_ref(page_id), lane=lane)


def _page_out(db: Session, viewer_id: UUID, page: Page) -> NotePageOut:
    local_date = db.scalar(
        select(DailyPageBinding.local_date).where(
            DailyPageBinding.page_id == page.id, DailyPageBinding.user_id == viewer_id
        )
    )
    return NotePageOut(
        id=page.id,
        title=page.title,
        updated_at=page.updated_at,
        daily_page=presence_from_nullable(
            None if local_date is None else DailyPageSummaryOut(local_date=local_date)
        ),
    )


def _default_daily_page_title(local_date: date) -> str:
    return f"{local_date.strftime('%B')} {local_date.day}, {local_date.year}"


def _page_ref(page_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="page", id=page_id)
