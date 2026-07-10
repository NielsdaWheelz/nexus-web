"""Page title and note body workflows."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any, cast
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    DailyNotePage,
    NoteBlock,
    Page,
    PinnedObjectRef,
    ResourceEdge,
    ResourceMutation,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.notes import (
    CreatePageRequest,
    DailyNotePageOut,
    DailyNotePageSummaryOut,
    NoteBlockOut,
    NotePageOut,
    NotePageSummaryOut,
    QuickCaptureRequest,
    UpdatePageRequest,
)
from nexus.services import note_bodies
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.highlight_access import get_highlight_for_visible_read_or_404
from nexus.services.note_indexing import enqueue_note_reindex
from nexus.services.resource_graph import adjacency as graph_adjacency
from nexus.services.resource_graph import highlight_notes as graph_highlight_notes
from nexus.services.resource_graph.cleanup import (
    delete_edges_for_deleted_resource,
    delete_resource_protocol_state,
)
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceScheme,
)
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_items import surfaces, versions

pm_doc_from_text = note_bodies.pm_doc_from_text
pm_doc_from_markdown_projection = note_bodies.pm_doc_from_markdown_projection
text_from_pm_json = note_bodies.text_from_pm_json


def list_pages(db: Session, viewer_id: UUID) -> list[NotePageSummaryOut]:
    pages = db.scalars(
        select(Page)
        .where(Page.user_id == viewer_id)
        .order_by(Page.updated_at.desc(), Page.title.asc(), Page.id.asc())
    ).all()
    return [NotePageSummaryOut.model_validate(page, from_attributes=True) for page in pages]


def create_page(db: Session, viewer_id: UUID, request: CreatePageRequest) -> NotePageOut:
    page = Page(user_id=viewer_id, title=request.title)
    db.add(page)
    db.flush()
    versions.ensure_version(db, viewer_id=viewer_id, ref=_page_ref(page.id), lane="title")
    versions.ensure_version(db, viewer_id=viewer_id, ref=_page_ref(page.id), lane="outgoing_edges")
    db.commit()
    db.refresh(page)
    return _page_out(db, viewer_id, page)


def get_page_for_owner_or_404(db: Session, viewer_id: UUID, page_id: UUID) -> Page:
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    return page


def get_page(db: Session, viewer_id: UUID, page_id: UUID) -> NotePageOut:
    return _page_out(db, viewer_id, get_page_for_owner_or_404(db, viewer_id, page_id))


def update_page(
    db: Session,
    viewer_id: UUID,
    page_id: UUID,
    request: UpdatePageRequest,
) -> NotePageOut:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    if page.title != request.title:
        page.title = request.title
        page.updated_at = func.now()
        _bump_version(db, viewer_id, _page_ref(page.id), "title")
    db.commit()
    db.refresh(page)
    return _page_out(db, viewer_id, page)


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    ref = _page_ref(page.id)
    delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(
        delete(PinnedObjectRef).where(
            PinnedObjectRef.user_id == viewer_id,
            PinnedObjectRef.object_type == "page",
            PinnedObjectRef.object_id == page.id,
        )
    )
    db.execute(
        delete(DailyNotePage).where(
            DailyNotePage.user_id == viewer_id,
            DailyNotePage.page_id == page.id,
        )
    )
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(page)
    db.commit()


def get_daily_note_for_today(
    db: Session,
    viewer_id: UUID,
    *,
    time_zone: str,
) -> DailyNotePageOut:
    return get_daily_note(db, viewer_id, _today_in_time_zone(time_zone), time_zone=time_zone)


def get_daily_note(
    db: Session,
    viewer_id: UUID,
    local_date: date,
    *,
    time_zone: str = "UTC",
) -> DailyNotePageOut:
    page, stored_time_zone = _resolve_daily_page_with_retry(
        db,
        viewer_id,
        local_date,
        time_zone=time_zone,
    )
    return DailyNotePageOut(
        local_date=local_date,
        time_zone=stored_time_zone,
        page=_page_out(db, viewer_id, page),
    )


def resolve_daily_note_page_ref(
    db: Session,
    *,
    viewer_id: UUID,
    local_date: date,
    time_zone: str,
) -> ResourceRef:
    _zone_info(time_zone)
    page, _stored_time_zone = _resolve_daily_page_with_retry(
        db,
        viewer_id,
        local_date,
        time_zone=time_zone,
    )
    return _page_ref(page.id)


def resolve_today_daily_note_page_ref(
    db: Session,
    *,
    viewer_id: UUID,
    time_zone: str,
) -> ResourceRef:
    return resolve_daily_note_page_ref(
        db,
        viewer_id=viewer_id,
        local_date=_today_in_time_zone(time_zone),
        time_zone=time_zone,
    )


def quick_capture(
    db: Session,
    viewer_id: UUID,
    *,
    request: QuickCaptureRequest,
    time_zone: str = "UTC",
) -> NoteBlockOut:
    local_date = request.local_date or _today_in_time_zone(time_zone)
    page, _stored_time_zone = _resolve_daily_page_with_retry(
        db,
        viewer_id,
        local_date,
        time_zone=time_zone,
    )
    scope = f"resource:{_page_ref(page.id).uri}:quick_capture"
    response = _replay_note_response(db, viewer_id, scope, request.client_mutation_id, request)
    if response is not None:
        return response

    block = _upsert_note_body(db, viewer_id, request.id, request.body_pm_json)
    source = _page_ref(page.id)
    target = _note_ref(block.id)
    if _ordered_edge_to_target(db, viewer_id, source, target) is None:
        surface = surfaces.get_surface(db, viewer_id=viewer_id, source=source)
        graph_adjacency.replace_ordered_targets(
            db,
            user_id=viewer_id,
            source=source,
            targets=[
                graph_adjacency.OrderedTarget(
                    target=ResourceRef(
                        scheme=cast(ResourceScheme, item.target.scheme),
                        id=item.target.id,
                    ),
                    source_order_key=item.source_order_key,
                )
                for item in surface.ordered_items
            ]
            + [
                graph_adjacency.OrderedTarget(
                    target=target,
                    source_order_key=_next_order_key(db, viewer_id, source),
                )
            ],
        )
        _bump_version(db, viewer_id, source, "outgoing_edges")
    enqueue_note_reindex(db, note_block_id=block.id, reason="quick_capture")
    response = NoteBlockOut(
        id=block.id,
        parent_block_id=None,
        order_key=None,
        body_pm_json=block.body_pm_json,
        body_text=block.body_text,
        created_at=block.created_at,
        updated_at=block.updated_at,
        version_by_lane=versions.versions_for_ref(db, viewer_id=viewer_id, ref=_note_ref(block.id)),
    )
    _record_mutation(
        db,
        viewer_id,
        scope,
        request.client_mutation_id,
        request,
        response.model_dump(mode="json", by_alias=True),
    )
    db.commit()
    return response


def append_note_block_to_page(
    db: Session, viewer_id: UUID, *, page_id: UUID, body_pm_json: dict[str, Any]
) -> NoteBlockOut:
    """Append one new note block to a caller-supplied page (the amanuensis
    ``jot_note`` page-append seam). Mirrors ``quick_capture``'s ordered-edge
    append, but resolves an explicit page instead of today's daily page and does
    not carry a client-mutation replay (the tool loop re-arms at the tool-call
    level). The page must belong to the viewer."""
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    block = _upsert_note_body(db, viewer_id, uuid4(), body_pm_json)
    source = _page_ref(page.id)
    target = _note_ref(block.id)
    surface = surfaces.get_surface(db, viewer_id=viewer_id, source=source)
    graph_adjacency.replace_ordered_targets(
        db,
        user_id=viewer_id,
        source=source,
        targets=[
            graph_adjacency.OrderedTarget(
                target=ResourceRef(
                    scheme=cast(ResourceScheme, item.target.scheme),
                    id=item.target.id,
                ),
                source_order_key=item.source_order_key,
            )
            for item in surface.ordered_items
        ]
        + [
            graph_adjacency.OrderedTarget(
                target=target,
                source_order_key=_next_order_key(db, viewer_id, source),
            )
        ],
    )
    _bump_version(db, viewer_id, source, "outgoing_edges")
    enqueue_note_reindex(db, note_block_id=block.id, reason="assistant_jot_note")
    response = NoteBlockOut(
        id=block.id,
        parent_block_id=None,
        order_key=None,
        body_pm_json=block.body_pm_json,
        body_text=block.body_text,
        created_at=block.created_at,
        updated_at=block.updated_at,
        version_by_lane=versions.versions_for_ref(db, viewer_id=viewer_id, ref=_note_ref(block.id)),
    )
    db.commit()
    return response


def get_note_block_for_owner_or_404(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlock:
    block = db.get(NoteBlock, block_id)
    if block is None or block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    return block


def get_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlockOut:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    return NoteBlockOut(
        id=block.id,
        parent_block_id=None,
        order_key=None,
        body_pm_json=block.body_pm_json,
        body_text=block.body_text,
        created_at=block.created_at,
        updated_at=block.updated_at,
        version_by_lane=versions.versions_for_ref(db, viewer_id=viewer_id, ref=_note_ref(block.id)),
    )


def upsert_note_body_without_commit(
    db: Session, viewer_id: UUID, block_id: UUID, body_pm_json: dict[str, Any]
) -> NoteBlock:
    return _upsert_note_body(db, viewer_id, block_id, body_pm_json)


def remove_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> None:
    """Delete one note block and its graph edges + content index (the assistant
    ``jot_note`` undo seam, amanuensis F-02). Mirrors ``delete_page``: no single-
    block deleter existed before this. Named ``remove_*`` to stay clear of the
    notes-cutover's banned single-block editing command surface. Idempotent — an
    already-absent block is a no-op so undo tolerates a manually-deleted target
    (R-5)."""
    block = db.get(NoteBlock, block_id)
    if block is None or block.user_id != viewer_id:
        return
    ref = _note_ref(block.id)
    delete_edges_for_deleted_resource(db, ref=ref)
    delete_content_index(db, owner=IndexOwner("note_block", block.id))
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(block)
    db.commit()


def set_highlight_note_body_pm_json(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    block_id: UUID,
    body_pm_json: dict[str, Any],
    client_mutation_id: str,
) -> NoteBlockOut:
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    request_payload = {"blockId": str(block_id), "bodyPmJson": body_pm_json}
    scope = f"highlight_note:{highlight_id}"
    replay = _replay_note_response(db, viewer_id, scope, client_mutation_id, request_payload)
    if replay is not None:
        return replay

    existing = graph_highlight_notes.first_note_block_for_highlight(db, viewer_id, highlight_id)
    if existing is not None and existing.id != block_id:
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight note block id mismatch")

    block = _upsert_note_body(db, viewer_id, block_id, body_pm_json)
    enqueue_note_reindex(db, note_block_id=block.id, reason="highlight_note")
    if existing is None:
        create_edge(
            db,
            viewer_id=viewer_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="highlight", id=highlight_id),
                target=_note_ref(block.id),
                kind="context",
                origin="highlight_note",
            ),
        )
    response = NoteBlockOut(
        id=block.id,
        parent_block_id=None,
        order_key=None,
        body_pm_json=block.body_pm_json,
        body_text=block.body_text,
        created_at=block.created_at,
        updated_at=block.updated_at,
        version_by_lane=versions.versions_for_ref(db, viewer_id=viewer_id, ref=_note_ref(block.id)),
    )
    _record_mutation(
        db,
        viewer_id,
        scope,
        client_mutation_id,
        request_payload,
        response.model_dump(mode="json", by_alias=True),
    )
    db.commit()
    return response


def delete_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_block_id: UUID | None,
    client_mutation_id: str,
) -> None:
    get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
    existing = graph_highlight_notes.first_note_block_for_highlight(db, viewer_id, highlight_id)
    if existing is None:
        return
    if note_block_id is not None and existing.id != note_block_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    ref = _note_ref(existing.id)
    delete_edges_for_deleted_resource(db, ref=ref)
    db.execute(
        delete(PinnedObjectRef).where(
            PinnedObjectRef.user_id == viewer_id,
            PinnedObjectRef.object_type == "note_block",
            PinnedObjectRef.object_id == existing.id,
        )
    )
    delete_resource_protocol_state(db, viewer_id=viewer_id, ref=ref)
    db.delete(existing)
    db.commit()


def _upsert_note_body(
    db: Session, viewer_id: UUID, block_id: UUID, body_pm_json: dict[str, Any]
) -> NoteBlock:
    return note_bodies.upsert_note_body(
        db,
        viewer_id=viewer_id,
        block_id=block_id,
        body_pm_json=body_pm_json,
    )


def _resolve_daily_page_with_retry(
    db: Session,
    viewer_id: UUID,
    local_date: date,
    *,
    time_zone: str,
    commit: bool = True,
) -> tuple[Page, str]:
    def op() -> tuple[Page, str]:
        page, stored_time_zone = _resolve_daily_page_once(
            db,
            viewer_id,
            local_date,
            time_zone=time_zone,
        )
        if commit:
            db.commit()
            db.refresh(page)
        return page, stored_time_zone

    for attempt in range(3):
        try:
            return retry_serializable(db, "resolve_daily_page", op)
        except IntegrityError as exc:
            db.rollback()
            if (
                integrity_constraint_name(exc)
                not in {
                    "uix_daily_note_pages_user_date",
                    "uix_daily_note_pages_user_page",
                }
                or attempt == 2
            ):
                raise
    raise AssertionError("Daily note retry loop exhausted")


def _resolve_daily_page_once(
    db: Session,
    viewer_id: UUID,
    local_date: date,
    *,
    time_zone: str,
) -> tuple[Page, str]:
    daily = db.scalar(
        select(DailyNotePage).where(
            DailyNotePage.user_id == viewer_id,
            DailyNotePage.local_date == local_date,
        )
    )
    if daily is not None:
        return get_page_for_owner_or_404(db, viewer_id, daily.page_id), daily.time_zone

    page = Page(
        user_id=viewer_id,
        title=f"{local_date.strftime('%B')} {local_date.day}, {local_date.year}",
    )
    db.add(page)
    db.flush()
    versions.ensure_version(db, viewer_id=viewer_id, ref=_page_ref(page.id), lane="title")
    versions.ensure_version(db, viewer_id=viewer_id, ref=_page_ref(page.id), lane="outgoing_edges")
    db.add(
        DailyNotePage(
            user_id=viewer_id,
            local_date=local_date,
            time_zone=time_zone,
            page_id=page.id,
        )
    )
    return page, time_zone


def _page_out(db: Session, viewer_id: UUID, page: Page) -> NotePageOut:
    surface = graph_adjacency.load_page_surface(db, user_id=viewer_id, page_id=page.id)
    daily_local_date = db.scalar(
        select(DailyNotePage.local_date).where(
            DailyNotePage.page_id == page.id,
            DailyNotePage.user_id == viewer_id,
        )
    )
    return NotePageOut(
        id=page.id,
        title=page.title,
        updated_at=page.updated_at,
        surface=surfaces.get_surface(db, viewer_id=viewer_id, source=_page_ref(page.id)),
        blocks=[_surface_note_out(db, node) for node in surface.roots],
        daily_note=(
            DailyNotePageSummaryOut(local_date=daily_local_date)
            if daily_local_date is not None
            else None
        ),
    )


def _surface_note_out(db: Session, node: graph_adjacency.SurfaceNote) -> NoteBlockOut:
    return NoteBlockOut(
        id=node.block.id,
        parent_block_id=node.parent.id if node.parent.scheme == "note_block" else None,
        order_key=node.source_order_key,
        body_pm_json=node.block.body_pm_json,
        body_text=node.block.body_text,
        collapsed=node.collapsed,
        children=[_surface_note_out(db, child) for child in node.children],
        created_at=node.block.created_at,
        updated_at=node.block.updated_at,
        version_by_lane=versions.versions_for_ref(
            db, viewer_id=node.block.user_id, ref=_note_ref(node.block.id)
        ),
    )


def _today_in_time_zone(time_zone: str) -> date:
    return datetime.now(_zone_info(time_zone)).date()


def _zone_info(time_zone: str) -> ZoneInfo:
    try:
        return ZoneInfo(time_zone)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "time_zone is invalid") from exc


def _append_text(content: list[dict[str, Any]], text_value: str) -> None:
    for index, line in enumerate(text_value.split("\n")):
        if index > 0:
            content.append({"type": "hard_break"})
        if line:
            content.append({"type": "text", "text": line})


def _page_ref(page_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="page", id=page_id)


def _note_ref(block_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="note_block", id=block_id)


def _bump_version(db: Session, viewer_id: UUID, ref: ResourceRef, lane: str) -> None:
    versions.bump_version(db, viewer_id=viewer_id, ref=ref, lane=lane)


def _next_order_key(db: Session, viewer_id: UUID, source: ResourceRef) -> str:
    last = db.scalar(
        select(ResourceEdge.source_order_key)
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.source_scheme == source.scheme,
            ResourceEdge.source_id == source.id,
            ResourceEdge.kind == "context",
            ResourceEdge.origin == "user",
            ResourceEdge.source_order_key.is_not(None),
        )
        .order_by(ResourceEdge.source_order_key.desc())
        .limit(1)
    )
    return "0000000001" if last is None else f"{int(last) + 1:010d}"


def _ordered_edge_to_target(
    db: Session, viewer_id: UUID, source: ResourceRef, target: ResourceRef
) -> ResourceEdge | None:
    return db.scalar(
        select(ResourceEdge).where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.source_scheme == source.scheme,
            ResourceEdge.source_id == source.id,
            ResourceEdge.target_scheme == target.scheme,
            ResourceEdge.target_id == target.id,
            ResourceEdge.kind == "context",
            ResourceEdge.origin == "user",
            ResourceEdge.source_order_key.is_not(None),
        )
    )


def _replay_note_response(
    db: Session,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_payload: object,
) -> NoteBlockOut | None:
    replay = db.scalar(
        select(ResourceMutation).where(
            ResourceMutation.user_id == viewer_id,
            ResourceMutation.mutation_scope == scope,
            ResourceMutation.client_mutation_id == client_mutation_id,
        )
    )
    if replay is None:
        return None
    if replay.request_hash != _hash_payload(request_payload):
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Resource mutation id was reused with a different request",
        )
    return NoteBlockOut.model_validate(replay.response_json)


def _record_mutation(
    db: Session,
    viewer_id: UUID,
    scope: str,
    client_mutation_id: str,
    request_payload: object,
    response_json: dict[str, object],
) -> None:
    db.add(
        ResourceMutation(
            user_id=viewer_id,
            mutation_scope=scope,
            client_mutation_id=client_mutation_id,
            request_hash=_hash_payload(request_payload),
            changed_lanes={scope: True},
            response_json=response_json,
        )
    )


def _hash_payload(payload: object) -> str:
    if isinstance(payload, BaseModel):
        payload = payload.model_dump(mode="json", by_alias=True)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
