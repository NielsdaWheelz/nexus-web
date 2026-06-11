"""Page and note-block service."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from datetime import date, datetime
from typing import Any, cast, get_args
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name
from nexus.db.models import (
    DailyNotePage,
    Highlight,
    NoteBlock,
    Page,
    PageDocumentMutation,
    PinnedObjectRef,
    ResourceEdge,
)
from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.schemas.notes import (
    NOTE_BLOCK_KINDS,
    OBJECT_TYPES,
    CreatePageRequest,
    DailyNotePageOut,
    NoteBlockOut,
    NotePageOut,
    NotePageSummaryOut,
    PatchPageDocumentRequest,
    PatchPageDocumentResponse,
    QuickCaptureRequest,
    UpdatePageRequest,
)
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.highlight_access import get_highlight_for_visible_read_or_404
from nexus.services.note_indexing import enqueue_page_reindex
from nexus.services.resource_graph import documents as graph_documents
from nexus.services.resource_graph import tags as graph_tags
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
from nexus.services.resource_graph.edges import create_edge
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
    *,
    after_apply: Callable[[], list[UUID]] | None = None,
) -> PatchPageDocumentResponse:
    return retry_serializable(
        db,
        "patch_page_document",
        lambda: _patch_page_document_once(
            db,
            viewer_id,
            page_id,
            request,
            after_apply=after_apply,
        ),
    )


def _patch_page_document_once(
    db: Session,
    viewer_id: UUID,
    page_id: UUID,
    request: PatchPageDocumentRequest,
    *,
    after_apply: Callable[[], list[UUID]] | None = None,
) -> PatchPageDocumentResponse:
    request_hash = _page_document_request_hash(request)
    page = db.scalar(select(Page).where(Page.id == page_id, Page.user_id == viewer_id))
    if page is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")

    replay = db.scalar(
        select(PageDocumentMutation).where(
            PageDocumentMutation.user_id == viewer_id,
            PageDocumentMutation.page_id == page.id,
            PageDocumentMutation.client_mutation_id == request.client_mutation_id,
        )
    )
    if replay is not None:
        if replay.request_hash != request_hash:
            raise ConflictError(
                ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
                "Document mutation id was reused with a different request",
            )
        return PatchPageDocumentResponse.model_validate(replay.response_json)

    if request.base_document_version != page.document_version:
        latest_page = _page_out(db, page)
        raise ConflictError(
            ApiErrorCode.E_NOTE_CONFLICT,
            "Page document version is stale",
            details={
                "latestDocument": {
                    "documentVersion": page.document_version,
                    "page": latest_page.model_dump(mode="json", by_alias=True),
                }
            },
        )

    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
    existing_nodes = {node.block.id: node for node in _flatten_document_nodes(document.roots)}
    existing_blocks = {block_id: node.block for block_id, node in existing_nodes.items()}
    existing_parent_by_id = {
        block_id: None if node.parent.scheme == "page" else node.parent.id
        for block_id, node in existing_nodes.items()
    }
    existing_order_by_id = {
        block_id: node.source_order_key for block_id, node in existing_nodes.items()
    }
    existing_collapsed_by_id = {
        block_id: node.collapsed for block_id, node in existing_nodes.items()
    }
    requested_by_id = {block.id: block for block in request.blocks}
    requested_ids = set(requested_by_id)
    deleted_ids = set(request.deleted_block_ids)

    if request.focus_block_id is not None:
        if (
            request.focus_block_id not in requested_ids
            and request.focus_block_id not in deleted_ids
        ):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    for block_id in request.deleted_block_ids:
        if block_id not in existing_blocks:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    for block_id in list(deleted_ids):
        deleted_ids.update(
            descendant_id
            for descendant_id in _document_descendant_ids(existing_nodes[block_id])
            if descendant_id in existing_blocks and descendant_id not in requested_ids
        )
    deleted_ids.update(set(existing_blocks) - requested_ids)

    for patch in request.blocks:
        block = existing_blocks.get(patch.id)
        if block is None:
            if db.get(NoteBlock, patch.id) is not None:
                raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists")

    requested_parent_by_id: dict[UUID, UUID | None] = {}
    requested_order_by_id: dict[UUID, str] = {}
    requested_collapsed_by_id: dict[UUID, bool] = {}
    requested_children_by_parent: dict[ResourceRef, list[graph_documents.OrderedChildBlock]] = {}

    for group in request.containment:
        parent = ResourceRef(scheme=cast("ResourceScheme", group.parent.scheme), id=group.parent.id)
        if parent.scheme == "page":
            if parent.id != page.id:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST, "Document root page does not match route"
                )
        elif parent.id not in requested_ids:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be in the document command")
        requested_children_by_parent[parent] = [
            graph_documents.OrderedChildBlock(
                block_id=child.block_id,
                source_order_key=child.source_order_key,
            )
            for child in group.children
        ]
        for child in group.children:
            requested_parent_by_id[child.block_id] = None if parent.scheme == "page" else parent.id
            requested_order_by_id[child.block_id] = child.source_order_key
            requested_collapsed_by_id[child.block_id] = child.collapsed

    for block_id, parent_id in requested_parent_by_id.items():
        if parent_id == block_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Block cannot be moved under itself")

    for block_id in requested_parent_by_id:
        seen: set[UUID] = set()
        parent_id = requested_parent_by_id[block_id]
        while parent_id is not None:
            if parent_id == block_id or parent_id in seen:
                raise ApiError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Block cannot be moved under one of its descendants",
                )
            seen.add(parent_id)
            parent_id = requested_parent_by_id.get(parent_id)

    def requested_parent_depth(block_id: UUID) -> int:
        depth = 0
        parent_id = requested_parent_by_id.get(block_id)
        while parent_id is not None and parent_id in requested_by_id:
            depth += 1
            parent_id = requested_parent_by_id.get(parent_id)
        return depth

    title_changed = request.title is not None and request.title != page.title
    changed_block_ids: set[UUID] = set(deleted_ids)
    for block_id, patch in requested_by_id.items():
        block = existing_blocks.get(block_id)
        if block is None:
            changed_block_ids.add(block_id)
            continue
        if (
            patch.body_pm_json != block.body_pm_json
            or patch.block_kind != block.block_kind
            or requested_parent_by_id[block_id] != existing_parent_by_id[block_id]
            or requested_order_by_id[block_id] != existing_order_by_id[block_id]
            or requested_collapsed_by_id[block_id] != existing_collapsed_by_id[block_id]
        ):
            changed_block_ids.add(block_id)

    changed = title_changed or bool(changed_block_ids)
    changed_edge_ids: list[UUID] = []

    try:
        if changed:
            if title_changed and request.title is not None:
                page.title = request.title

            for block_id in sorted(
                (block_id for block_id in requested_by_id if block_id not in existing_blocks),
                key=requested_parent_depth,
            ):
                patch = requested_by_id[block_id]
                block = NoteBlock(
                    id=patch.id,
                    user_id=viewer_id,
                    block_kind=patch.block_kind,
                    body_pm_json=patch.body_pm_json,
                    body_markdown=markdown_from_pm_json(patch.body_pm_json),
                    body_text=text_from_pm_json(patch.body_pm_json),
                )
                db.add(block)
                db.flush()
                _sync_note_body_edges(db, viewer_id, block)

            for block_id, patch in requested_by_id.items():
                if block_id not in existing_blocks:
                    continue
                block = existing_blocks[block_id]
                body_changed = patch.body_pm_json != block.body_pm_json
                if body_changed:
                    _set_block_body_pm_json(block, patch.body_pm_json)
                    _sync_note_body_edges(db, viewer_id, block)
                if patch.block_kind != block.block_kind:
                    block.block_kind = patch.block_kind
                if block_id in changed_block_ids:
                    block.updated_at = func.now()

            changed_edge_ids.extend(
                graph_documents.apply_page_document_structure(
                    db,
                    user_id=viewer_id,
                    previous_parents={node.parent for node in existing_nodes.values()},
                    children_by_parent=requested_children_by_parent,
                    collapsed_by_block_id=requested_collapsed_by_id,
                    deleted_block_ids=deleted_ids,
                )
            )
            for block_id in _document_delete_order(existing_parent_by_id, deleted_ids):
                _delete_object_edges(db, "note_block", block_id)
                db.execute(
                    delete(PinnedObjectRef).where(
                        PinnedObjectRef.user_id == viewer_id,
                        PinnedObjectRef.object_type == "note_block",
                        PinnedObjectRef.object_id == block_id,
                    )
                )
                db.delete(existing_blocks[block_id])

            if after_apply is not None:
                changed_edge_ids.extend(after_apply())

            page.updated_at = func.now()
            page.document_version += 1
            enqueue_page_reindex(db, page_id=page.id, reason="page_patch")

        focused_block = None
        if request.focus_block_id is not None and request.focus_block_id not in deleted_ids:
            focused_block = get_note_block(db, viewer_id, request.focus_block_id)

        response = PatchPageDocumentResponse(
            client_mutation_id=request.client_mutation_id,
            page=_page_out(db, page),
            document_version=page.document_version,
            changed_block_ids=sorted(changed_block_ids, key=str),
            changed_edge_ids=changed_edge_ids,
            focused_block=focused_block,
        )
        db.add(
            PageDocumentMutation(
                user_id=viewer_id,
                page_id=page.id,
                client_mutation_id=request.client_mutation_id,
                request_hash=request_hash,
                base_document_version=request.base_document_version,
                document_version=page.document_version,
                response_json=response.model_dump(mode="json", by_alias=True),
            )
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if _is_note_block_id_conflict(exc):
            raise ConflictError(
                ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists"
            ) from exc
        raise

    return response


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    block_ids = graph_documents.list_page_block_ids(db, user_id=viewer_id, page_id=page.id)
    for block_id in block_ids:
        _delete_object_edges(db, "note_block", block_id)
        db.execute(
            delete(PinnedObjectRef).where(
                PinnedObjectRef.user_id == viewer_id,
                PinnedObjectRef.object_type == "note_block",
                PinnedObjectRef.object_id == block_id,
            )
        )
    graph_documents.delete_view_state_for_blocks(db, user_id=viewer_id, block_ids=set(block_ids))
    db.execute(delete(NoteBlock).where(NoteBlock.id.in_(block_ids)))
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
    db.execute(
        delete(PageDocumentMutation).where(
            PageDocumentMutation.user_id == viewer_id,
            PageDocumentMutation.page_id == page.id,
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
    block_id = request.id
    body_pm_json = request.body_pm_json or pm_doc_from_text(request.body_markdown or "")
    replay = db.scalar(
        select(PageDocumentMutation).where(
            PageDocumentMutation.user_id == viewer_id,
            PageDocumentMutation.page_id == page.id,
            PageDocumentMutation.client_mutation_id == request.client_mutation_id,
        )
    )
    if replay is not None:
        response = PatchPageDocumentResponse.model_validate(replay.response_json)
        focused = response.focused_block
        if focused is not None and focused.id == block_id and focused.body_pm_json == body_pm_json:
            return focused
        raise ConflictError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Quick capture mutation id was reused with a different request",
        )

    existing = db.get(NoteBlock, block_id)
    if existing is not None:
        if existing.user_id != viewer_id:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists")
        try:
            occurrence = graph_documents.find_block_occurrence(
                db, user_id=viewer_id, block_id=block_id
            )
        except NotFoundError as exc:
            raise ConflictError(
                ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists"
            ) from exc
        if occurrence.page_id != page.id:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists")
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
    blocks: list[dict[str, object]] = []
    containment_by_parent: dict[ResourceRef, list[dict[str, object]]] = {}

    def append_node(node: graph_documents.DocumentBlock) -> None:
        node_body = body_pm_json if node.block.id == block_id else node.block.body_pm_json
        blocks.append(
            {
                "id": node.block.id,
                "block_kind": node.block.block_kind,
                "body_pm_json": node_body,
            }
        )
        containment_by_parent.setdefault(node.parent, []).append(
            {
                "block_id": node.block.id,
                "source_order_key": node.source_order_key,
                "collapsed": node.collapsed,
            }
        )
        for child in node.children:
            append_node(child)

    for root in document.roots:
        append_node(root)

    if existing is None:
        blocks.append(
            {
                "id": block_id,
                "block_kind": "bullet",
                "body_pm_json": body_pm_json,
            }
        )
        containment_by_parent.setdefault(ResourceRef(scheme="page", id=page.id), []).append(
            {
                "block_id": block_id,
                "source_order_key": f"{len(document.roots) + 1:010d}",
                "collapsed": False,
            }
        )

    patch_page_document(
        db,
        viewer_id,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id=request.client_mutation_id,
            base_document_version=page.document_version,
            focus_block_id=block_id,
            blocks=blocks,
            containment=[
                {
                    "parent": {"scheme": parent.scheme, "id": parent.id},
                    "children": children,
                }
                for parent, children in containment_by_parent.items()
            ],
            deleted_block_ids=[],
        ),
    )
    return get_note_block(db, viewer_id, block_id)


def get_note_block_for_owner_or_404(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlock:
    block = db.get(NoteBlock, block_id)
    if block is None or block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    return block


def get_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> NoteBlockOut:
    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=block_id)
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=occurrence.page_id)
    node = graph_documents.find_document_block(document, block_id)
    if node is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    return _document_block_out(node, occurrence.page_id)


def set_highlight_note_body_pm_json(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    block_id: UUID,
    body_pm_json: dict[str, Any],
    client_mutation_id: str,
) -> NoteBlockOut:
    _get_visible_highlight_or_404(db, viewer_id, highlight_id)

    existing = _first_highlight_note_block(db, viewer_id, highlight_id)
    if existing is not None and existing.id != block_id:
        raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Highlight note block id mismatch")
    if existing is not None and existing.body_pm_json == body_pm_json:
        return get_note_block(db, viewer_id, existing.id)

    if existing is None:
        if db.get(NoteBlock, block_id) is not None:
            raise ConflictError(ApiErrorCode.E_NOTE_CONFLICT, "Note block id already exists")
        page = _default_page(db, viewer_id)
        document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
        blocks, containment, deleted_block_ids = _page_document_command_from_document(
            document,
            append_root=(block_id, "bullet", body_pm_json),
        )

        def attach_highlight_note_edge() -> list[UUID]:
            edge = create_edge(
                db,
                viewer_id=viewer_id,
                input=EdgeCreate(
                    source=ResourceRef(scheme="highlight", id=highlight_id),
                    target=ResourceRef(scheme="note_block", id=block_id),
                    kind="context",
                    origin="highlight_note",
                ),
            )
            return [edge.id]

        result = patch_page_document(
            db,
            viewer_id,
            page.id,
            PatchPageDocumentRequest(
                client_mutation_id=client_mutation_id,
                base_document_version=page.document_version,
                focus_block_id=block_id,
                blocks=blocks,
                containment=containment,
                deleted_block_ids=deleted_block_ids,
            ),
            after_apply=attach_highlight_note_edge,
        )
        if result.focused_block is not None:
            return result.focused_block
        return get_note_block(db, viewer_id, block_id)

    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=existing.id)
    page = get_page_for_owner_or_404(db, viewer_id, occurrence.page_id)
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
    blocks, containment, deleted_block_ids = _page_document_command_from_document(
        document,
        body_updates={existing.id: body_pm_json},
    )
    result = patch_page_document(
        db,
        viewer_id,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id=client_mutation_id,
            base_document_version=page.document_version,
            focus_block_id=existing.id,
            blocks=blocks,
            containment=containment,
            deleted_block_ids=deleted_block_ids,
        ),
    )
    if result.focused_block is not None:
        return result.focused_block
    return get_note_block(db, viewer_id, existing.id)


def delete_highlight_note(
    db: Session,
    viewer_id: UUID,
    *,
    highlight_id: UUID,
    note_block_id: UUID | None,
    client_mutation_id: str,
) -> None:
    _get_visible_highlight_or_404(db, viewer_id, highlight_id)

    existing = _first_highlight_note_block(db, viewer_id, highlight_id)
    if existing is None:
        return
    if note_block_id is not None and existing.id != note_block_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=existing.id)
    page = get_page_for_owner_or_404(db, viewer_id, occurrence.page_id)
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page.id)
    blocks, containment, deleted_block_ids = _page_document_command_from_document(
        document,
        delete_root_ids={existing.id},
    )
    patch_page_document(
        db,
        viewer_id,
        page.id,
        PatchPageDocumentRequest(
            client_mutation_id=client_mutation_id,
            base_document_version=page.document_version,
            focus_block_id=None,
            blocks=blocks,
            containment=containment,
            deleted_block_ids=deleted_block_ids,
        ),
    )


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


def _body_target_refs(db: Session, viewer_id: UUID, value: object) -> list[ResourceRef]:
    """Distinct ``object_ref``/``object_embed``/``#tag`` targets in document order.

    The references-vs-embeds distinction and positions are not stored: the body
    itself knows where its refs sit, so the same ref twice in one body is one
    target (§5.7).
    """
    refs: list[ResourceRef] = []
    seen: set[str] = set()

    def append_ref(ref: ResourceRef) -> None:
        if ref.uri in seen:
            return
        seen.add(ref.uri)
        refs.append(ref)

    def visit(node: object, *, in_code: bool = False) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child, in_code=in_code)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text" and isinstance(node.get("text"), str) and not in_code:
            for name in graph_tags.tag_names_from_text(str(node["text"])):
                append_ref(graph_tags.ref_for_tag_name(db, viewer_id=viewer_id, name=name))
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
                append_ref(ref)
        visit(node.get("content"), in_code=in_code or node_type == "code_block")

    visit(value)
    return refs


def _sync_note_body_edges(db: Session, viewer_id: UUID, block: NoteBlock) -> None:
    """Replace the block's ``origin=note_body`` edge set from its body refs (§5.7).

    Replace-set scoping by ``(source, origin)`` means user links and the
    highlight attachment are untouched by construction.
    """
    graph_documents.sync_block_body_edges(
        db,
        user_id=viewer_id,
        block_id=block.id,
        parsed_refs=_body_target_refs(db, viewer_id, block.body_pm_json),
    )


def _page_out(db: Session, page: Page) -> NotePageOut:
    document = graph_documents.load_page_document(db, user_id=page.user_id, page_id=page.id)
    return NotePageOut(
        id=page.id,
        title=page.title,
        description=page.description,
        document_version=page.document_version,
        updated_at=page.updated_at,
        blocks=[_document_block_out(node, page.id) for node in document.roots],
    )


def _page_document_request_hash(request: PatchPageDocumentRequest) -> str:
    payload = request.model_dump(mode="json", by_alias=True)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _document_block_out(node: graph_documents.DocumentBlock, page_id: UUID) -> NoteBlockOut:
    return NoteBlockOut(
        id=node.block.id,
        page_id=page_id,
        parent_block_id=node.parent.id if node.parent.scheme == "note_block" else None,
        order_key=node.source_order_key,
        block_kind=cast(NOTE_BLOCK_KINDS, node.block.block_kind),
        body_pm_json=node.block.body_pm_json,
        body_markdown=node.block.body_markdown,
        body_text=node.block.body_text,
        collapsed=node.collapsed,
        children=[_document_block_out(child, page_id) for child in node.children],
        created_at=node.block.created_at,
        updated_at=node.block.updated_at,
    )


def _flatten_document_nodes(
    nodes: list[graph_documents.DocumentBlock],
) -> list[graph_documents.DocumentBlock]:
    out: list[graph_documents.DocumentBlock] = []

    def visit(node: graph_documents.DocumentBlock) -> None:
        out.append(node)
        for child in node.children:
            visit(child)

    for node in nodes:
        visit(node)
    return out


def _page_document_command_from_document(
    document: graph_documents.PageDocument,
    *,
    body_updates: dict[UUID, dict[str, Any]] | None = None,
    append_root: tuple[UUID, NOTE_BLOCK_KINDS, dict[str, Any]] | None = None,
    delete_root_ids: set[UUID] | None = None,
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[UUID]]:
    updates = body_updates or {}
    delete_roots = delete_root_ids or set()
    existing_nodes = {node.block.id: node for node in _flatten_document_nodes(document.roots)}
    for block_id in updates:
        if block_id not in existing_nodes:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    for block_id in delete_roots:
        if block_id not in existing_nodes:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    deleted_ids: set[UUID] = set()
    for block_id in delete_roots:
        deleted_ids.add(block_id)
        deleted_ids.update(_document_descendant_ids(existing_nodes[block_id]))

    blocks: list[dict[str, object]] = []
    containment_by_parent: dict[ResourceRef, list[dict[str, object]]] = {}

    def append_node(node: graph_documents.DocumentBlock) -> None:
        if node.block.id in deleted_ids:
            return
        blocks.append(
            {
                "id": node.block.id,
                "block_kind": node.block.block_kind,
                "body_pm_json": updates.get(node.block.id, node.block.body_pm_json),
            }
        )
        containment_by_parent.setdefault(node.parent, []).append(
            {
                "block_id": node.block.id,
                "source_order_key": node.source_order_key,
                "collapsed": node.collapsed,
            }
        )
        for child in node.children:
            append_node(child)

    for root in document.roots:
        append_node(root)

    if append_root is not None:
        block_id, block_kind, body_pm_json = append_root
        blocks.append(
            {
                "id": block_id,
                "block_kind": block_kind,
                "body_pm_json": body_pm_json,
            }
        )
        root_ref = ResourceRef(scheme="page", id=document.page.id)
        root_children = containment_by_parent.setdefault(root_ref, [])
        root_children.append(
            {
                "block_id": block_id,
                "source_order_key": f"{len(root_children) + 1:010d}",
                "collapsed": False,
            }
        )

    return (
        blocks,
        [
            {
                "parent": {"scheme": parent.scheme, "id": parent.id},
                "children": children,
            }
            for parent, children in containment_by_parent.items()
            if children
        ],
        sorted(delete_roots, key=str),
    )


def _document_descendant_ids(node: graph_documents.DocumentBlock) -> list[UUID]:
    ids: list[UUID] = []
    for child in node.children:
        ids.append(child.block.id)
        ids.extend(_document_descendant_ids(child))
    return ids


def _document_delete_order(
    parent_by_id: dict[UUID, UUID | None],
    deleted_ids: set[UUID],
) -> list[UUID]:
    return sorted(
        deleted_ids,
        key=lambda block_id: _existing_block_depth(parent_by_id, block_id),
        reverse=True,
    )


def _existing_block_depth(parent_by_id: dict[UUID, UUID | None], block_id: UUID) -> int:
    depth = 0
    parent_id = parent_by_id[block_id]
    while parent_id is not None and parent_id in parent_by_id:
        depth += 1
        parent_id = parent_by_id[parent_id]
    return depth


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


def _get_visible_highlight_or_404(db: Session, viewer_id: UUID, highlight_id: UUID) -> Highlight:
    return get_highlight_for_visible_read_or_404(db, viewer_id, highlight_id)
