"""Page and note-block service."""

from __future__ import annotations

import re
from copy import deepcopy
from datetime import date, datetime
from typing import Any, cast, get_args
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    NOTE_BLOCK_SIBLING_ORDER,
    DailyNotePage,
    Highlight,
    NoteBlock,
    Page,
    PinnedObjectRef,
    ResourceEdge,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.notes import (
    NOTE_BLOCK_KINDS,
    OBJECT_TYPES,
    CreateNoteBlockRequest,
    CreatePageRequest,
    DailyNotePageOut,
    LinkedObjectRequest,
    MoveNoteBlockRequest,
    NoteBlockOut,
    NotePageOut,
    NotePageSummaryOut,
    PatchPageDocumentRequest,
    PatchPageDocumentResponse,
    QuickCaptureRequest,
    SplitNoteBlockRequest,
    UpdateNoteBlockRequest,
    UpdatePageRequest,
)
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.note_indexing import enqueue_page_reindex
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import EdgeCreate

_OBJECT_REF_MARKDOWN_RE = re.compile(
    r"\[\[([a-z_]+):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\|([^\]\n]*))?\]\]"
)


def pm_doc_from_text(text: str) -> dict[str, Any]:
    paragraph: dict[str, Any] = {"type": "paragraph"}
    if text:
        paragraph["content"] = [{"type": "text", "text": text}]
    return paragraph


def pm_doc_from_markdown_projection(markdown: str) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    position = 0
    for match in _OBJECT_REF_MARKDOWN_RE.finditer(markdown):
        if match.start() > position:
            _append_text_and_break_nodes(content, markdown[position : match.start()])
        object_type = match.group(1)
        if object_type not in get_args(OBJECT_TYPES):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Object reference type is invalid")
        content.append(
            {
                "type": "object_ref",
                "attrs": {
                    "objectType": object_type,
                    "objectId": str(UUID(match.group(2))),
                    "label": match.group(3) or f"{object_type}:{match.group(2)}",
                },
            }
        )
        position = match.end()
    if position < len(markdown):
        _append_text_and_break_nodes(content, markdown[position:])
    return {"type": "paragraph", "content": content} if content else {"type": "paragraph"}


def _append_text_and_break_nodes(content: list[dict[str, Any]], text_value: str) -> None:
    for index, line in enumerate(text_value.split("\n")):
        if index > 0:
            content.append({"type": "hard_break"})
        if line:
            content.append({"type": "text", "text": line})


def text_from_pm_json(value: object) -> str:
    parts: list[str] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            parts.append(str(node["text"]))
        if node.get("type") in {"object_ref", "object_embed"} and isinstance(
            node.get("attrs"), dict
        ):
            attrs = node["attrs"]
            label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
            if isinstance(label, str):
                parts.append(label)
        if node.get("type") == "image" and isinstance(node.get("attrs"), dict):
            alt = node["attrs"].get("alt")
            if isinstance(alt, str):
                parts.append(alt)
        if node.get("type") == "hard_break":
            parts.append("\n")
        visit(node.get("content"))
        if node.get("type") in {"paragraph", "heading", "blockquote", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def markdown_from_pm_json(value: object) -> str:
    def escape(text: str) -> str:
        return "".join(f"\\{char}" if char in "\\`*_{}[]()#+-.!|>" else char for char in text)

    def marked(text: str, marks: object) -> str:
        if not isinstance(marks, list):
            return text
        rendered = text
        for mark in marks:
            if not isinstance(mark, dict):
                continue
            mark_type = mark.get("type")
            if mark_type == "code":
                rendered = "`" + rendered.replace("`", "\\`") + "`"
            elif mark_type == "strong":
                rendered = f"**{rendered}**"
            elif mark_type == "em":
                rendered = f"_{rendered}_"
            elif mark_type == "strikethrough":
                rendered = f"~~{rendered}~~"
            elif mark_type == "link" and isinstance(mark.get("attrs"), dict):
                href = mark["attrs"].get("href")
                if isinstance(href, str) and href:
                    rendered = f"[{rendered}]({href})"
        return rendered

    parts: list[str] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text" and isinstance(node.get("text"), str):
            parts.append(marked(escape(node["text"]), node.get("marks")))
            return
        if node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            object_type = attrs.get("objectType")
            object_id = attrs.get("objectId")
            label = attrs.get("label")
            if isinstance(object_type, str) and isinstance(object_id, str):
                suffix = f"|{label}" if isinstance(label, str) and label else ""
                prefix = "!" if node_type == "object_embed" else ""
                parts.append(f"{prefix}[[{object_type}:{object_id}{suffix}]]")
            return
        if node_type == "image" and isinstance(node.get("attrs"), dict):
            src = node["attrs"].get("src")
            alt = node["attrs"].get("alt")
            if isinstance(src, str) and src:
                parts.append(f"![{escape(alt) if isinstance(alt, str) else ''}]({src})")
            elif isinstance(alt, str):
                parts.append(escape(alt))
            return
        if node_type == "hard_break":
            parts.append("  \n")
            return
        visit(node.get("content"))
        if node_type in {"paragraph", "heading", "blockquote", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def list_pages(db: Session, viewer_id: UUID) -> list[NotePageSummaryOut]:
    pages = db.scalars(
        select(Page)
        .where(Page.user_id == viewer_id)
        .order_by(Page.updated_at.desc(), Page.title.asc(), Page.id.asc())
    ).all()
    return [NotePageSummaryOut.model_validate(page, from_attributes=True) for page in pages]


def create_page(db: Session, viewer_id: UUID, request: CreatePageRequest) -> NotePageOut:
    page = Page(user_id=viewer_id, title=request.title, description=request.description)
    db.add(page)
    db.flush()
    enqueue_page_reindex(db, page_id=page.id, reason="page_create")
    db.commit()
    db.refresh(page)
    return _page_out(db, page)


def get_page_for_owner_or_404(db: Session, viewer_id: UUID, page_id: UUID) -> Page:
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    return page


def get_page(db: Session, viewer_id: UUID, page_id: UUID) -> NotePageOut:
    return _page_out(db, get_page_for_owner_or_404(db, viewer_id, page_id))


def update_page(
    db: Session,
    viewer_id: UUID,
    page_id: UUID,
    request: UpdatePageRequest,
) -> NotePageOut:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    changed = False
    if request.title is not None and request.title != page.title:
        page.title = request.title
        changed = True
    if "description" in request.model_fields_set and request.description != page.description:
        page.description = request.description
        changed = True
    if changed:
        page.updated_at = func.now()
        enqueue_page_reindex(db, page_id=page.id, reason="page_update")
    db.commit()
    db.refresh(page)
    return _page_out(db, page)


def patch_page_document(
    db: Session,
    viewer_id: UUID,
    page_id: UUID,
    request: PatchPageDocumentRequest,
) -> PatchPageDocumentResponse:
    return retry_serializable(
        db,
        "patch_page_document",
        lambda: _patch_page_document_once(db, viewer_id, page_id, request),
    )


def _patch_page_document_once(
    db: Session,
    viewer_id: UUID,
    page_id: UUID,
    request: PatchPageDocumentRequest,
) -> PatchPageDocumentResponse:
    page = db.scalar(select(Page).where(Page.id == page_id, Page.user_id == viewer_id))
    if page is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")

    existing_blocks = {
        block.id: block
        for block in db.scalars(
            select(NoteBlock).where(NoteBlock.page_id == page.id, NoteBlock.user_id == viewer_id)
        )
    }
    requested_by_id = {block.id: block for block in request.blocks}
    deleted_ids = set(request.deleted_blocks)

    if request.focus_block_id is not None:
        focused = existing_blocks.get(request.focus_block_id)
        if focused is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    for block_id in deleted_ids:
        block = existing_blocks.get(block_id)
        if block is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    for block_id in list(deleted_ids):
        deleted_ids.update(
            descendant_id
            for descendant_id in _descendant_ids(db, block_id)
            if descendant_id in existing_blocks
        )

    for patch in request.blocks:
        block = existing_blocks.get(patch.id)
        if block is None:
            if db.get(NoteBlock, patch.id) is not None:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists")

    final_parent_by_id = {
        block_id: block.parent_block_id
        for block_id, block in existing_blocks.items()
        if block_id not in deleted_ids
    }
    for patch in request.blocks:
        if patch.id in existing_blocks and patch.id == request.focus_block_id:
            continue
        final_parent_by_id[patch.id] = patch.parent_block_id

    final_order_by_id = {
        block_id: block.order_key
        for block_id, block in existing_blocks.items()
        if block_id not in deleted_ids
    }

    for patch in request.blocks:
        parent_id = final_parent_by_id[patch.id]
        if parent_id is None:
            continue
        if parent_id == patch.id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Block cannot be moved under itself")
        if parent_id in deleted_ids or parent_id not in final_parent_by_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be on the same page")

    for block_id in final_parent_by_id:
        seen: set[UUID] = set()
        parent_id = final_parent_by_id[block_id]
        while parent_id is not None:
            if parent_id == block_id or parent_id in seen:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Block cannot be moved under one of its descendants",
                )
            seen.add(parent_id)
            parent_id = final_parent_by_id.get(parent_id)

    requested_ids_by_parent: dict[UUID | None, list[UUID]] = {}
    for patch in request.blocks:
        if patch.id in existing_blocks and patch.id == request.focus_block_id:
            continue
        requested_ids_by_parent.setdefault(final_parent_by_id[patch.id], []).append(patch.id)

    touched_existing_order_ids: set[UUID] = set()
    for parent_id, requested_ids in requested_ids_by_parent.items():
        siblings = [
            block.id
            for block in _siblings(db, page.id, parent_id)
            if block.id not in deleted_ids and final_parent_by_id.get(block.id) == parent_id
        ]
        for block_id in requested_ids:
            patch = requested_by_id[block_id]
            if (
                block_id in siblings
                and patch.before_block_id is None
                and patch.after_block_id is None
            ):
                continue
            if block_id in siblings:
                siblings.remove(block_id)
            insert_at = len(siblings)
            if patch.before_block_id is not None and patch.before_block_id in siblings:
                insert_at = siblings.index(patch.before_block_id)
            elif patch.after_block_id is not None and patch.after_block_id in siblings:
                insert_at = siblings.index(patch.after_block_id) + 1
            siblings.insert(insert_at, block_id)
        for index, block_id in enumerate(siblings):
            final_order_by_id[block_id] = f"{index + 1:010d}"
            if block_id in existing_blocks:
                touched_existing_order_ids.add(block_id)

    def requested_parent_depth(block_id: UUID) -> int:
        depth = 0
        parent_id = final_parent_by_id.get(block_id)
        while parent_id is not None and parent_id in requested_by_id:
            depth += 1
            parent_id = final_parent_by_id.get(parent_id)
        return depth

    changed = False
    created_blocks: dict[UUID, NoteBlock] = {}

    try:
        for block_id in sorted(
            (block_id for block_id in requested_by_id if block_id not in existing_blocks),
            key=requested_parent_depth,
        ):
            patch = requested_by_id[block_id]
            block = NoteBlock(
                id=patch.id,
                user_id=viewer_id,
                page_id=page.id,
                parent_block_id=final_parent_by_id[patch.id],
                order_key=final_order_by_id[patch.id],
                block_kind=patch.block_kind,
                body_pm_json=patch.body_pm_json,
                body_markdown=markdown_from_pm_json(patch.body_pm_json),
                body_text=text_from_pm_json(patch.body_pm_json),
                collapsed=patch.collapsed,
            )
            db.add(block)
            db.flush()
            _sync_note_body_edges(db, viewer_id, block)
            created_blocks[block.id] = block
            changed = True

        for block_id, patch in requested_by_id.items():
            if block_id not in existing_blocks:
                continue
            block = existing_blocks[block_id]
            block_changed = False
            body_changed = False
            if patch.body_pm_json != block.body_pm_json:
                _set_block_body_pm_json(block, patch.body_pm_json)
                block_changed = True
                body_changed = True
            if patch.block_kind != block.block_kind:
                block.block_kind = patch.block_kind
                block_changed = True
            if patch.collapsed != block.collapsed:
                block.collapsed = patch.collapsed
                block_changed = True
            next_parent_id = final_parent_by_id[block_id]
            if next_parent_id != block.parent_block_id:
                block.parent_block_id = next_parent_id
                block_changed = True
            next_order_key = final_order_by_id[block_id]
            if next_order_key != block.order_key:
                block.order_key = next_order_key
                block_changed = True

            if not block_changed:
                continue
            if body_changed:
                _sync_note_body_edges(db, viewer_id, block)
            block.updated_at = func.now()
            changed = True

        for block_id in touched_existing_order_ids:
            if block_id in requested_by_id or block_id in deleted_ids:
                continue
            block = existing_blocks[block_id]
            if final_order_by_id[block_id] == block.order_key:
                continue
            block.order_key = final_order_by_id[block_id]
            block.updated_at = func.now()
            changed = True

        for block_id in _document_delete_order(existing_blocks, deleted_ids):
            _delete_object_edges(db, "note_block", block_id)
            db.execute(
                delete(PinnedObjectRef).where(
                    PinnedObjectRef.user_id == viewer_id,
                    PinnedObjectRef.object_type == "note_block",
                    PinnedObjectRef.object_id == block_id,
                )
            )
            db.delete(existing_blocks[block_id])
            changed = True

        if changed:
            page.updated_at = func.now()
            enqueue_page_reindex(db, page_id=page.id, reason="page_patch")

        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if _is_note_block_id_conflict(exc):
            raise ConflictError(
                ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists"
            ) from exc
        raise

    db.refresh(page)
    focused_block = None
    if request.focus_block_id is not None:
        focused = created_blocks.get(request.focus_block_id) or db.get(
            NoteBlock, request.focus_block_id
        )
        if focused is not None and focused.user_id == viewer_id and focused.page_id == page.id:
            focused_page_id = focused.page_id
            assert focused_page_id is not None
            focused_block = _block_out(focused, _child_tree(db, focused_page_id, focused.id))

    return PatchPageDocumentResponse(
        client_mutation_id=request.client_mutation_id,
        page=_page_out(db, page),
        focused_block=focused_block,
    )


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    block_ids = [
        row[0] for row in db.execute(select(NoteBlock.id).where(NoteBlock.page_id == page.id))
    ]
    for block_id in block_ids:
        _delete_object_edges(db, "note_block", block_id)
        db.execute(
            delete(PinnedObjectRef).where(
                PinnedObjectRef.user_id == viewer_id,
                PinnedObjectRef.object_type == "note_block",
                PinnedObjectRef.object_id == block_id,
            )
        )
    db.execute(delete(NoteBlock).where(NoteBlock.page_id == page.id))
    _delete_object_edges(db, "page", page.id)
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
    delete_content_index(db, owner=IndexOwner("page", page_id))
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
        page=_page_out(db, page),
    )


def quick_capture_to_daily(
    db: Session,
    viewer_id: UUID,
    *,
    local_date: date,
    request: QuickCaptureRequest,
    time_zone: str = "UTC",
) -> NoteBlockOut:
    page, _stored_time_zone = _resolve_daily_page_with_retry(
        db,
        viewer_id,
        local_date,
        time_zone=time_zone,
    )
    block = _create_note_block_without_commit(
        db,
        viewer_id,
        CreateNoteBlockRequest(
            page_id=page.id,
            body_pm_json=request.body_pm_json,
            body_markdown=request.body_markdown,
        ),
    )
    page.updated_at = func.now()
    enqueue_page_reindex(db, page_id=page.id, reason="quick_capture")
    db.commit()
    db.refresh(block)
    return _block_out(block, [])


def create_note_block(
    db: Session,
    viewer_id: UUID,
    request: CreateNoteBlockRequest,
) -> NoteBlockOut:
    block = _create_note_block_without_commit(db, viewer_id, request)
    db.commit()
    db.refresh(block)
    return _block_out(block, [])


def get_note_block_for_owner_or_404(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlock:
    block = db.get(NoteBlock, block_id)
    if block is None or block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    return block


def get_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlockOut:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    return _block_out(block, _child_tree(db, page_id, block.id))


def update_note_block(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
    request: UpdateNoteBlockRequest,
) -> NoteBlockOut:
    return retry_serializable(
        db,
        "update_note_block",
        lambda: _update_note_block_once(db, viewer_id, block_id, request),
    )


def _update_note_block_once(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
    request: UpdateNoteBlockRequest,
) -> NoteBlockOut:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    changed = False
    body_changed = False
    if request.body_pm_json is not None and request.body_pm_json != block.body_pm_json:
        _set_block_body_pm_json(block, request.body_pm_json)
        changed = True
        body_changed = True
    if request.block_kind is not None and request.block_kind != block.block_kind:
        block.block_kind = request.block_kind
        changed = True
    if request.collapsed is not None and request.collapsed != block.collapsed:
        block.collapsed = request.collapsed
        changed = True
    if changed:
        if body_changed:
            _sync_note_body_edges(db, viewer_id, block)
        block.updated_at = func.now()
        page = db.get(Page, page_id)
        if page is not None:
            page.updated_at = func.now()
        enqueue_page_reindex(db, page_id=page_id, reason="block_update")
    db.commit()
    db.refresh(block)
    return _block_out(block, _child_tree(db, page_id, block.id))


def set_note_block_markdown_body_without_commit(
    db: Session,
    viewer_id: UUID,
    block: NoteBlock,
    body_markdown: str,
) -> None:
    if block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    body_pm_json = pm_doc_from_markdown_projection(body_markdown)
    if body_pm_json != block.body_pm_json:
        block.body_pm_json = body_pm_json
        block.body_markdown = markdown_from_pm_json(body_pm_json)
        block.body_text = text_from_pm_json(body_pm_json)
        block.updated_at = func.now()
        _sync_note_body_edges(db, viewer_id, block)
        page_id = block.page_id
        assert page_id is not None
        enqueue_page_reindex(db, page_id=page_id, reason="block_markdown")


def move_note_block(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
    request: MoveNoteBlockRequest,
) -> NoteBlockOut:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    parent = None
    if request.parent_block_id is not None:
        if request.parent_block_id == block.id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Block cannot be moved under itself")
        parent = get_note_block_for_owner_or_404(db, viewer_id, request.parent_block_id)
        parent_page_id = parent.page_id
        assert parent_page_id is not None
        if parent_page_id != page_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be on the same page")
        if _is_descendant_of(db, parent.id, block.id):
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Block cannot be moved under one of its descendants",
            )
    _validate_position_anchor(
        db,
        page_id=page_id,
        parent_id=parent.id if parent is not None else None,
        before_block_id=request.before_block_id,
        after_block_id=request.after_block_id,
        moving_block_id=block.id,
    )
    block.parent_block_id = parent.id if parent is not None else None
    _insert_block_in_order(db, block, request.before_block_id, request.after_block_id)
    block.updated_at = func.now()
    page = db.get(Page, page_id)
    if page is not None:
        page.updated_at = func.now()
    enqueue_page_reindex(db, page_id=page_id, reason="block_move")
    db.commit()
    db.refresh(block)
    return _block_out(block, _child_tree(db, page_id, block.id))


def split_note_block(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
    request: SplitNoteBlockRequest,
) -> NoteBlockOut:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    before_pm_json, after_pm_json = _split_pm_json(block.body_pm_json, request.offset)
    _set_block_body_pm_json(block, before_pm_json)
    block.updated_at = func.now()
    new_block = NoteBlock(
        user_id=viewer_id,
        page_id=page_id,
        parent_block_id=block.parent_block_id,
        order_key="0000000000",
        block_kind=block.block_kind,
        body_pm_json=after_pm_json,
        body_markdown=markdown_from_pm_json(after_pm_json),
        body_text=text_from_pm_json(after_pm_json),
        collapsed=False,
    )
    db.add(new_block)
    db.flush()
    _insert_block_in_order(db, new_block, None, block.id)
    _copy_highlight_attachments(
        db, viewer_id, source_block_id=block.id, target_block_id=new_block.id
    )
    _sync_note_body_edges(db, viewer_id, block)
    _sync_note_body_edges(db, viewer_id, new_block)
    page = db.get(Page, page_id)
    if page is not None:
        page.updated_at = func.now()
    enqueue_page_reindex(db, page_id=page_id, reason="block_split")
    db.commit()
    db.refresh(new_block)
    return _block_out(new_block, [])


def merge_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlockOut:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    siblings = _siblings(db, page_id, block.parent_block_id)
    index = next((idx for idx, sibling in enumerate(siblings) if sibling.id == block.id), -1)
    if index <= 0:
        return _block_out(block, _child_tree(db, page_id, block.id))
    previous = siblings[index - 1]
    _set_block_body_pm_json(
        previous,
        _merge_pm_json(previous.body_pm_json, block.body_pm_json),
    )
    previous.updated_at = func.now()
    for child in _siblings(db, page_id, block.id):
        child.parent_block_id = previous.id
    _transfer_note_block_relationships(
        db,
        viewer_id,
        source_block_id=block.id,
        target_block_id=previous.id,
    )
    _sync_note_body_edges(db, viewer_id, previous)
    db.delete(block)
    previous_page_id = previous.page_id
    assert previous_page_id is not None
    _renumber_siblings(db, previous_page_id, previous.parent_block_id)
    page = db.get(Page, previous_page_id)
    if page is not None:
        page.updated_at = func.now()
    enqueue_page_reindex(db, page_id=previous_page_id, reason="block_merge")
    db.commit()
    db.refresh(previous)
    return _block_out(previous, _child_tree(db, previous_page_id, previous.id))


def delete_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> None:
    retry_serializable(
        db,
        "delete_note_block",
        lambda: _delete_note_block_once(db, viewer_id, block_id),
    )


def _delete_note_block_once(db: Session, viewer_id: UUID, block_id: UUID) -> None:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    descendant_ids = _descendant_ids(db, block.id)
    for descendant_id in descendant_ids:
        _delete_object_edges(db, "note_block", descendant_id)
        db.execute(
            delete(PinnedObjectRef).where(
                PinnedObjectRef.user_id == viewer_id,
                PinnedObjectRef.object_type == "note_block",
                PinnedObjectRef.object_id == descendant_id,
            )
        )
    _delete_object_edges(db, "note_block", block.id)
    db.execute(
        delete(PinnedObjectRef).where(
            PinnedObjectRef.user_id == viewer_id,
            PinnedObjectRef.object_type == "note_block",
            PinnedObjectRef.object_id == block.id,
        )
    )
    db.execute(delete(NoteBlock).where(NoteBlock.id.in_([block.id, *descendant_ids])))
    _renumber_siblings(db, page_id, block.parent_block_id)
    page = db.get(Page, page_id)
    if page is not None:
        page.updated_at = func.now()
    enqueue_page_reindex(db, page_id=page_id, reason="block_delete")
    db.commit()


def linked_note_blocks_for_highlights(
    db: Session,
    viewer_id: UUID,
    highlight_ids: list[UUID],
) -> dict[UUID, list[NoteBlock]]:
    """Attached notes per highlight: ``origin=highlight_note`` edges (§5.7)."""
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
            ResourceEdge.created_at.asc(),
            # order_key reflects attachment creation order and is stable when
            # edges share a transaction's created_at (the edge id is random).
            NoteBlock.order_key.asc(),
            NoteBlock.id.asc(),
        )
    ).all()
    result: dict[UUID, list[NoteBlock]] = {}
    for highlight_id, block in rows:
        result.setdefault(highlight_id, []).append(block)
    return result


def set_highlight_note_body(
    db: Session,
    viewer_id: UUID,
    highlight_id: UUID,
    body: str,
    *,
    commit: bool = True,
) -> NoteBlock | None:
    highlight = db.get(Highlight, highlight_id)
    if highlight is None or highlight.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Highlight not found")

    existing = _first_highlight_note_block(db, viewer_id, highlight_id)
    normalized = body.strip()
    if not normalized:
        if existing is not None:
            page = db.get(Page, existing.page_id) if existing.page_id is not None else None
            _delete_object_edges(db, "note_block", existing.id)
            db.delete(existing)
            if page is not None:
                page.updated_at = func.now()
                enqueue_page_reindex(db, page_id=page.id, reason="highlight_note")
            if commit:
                db.commit()
        return None

    if existing is None:
        request = CreateNoteBlockRequest(
            body_markdown=normalized,
            linked_object=LinkedObjectRequest(object_type="highlight", object_id=highlight_id),
        )
        block = _create_note_block_without_commit(db, viewer_id, request)
        if commit:
            db.commit()
            db.refresh(block)
        return block

    body_pm_json = pm_doc_from_text(normalized)
    if body_pm_json != existing.body_pm_json:
        existing.body_pm_json = body_pm_json
        existing.body_markdown = normalized
        existing.body_text = normalized
        existing.updated_at = func.now()
        _sync_note_body_edges(db, viewer_id, existing)
        page = db.get(Page, existing.page_id) if existing.page_id is not None else None
        if page is not None:
            page.updated_at = func.now()
            enqueue_page_reindex(db, page_id=page.id, reason="highlight_note")
    if commit:
        db.commit()
        db.refresh(existing)
    return existing


def _create_note_block_without_commit(
    db: Session,
    viewer_id: UUID,
    request: CreateNoteBlockRequest,
) -> NoteBlock:
    page = (
        get_page_for_owner_or_404(db, viewer_id, request.page_id)
        if request.page_id
        else _default_page(db, viewer_id)
    )
    if request.parent_block_id is not None:
        parent = get_note_block_for_owner_or_404(db, viewer_id, request.parent_block_id)
        if parent.page_id != page.id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be on the same page")
    _validate_position_anchor(
        db,
        page_id=page.id,
        parent_id=request.parent_block_id,
        before_block_id=request.before_block_id,
        after_block_id=request.after_block_id,
        moving_block_id=None,
    )
    body_pm_json = request.body_pm_json or pm_doc_from_text(request.body_markdown or "")
    body_text = text_from_pm_json(body_pm_json)
    body_markdown = (
        markdown_from_pm_json(body_pm_json)
        if request.body_pm_json is not None
        else request.body_markdown or ""
    )
    block = NoteBlock(
        id=request.id,
        user_id=viewer_id,
        page_id=page.id,
        parent_block_id=request.parent_block_id,
        order_key="0000000000",
        block_kind=request.block_kind,
        body_pm_json=body_pm_json,
        body_markdown=body_markdown,
        body_text=body_text,
        collapsed=False,
    )
    db.add(block)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists") from exc
    _insert_block_in_order(db, block, request.before_block_id, request.after_block_id)
    if request.linked_object is not None:
        # The quick-note composer's highlight↔note attachment (§5.7): one
        # `origin=highlight_note` edge, flush-only in this transaction.
        # justify-cycle: function-local import — `edges` imports `resolve`,
        # which imports this module for `linked_note_blocks_for_highlights`.
        from nexus.services.resource_graph.edges import create_edge

        create_edge(
            db,
            viewer_id=viewer_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="highlight", id=request.linked_object.object_id),
                target=ResourceRef(scheme="note_block", id=block.id),
                kind="context",
                origin="highlight_note",
            ),
        )
    _sync_note_body_edges(db, viewer_id, block)
    page.updated_at = func.now()
    enqueue_page_reindex(db, page_id=page.id, reason="block_create")
    return block


def _default_page(db: Session, viewer_id: UUID) -> Page:
    page = db.scalar(
        select(Page).where(Page.user_id == viewer_id, Page.title == "Notes").order_by(Page.id.asc())
    )
    if page is not None:
        return page
    page = Page(user_id=viewer_id, title="Notes", description=None)
    db.add(page)
    db.flush()
    enqueue_page_reindex(db, page_id=page.id, reason="page_create")
    return page


def _today_in_time_zone(time_zone: str) -> date:
    try:
        tz = ZoneInfo(time_zone)
    except ZoneInfoNotFoundError as exc:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "time_zone is invalid") from exc
    return datetime.now(tz).date()


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

    # Daily-unique conflicts (a concurrent caller created the page) reload outside the
    # SERIALIZABLE retry; each reload finds the winner's row.
    for attempt in range(3):
        try:
            return retry_serializable(db, "resolve_daily_page", op)
        except IntegrityError as exc:
            db.rollback()
            if not _is_daily_unique_conflict(exc) or attempt == 2:
                raise
    raise AssertionError("Daily note retry loop exhausted")


def _is_daily_unique_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    return constraint_name in {
        "uix_daily_note_pages_user_date",
        "uix_daily_note_pages_user_page",
    }


def _is_note_block_id_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    return constraint_name == "note_blocks_pkey"


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
        description=None,
    )
    db.add(page)
    db.flush()
    db.add(
        DailyNotePage(
            user_id=viewer_id,
            local_date=local_date,
            time_zone=time_zone,
            page_id=page.id,
        )
    )
    enqueue_page_reindex(db, page_id=page.id, reason="daily_page")
    return page, time_zone


def _set_block_body_pm_json(block: NoteBlock, body_pm_json: dict[str, Any]) -> None:
    block.body_pm_json = body_pm_json
    block.body_markdown = markdown_from_pm_json(body_pm_json)
    block.body_text = text_from_pm_json(body_pm_json)


def _split_pm_json(
    body_pm_json: dict[str, object],
    offset: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    before_content: list[object] = []
    after_content: list[object] = []
    remaining = offset

    for child in _pm_content(body_pm_json):
        child_text = _pm_split_text(child)
        child_length = len(child_text)
        if remaining <= 0:
            after_content.append(deepcopy(child))
        elif child_length == 0 or remaining >= child_length:
            before_content.append(deepcopy(child))
            remaining -= child_length
        elif isinstance(child, dict) and child.get("type") == "text":
            text = child_text
            before_text = text[:remaining]
            after_text = text[remaining:]
            if before_text:
                before_node = deepcopy(child)
                before_node["text"] = before_text
                before_content.append(before_node)
            if after_text:
                after_node = deepcopy(child)
                after_node["text"] = after_text
                after_content.append(after_node)
            remaining = 0
        else:
            after_content.append(deepcopy(child))
            remaining = 0

    return (
        _pm_with_content(body_pm_json, before_content),
        _pm_with_content(body_pm_json, after_content),
    )


def _merge_pm_json(
    first_pm_json: dict[str, object],
    second_pm_json: dict[str, object],
) -> dict[str, Any]:
    first_content = [deepcopy(child) for child in _pm_content(first_pm_json)]
    second_content = [deepcopy(child) for child in _pm_content(second_pm_json)]
    if not first_content:
        return deepcopy(second_pm_json)
    if not second_content:
        return deepcopy(first_pm_json)

    first_type = first_pm_json.get("type")
    second_type = second_pm_json.get("type")
    merged_type = first_type if first_type == second_type else "paragraph"
    separator: dict[str, str] = (
        {"type": "text", "text": "\n"} if merged_type == "code_block" else {"type": "hard_break"}
    )
    merged = deepcopy(first_pm_json)
    merged["type"] = merged_type
    merged["content"] = [*first_content, separator, *second_content]
    return merged


def _pm_content(node: dict[str, object]) -> list[object]:
    content = node.get("content")
    return content if isinstance(content, list) else []


def _pm_with_content(node: dict[str, object], content: list[object]) -> dict[str, Any]:
    result = deepcopy(node)
    if content:
        result["content"] = content
    else:
        result.pop("content", None)
    return result


def _pm_split_text(node: object) -> str:
    if isinstance(node, list):
        return "".join(_pm_split_text(child) for child in node)
    if not isinstance(node, dict):
        return ""
    if node.get("type") == "text" and isinstance(node.get("text"), str):
        return str(node["text"])
    if node.get("type") == "hard_break":
        return "\n"
    if node.get("type") in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
        attrs = node["attrs"]
        label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
        return label if isinstance(label, str) else ""
    if node.get("type") == "image" and isinstance(node.get("attrs"), dict):
        alt = node["attrs"].get("alt")
        return alt if isinstance(alt, str) else ""
    return _pm_split_text(node.get("content"))


def _body_target_refs(value: object) -> list[ResourceRef]:
    """Distinct ``object_ref``/``object_embed`` targets in document order.

    The references-vs-embeds distinction and positions are not stored: the body
    itself knows where its refs sit, so the same ref twice in one body is one
    target (§5.7).
    """
    refs: list[ResourceRef] = []
    seen: set[str] = set()

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        if node.get("type") in {"object_ref", "object_embed"} and isinstance(
            node.get("attrs"), dict
        ):
            attrs = node["attrs"]
            object_type = attrs.get("objectType")
            object_id = attrs.get("objectId")
            if isinstance(object_type, str) and isinstance(object_id, str):
                # Validated bodies constrain objectType to OBJECT_TYPES, a
                # subset of ResourceScheme.
                ref = ResourceRef(scheme=cast("ResourceScheme", object_type), id=UUID(object_id))
                if ref.uri not in seen:
                    seen.add(ref.uri)
                    refs.append(ref)
        visit(node.get("content"))

    visit(value)
    return refs


def _sync_note_body_edges(db: Session, viewer_id: UUID, block: NoteBlock) -> None:
    """Replace the block's ``origin=note_body`` edge set from its body refs (§5.7).

    Replace-set scoping by ``(source, origin)`` means user links and the
    highlight attachment are untouched by construction.
    """
    # justify-cycle: function-local import — `edges` imports `resolve`, which
    # imports this module for `linked_note_blocks_for_highlights`.
    from nexus.services.resource_graph.edges import replace_edges_for_origin

    source = ResourceRef(scheme="note_block", id=block.id)
    replace_edges_for_origin(
        db,
        viewer_id=viewer_id,
        source=source,
        origin="note_body",
        edges=[
            EdgeCreate(source=source, target=target, kind="context", origin="note_body")
            for target in _body_target_refs(block.body_pm_json)
        ],
    )


def _copy_highlight_attachments(
    db: Session,
    viewer_id: UUID,
    *,
    source_block_id: UUID,
    target_block_id: UUID,
) -> None:
    """Split keeps both halves attached: copy ``origin=highlight_note`` edges."""
    # justify-cycle: function-local import — `edges` imports `resolve`, which
    # imports this module for `linked_note_blocks_for_highlights`.
    from nexus.services.resource_graph.edges import create_edge

    highlight_ids = db.scalars(
        select(ResourceEdge.source_id)
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "highlight_note",
            ResourceEdge.source_scheme == "highlight",
            ResourceEdge.target_scheme == "note_block",
            ResourceEdge.target_id == source_block_id,
        )
        .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
    ).all()
    for highlight_id in highlight_ids:
        create_edge(
            db,
            viewer_id=viewer_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="highlight", id=highlight_id),
                target=ResourceRef(scheme="note_block", id=target_block_id),
                kind="context",
                origin="highlight_note",
            ),
        )


def _transfer_note_block_relationships(
    db: Session,
    viewer_id: UUID,
    *,
    source_block_id: UUID,
    target_block_id: UUID,
) -> None:
    """Merge moves every edge touching the absorbed block to the surviving one.

    ``repoint_edges`` drops rows that would duplicate an existing bare pair and
    rows that would collapse into a self-edge (an edge directly between the two
    blocks); the surviving block's ``note_body`` set is replace-set right after
    from the merged body, so repointed body edges are recomputed, not trusted.
    """
    # justify-cycle: function-local import — `edges` imports `resolve`, which
    # imports this module for `linked_note_blocks_for_highlights`.
    from nexus.services.resource_graph.edges import repoint_edges

    repoint_edges(
        db,
        viewer_id=viewer_id,
        from_ref=ResourceRef(scheme="note_block", id=source_block_id),
        to_ref=ResourceRef(scheme="note_block", id=target_block_id),
    )


def _page_out(db: Session, page: Page) -> NotePageOut:
    return NotePageOut(
        id=page.id,
        title=page.title,
        description=page.description,
        updated_at=page.updated_at,
        blocks=_child_tree(db, page.id, None),
    )


def _block_out(block: NoteBlock, children: list[NoteBlockOut]) -> NoteBlockOut:
    page_id = block.page_id
    assert page_id is not None
    return NoteBlockOut(
        id=block.id,
        page_id=page_id,
        parent_block_id=block.parent_block_id,
        order_key=block.order_key,
        block_kind=cast(NOTE_BLOCK_KINDS, block.block_kind),
        body_pm_json=block.body_pm_json,
        body_markdown=block.body_markdown,
        body_text=block.body_text,
        collapsed=block.collapsed,
        children=children,
        created_at=block.created_at,
        updated_at=block.updated_at,
    )


def _child_tree(db: Session, page_id: UUID, parent_id: UUID | None) -> list[NoteBlockOut]:
    return [
        _block_out(block, _child_tree(db, page_id, block.id))
        for block in _siblings(db, page_id, parent_id)
    ]


def _siblings(db: Session, page_id: UUID, parent_id: UUID | None) -> list[NoteBlock]:
    parent_clause = (
        NoteBlock.parent_block_id.is_(None)
        if parent_id is None
        else NoteBlock.parent_block_id == parent_id
    )
    return list(
        db.scalars(
            select(NoteBlock)
            .where(NoteBlock.page_id == page_id, parent_clause)
            .order_by(*NOTE_BLOCK_SIBLING_ORDER)
        )
    )


def _insert_block_in_order(
    db: Session,
    block: NoteBlock,
    before_block_id: UUID | None,
    after_block_id: UUID | None,
) -> None:
    page_id = block.page_id
    assert page_id is not None
    _validate_position_anchor(
        db,
        page_id=page_id,
        parent_id=block.parent_block_id,
        before_block_id=before_block_id,
        after_block_id=after_block_id,
        moving_block_id=block.id,
    )
    siblings = [
        sibling
        for sibling in _siblings(db, page_id, block.parent_block_id)
        if sibling.id != block.id
    ]
    insert_at = len(siblings)
    if before_block_id is not None:
        insert_at = next(
            (index for index, sibling in enumerate(siblings) if sibling.id == before_block_id),
            insert_at,
        )
    elif after_block_id is not None:
        insert_at = next(
            (index + 1 for index, sibling in enumerate(siblings) if sibling.id == after_block_id),
            insert_at,
        )
    siblings.insert(insert_at, block)
    for index, sibling in enumerate(siblings):
        sibling.order_key = f"{index + 1:010d}"


def _validate_position_anchor(
    db: Session,
    *,
    page_id: UUID,
    parent_id: UUID | None,
    before_block_id: UUID | None,
    after_block_id: UUID | None,
    moving_block_id: UUID | None,
) -> None:
    if before_block_id is not None and after_block_id is not None:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Specify only one of before_block_id or after_block_id",
        )
    anchor_id = before_block_id or after_block_id
    if anchor_id is None:
        return
    if moving_block_id is not None and anchor_id == moving_block_id:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, "Block cannot be positioned relative to itself"
        )
    anchor = db.scalar(
        select(NoteBlock).where(
            NoteBlock.id == anchor_id,
            NoteBlock.page_id == page_id,
        )
    )
    if anchor is None or anchor.parent_block_id != parent_id:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Position anchor must be a sibling")


def _document_delete_order(
    existing_blocks: dict[UUID, NoteBlock],
    deleted_ids: set[UUID],
) -> list[UUID]:
    return sorted(
        deleted_ids,
        key=lambda block_id: _existing_block_depth(existing_blocks, block_id),
        reverse=True,
    )


def _existing_block_depth(existing_blocks: dict[UUID, NoteBlock], block_id: UUID) -> int:
    depth = 0
    parent_id = existing_blocks[block_id].parent_block_id
    while parent_id is not None and parent_id in existing_blocks:
        depth += 1
        parent_id = existing_blocks[parent_id].parent_block_id
    return depth


def _renumber_siblings(db: Session, page_id: UUID, parent_id: UUID | None) -> None:
    for index, sibling in enumerate(_siblings(db, page_id, parent_id)):
        sibling.order_key = f"{index + 1:010d}"


def _descendant_ids(db: Session, block_id: UUID) -> list[UUID]:
    ids: list[UUID] = []
    for child_id in db.scalars(select(NoteBlock.id).where(NoteBlock.parent_block_id == block_id)):
        ids.append(child_id)
        ids.extend(_descendant_ids(db, child_id))
    return ids


def _is_descendant_of(db: Session, candidate_id: UUID, ancestor_id: UUID) -> bool:
    parent_id = db.scalar(select(NoteBlock.parent_block_id).where(NoteBlock.id == candidate_id))
    while parent_id is not None:
        if parent_id == ancestor_id:
            return True
        parent_id = db.scalar(select(NoteBlock.parent_block_id).where(NoteBlock.id == parent_id))
    return False


def _delete_object_edges(db: Session, scheme: ResourceScheme, object_id: UUID) -> None:
    delete_edges_for_deleted_resource(db, ref=ResourceRef(scheme=scheme, id=object_id))


def _first_highlight_note_block(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> NoteBlock | None:
    return db.scalar(
        select(NoteBlock)
        .join(
            ResourceEdge,
            (ResourceEdge.target_scheme == "note_block") & (ResourceEdge.target_id == NoteBlock.id),
        )
        .where(
            ResourceEdge.user_id == viewer_id,
            ResourceEdge.origin == "highlight_note",
            ResourceEdge.source_scheme == "highlight",
            ResourceEdge.source_id == highlight_id,
        )
        .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc(), NoteBlock.id.asc())
    )
