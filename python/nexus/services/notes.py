"""Page and note-block service."""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any, cast
from uuid import UUID

from sqlalchemy import case, delete, func, select
from sqlalchemy.orm import Session

from nexus.db.models import Highlight, MessageContextItem, NoteBlock, ObjectLink, Page
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import (
    NOTE_BLOCK_KINDS,
    OBJECT_TYPE_VALUES,
    OBJECT_TYPES,
    CreateNoteBlockRequest,
    CreatePageRequest,
    LinkedObjectRequest,
    MoveNoteBlockRequest,
    NoteBlockOut,
    NotePageOut,
    NotePageSummaryOut,
    ObjectRef,
    SplitNoteBlockRequest,
    UpdateNoteBlockRequest,
    UpdatePageRequest,
)
from nexus.services.object_refs import hydrate_object_ref

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
        if object_type not in OBJECT_TYPE_VALUES:
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
        if node.get("type") == "object_ref" and isinstance(node.get("attrs"), dict):
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
        if node_type == "object_ref" and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            object_type = attrs.get("objectType")
            object_id = attrs.get("objectId")
            label = attrs.get("label")
            if isinstance(object_type, str) and isinstance(object_id, str):
                suffix = f"|{label}" if isinstance(label, str) and label else ""
                parts.append(f"[[{object_type}:{object_id}{suffix}]]")
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
    if request.title is not None:
        page.title = request.title
    if "description" in request.model_fields_set:
        page.description = request.description
    page.updated_at = func.now()
    db.commit()
    db.refresh(page)
    return _page_out(db, page)


def delete_page(db: Session, viewer_id: UUID, page_id: UUID) -> None:
    page = get_page_for_owner_or_404(db, viewer_id, page_id)
    block_ids = [
        row[0] for row in db.execute(select(NoteBlock.id).where(NoteBlock.page_id == page.id))
    ]
    for block_id in block_ids:
        _delete_object_edges(db, "note_block", block_id)
    db.execute(delete(NoteBlock).where(NoteBlock.page_id == page.id))
    _delete_object_edges(db, "page", page.id)
    db.delete(page)
    db.commit()


def create_note_block(
    db: Session,
    viewer_id: UUID,
    request: CreateNoteBlockRequest,
) -> NoteBlockOut:
    page = (
        get_page_for_owner_or_404(db, viewer_id, request.page_id)
        if request.page_id
        else _default_page(db, viewer_id)
    )
    parent = None
    if request.parent_block_id is not None:
        parent = get_note_block_for_owner_or_404(db, viewer_id, request.parent_block_id)
        parent_page_id = parent.page_id
        assert parent_page_id is not None
        if parent_page_id != page.id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be on the same page")
    _validate_position_anchor(
        db,
        page_id=page.id,
        parent_id=parent.id if parent is not None else None,
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
        parent_block_id=parent.id if parent is not None else None,
        order_key="0000000000",
        block_kind=request.block_kind,
        body_pm_json=body_pm_json,
        body_markdown=body_markdown,
        body_text=body_text,
        collapsed=False,
    )
    db.add(block)
    db.flush()
    _insert_block_in_order(db, block, request.before_block_id, request.after_block_id)

    if request.linked_object is not None:
        linked = request.linked_object
        hydrate_object_ref(
            db,
            viewer_id,
            ObjectRef(object_type=linked.object_type, object_id=linked.object_id),
        )
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type=linked.relation_type,
                a_type="note_block",
                a_id=block.id,
                b_type=linked.object_type,
                b_id=linked.object_id,
                a_order_key=None,
                b_order_key=None,
                a_locator_json=None,
                b_locator_json=None,
                metadata_json={},
            )
        )
    _sync_inline_reference_links(db, viewer_id, block)

    page.updated_at = func.now()
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
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    if request.body_pm_json is not None:
        block.body_pm_json = request.body_pm_json
        block.body_text = text_from_pm_json(request.body_pm_json)
        block.body_markdown = markdown_from_pm_json(request.body_pm_json)
        _sync_inline_reference_links(db, viewer_id, block)
    if request.block_kind is not None:
        block.block_kind = request.block_kind
    if request.collapsed is not None:
        block.collapsed = request.collapsed
    block.updated_at = func.now()
    page = db.get(Page, page_id)
    if page is not None:
        page.updated_at = func.now()
    db.commit()
    db.refresh(block)
    return _block_out(block, _child_tree(db, page_id, block.id))


def set_note_block_plain_text_body_without_commit(
    db: Session,
    viewer_id: UUID,
    block: NoteBlock,
    body: str,
) -> None:
    if block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    _set_block_body_pm_json(block, pm_doc_from_text(body))
    block.updated_at = func.now()
    _sync_inline_reference_links(db, viewer_id, block)


def set_note_block_markdown_body_without_commit(
    db: Session,
    viewer_id: UUID,
    block: NoteBlock,
    body_markdown: str,
) -> None:
    if block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    body_pm_json = pm_doc_from_markdown_projection(body_markdown)
    block.body_pm_json = body_pm_json
    block.body_markdown = markdown_from_pm_json(body_pm_json)
    block.body_text = text_from_pm_json(body_pm_json)
    block.updated_at = func.now()
    _sync_inline_reference_links(db, viewer_id, block)


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
    _copy_split_note_about_links(
        db, viewer_id, source_block_id=block.id, target_block_id=new_block.id
    )
    _sync_inline_reference_links(db, viewer_id, block)
    _sync_inline_reference_links(db, viewer_id, new_block)
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
    for child in _children(db, page_id, block.id):
        child.parent_block_id = previous.id
    _transfer_note_block_relationships(
        db,
        viewer_id,
        source_block_id=block.id,
        target_block_id=previous.id,
    )
    _sync_inline_reference_links(db, viewer_id, previous)
    db.delete(block)
    previous_page_id = previous.page_id
    assert previous_page_id is not None
    _renumber_siblings(db, previous_page_id, previous.parent_block_id)
    db.commit()
    db.refresh(previous)
    return _block_out(previous, _child_tree(db, previous_page_id, previous.id))


def delete_note_block(db: Session, viewer_id: UUID, block_id: UUID) -> None:
    block = get_note_block_for_owner_or_404(db, viewer_id, block_id)
    page_id = block.page_id
    assert page_id is not None
    descendant_ids = _descendant_ids(db, block.id)
    for descendant_id in descendant_ids:
        _delete_object_edges(db, "note_block", descendant_id)
    _delete_object_edges(db, "note_block", block.id)
    db.execute(delete(NoteBlock).where(NoteBlock.id.in_([block.id, *descendant_ids])))
    _renumber_siblings(db, page_id, block.parent_block_id)
    db.commit()


def linked_note_blocks_for_highlights(
    db: Session,
    viewer_id: UUID,
    highlight_ids: list[UUID],
) -> dict[UUID, list[NoteBlock]]:
    if not highlight_ids:
        return {}
    highlight_id = case(
        (ObjectLink.a_type == "highlight", ObjectLink.a_id),
        else_=ObjectLink.b_id,
    )
    endpoint_order = case(
        (ObjectLink.a_type == "highlight", ObjectLink.a_order_key),
        else_=ObjectLink.b_order_key,
    )
    rows = db.execute(
        select(highlight_id, NoteBlock)
        .join(
            NoteBlock,
            (
                ((ObjectLink.a_type == "note_block") & (NoteBlock.id == ObjectLink.a_id))
                | ((ObjectLink.b_type == "note_block") & (NoteBlock.id == ObjectLink.b_id))
            ),
        )
        .where(
            ObjectLink.user_id == viewer_id,
            ObjectLink.relation_type == "note_about",
            NoteBlock.user_id == viewer_id,
            (
                (
                    (ObjectLink.a_type == "note_block")
                    & (ObjectLink.b_type == "highlight")
                    & (ObjectLink.b_id.in_(highlight_ids))
                )
                | (
                    (ObjectLink.a_type == "highlight")
                    & (ObjectLink.a_id.in_(highlight_ids))
                    & (ObjectLink.b_type == "note_block")
                )
            ),
        )
        .order_by(
            highlight_id.asc(),
            endpoint_order.asc().nullsfirst(),
            ObjectLink.created_at.asc(),
            ObjectLink.id.asc(),
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
            _delete_object_edges(db, "note_block", existing.id)
            db.delete(existing)
            if commit:
                db.commit()
        return None

    if existing is None:
        request = CreateNoteBlockRequest(
            body_markdown=normalized,
            linked_object=LinkedObjectRequest(
                object_type="highlight",
                object_id=highlight_id,
                relation_type="note_about",
            ),
        )
        block = _create_note_block_without_commit(db, viewer_id, request)
        if commit:
            db.commit()
            db.refresh(block)
        return block

    existing.body_pm_json = pm_doc_from_text(normalized)
    existing.body_markdown = normalized
    existing.body_text = normalized
    existing.updated_at = func.now()
    _sync_inline_reference_links(db, viewer_id, existing)
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
    db.flush()
    _insert_block_in_order(db, block, request.before_block_id, request.after_block_id)
    if request.linked_object is not None:
        linked = request.linked_object
        hydrate_object_ref(
            db,
            viewer_id,
            ObjectRef(object_type=linked.object_type, object_id=linked.object_id),
        )
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type=linked.relation_type,
                a_type="note_block",
                a_id=block.id,
                b_type=linked.object_type,
                b_id=linked.object_id,
                metadata_json={},
            )
        )
    _sync_inline_reference_links(db, viewer_id, block)
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
    return page


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
    if node.get("type") == "object_ref" and isinstance(node.get("attrs"), dict):
        attrs = node["attrs"]
        label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
        return label if isinstance(label, str) else ""
    if node.get("type") == "image" and isinstance(node.get("attrs"), dict):
        alt = node["attrs"].get("alt")
        return alt if isinstance(alt, str) else ""
    return _pm_split_text(node.get("content"))


def _inline_object_refs_from_pm_json(value: object) -> list[tuple[ObjectRef, dict[str, Any]]]:
    refs: list[tuple[ObjectRef, dict[str, Any]]] = []
    target_counts: dict[tuple[str, UUID], int] = {}

    def visit(node: object, path: list[int]) -> None:
        if isinstance(node, list):
            for index, child in enumerate(node):
                visit(child, [*path, index])
            return
        if not isinstance(node, dict):
            return
        if node.get("type") == "object_ref" and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            object_type = attrs.get("objectType")
            object_id = attrs.get("objectId")
            if isinstance(object_type, str) and isinstance(object_id, str):
                ref = ObjectRef(
                    object_type=cast(OBJECT_TYPES, object_type),
                    object_id=UUID(object_id),
                )
                key = (ref.object_type, ref.object_id)
                target_occurrence = target_counts.get(key, 0)
                target_counts[key] = target_occurrence + 1
                refs.append(
                    (
                        ref,
                        {
                            "kind": "note_inline_object_ref",
                            "path": path,
                            "occurrence": len(refs),
                            "target_occurrence": target_occurrence,
                        },
                    )
                )
        visit(node.get("content"), path)

    visit(value, [])
    return refs


def _sync_inline_reference_links(db: Session, viewer_id: UUID, block: NoteBlock) -> None:
    next_refs = _inline_object_refs_from_pm_json(block.body_pm_json)
    existing_links = list(
        db.scalars(
            select(ObjectLink).where(
                ObjectLink.user_id == viewer_id,
                ObjectLink.relation_type == "references",
                (
                    ((ObjectLink.a_type == "note_block") & (ObjectLink.a_id == block.id))
                    | ((ObjectLink.b_type == "note_block") & (ObjectLink.b_id == block.id))
                ),
            )
        )
    )
    unlocated_targets = {
        (link.b_type, link.b_id)
        if link.a_type == "note_block" and link.a_id == block.id
        else (link.a_type, link.a_id)
        for link in existing_links
        if link.a_locator_json is None and link.b_locator_json is None
    }
    kept_indexes: set[int] = set()
    for link in existing_links:
        if link.a_type != "note_block" or link.a_id != block.id:
            continue
        if not _is_managed_inline_reference_link(link):
            continue
        matched_index = None
        for index, (ref, locator) in enumerate(next_refs):
            if index in kept_indexes:
                continue
            if link.b_type != ref.object_type or link.b_id != ref.object_id:
                continue
            if link.a_locator_json is None or link.a_locator_json == locator:
                matched_index = index
                break
        if matched_index is None:
            db.delete(link)
            continue
        kept_indexes.add(matched_index)
        link.a_order_key = f"{matched_index + 1:010d}"

    hydrated_refs: set[tuple[str, UUID]] = set()
    for index, (ref, locator) in enumerate(next_refs):
        ref_key = (ref.object_type, ref.object_id)
        if ref_key not in hydrated_refs:
            hydrate_object_ref(db, viewer_id, ref)
            hydrated_refs.add(ref_key)
        if index in kept_indexes or ref_key in unlocated_targets:
            continue
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type="references",
                a_type="note_block",
                a_id=block.id,
                b_type=ref.object_type,
                b_id=ref.object_id,
                a_order_key=f"{index + 1:010d}",
                b_order_key=None,
                a_locator_json=locator,
                b_locator_json=None,
                metadata_json={},
            )
        )


def _is_managed_inline_reference_link(link: ObjectLink) -> bool:
    if link.b_locator_json is not None:
        return False
    if link.a_locator_json is None:
        return True
    return (
        isinstance(link.a_locator_json, dict)
        and link.a_locator_json.get("kind") == "note_inline_object_ref"
    )


def _copy_split_note_about_links(
    db: Session,
    viewer_id: UUID,
    *,
    source_block_id: UUID,
    target_block_id: UUID,
) -> None:
    links = list(
        db.scalars(
            select(ObjectLink).where(
                ObjectLink.user_id == viewer_id,
                ObjectLink.relation_type == "note_about",
                (
                    ((ObjectLink.a_type == "note_block") & (ObjectLink.a_id == source_block_id))
                    | ((ObjectLink.b_type == "note_block") & (ObjectLink.b_id == source_block_id))
                ),
            )
        )
    )
    for link in links:
        a_type, a_id, b_type, b_id = _replacement_link_endpoints(
            link,
            source_block_id=source_block_id,
            target_block_id=target_block_id,
        )
        if a_type == b_type and a_id == b_id:
            continue
        if _has_duplicate_unlocated_link(
            db,
            viewer_id,
            relation_type=link.relation_type,
            a_type=a_type,
            a_id=a_id,
            b_type=b_type,
            b_id=b_id,
            exclude_link_id=None,
        ):
            continue
        db.add(
            ObjectLink(
                user_id=viewer_id,
                relation_type=link.relation_type,
                a_type=a_type,
                a_id=a_id,
                b_type=b_type,
                b_id=b_id,
                a_order_key=link.a_order_key,
                b_order_key=link.b_order_key,
                a_locator_json=deepcopy(link.a_locator_json),
                b_locator_json=deepcopy(link.b_locator_json),
                metadata_json=deepcopy(link.metadata_json),
            )
        )


def _transfer_note_block_relationships(
    db: Session,
    viewer_id: UUID,
    *,
    source_block_id: UUID,
    target_block_id: UUID,
) -> None:
    links = list(
        db.scalars(
            select(ObjectLink).where(
                ObjectLink.user_id == viewer_id,
                (
                    ((ObjectLink.a_type == "note_block") & (ObjectLink.a_id == source_block_id))
                    | ((ObjectLink.b_type == "note_block") & (ObjectLink.b_id == source_block_id))
                ),
            )
        )
    )
    for link in links:
        a_type, a_id, b_type, b_id = _replacement_link_endpoints(
            link,
            source_block_id=source_block_id,
            target_block_id=target_block_id,
        )
        if a_type == b_type and a_id == b_id:
            db.delete(link)
            continue
        if (
            link.relation_type != "used_as_context"
            and link.a_locator_json is None
            and link.b_locator_json is None
            and _has_duplicate_unlocated_link(
                db,
                viewer_id,
                relation_type=link.relation_type,
                a_type=a_type,
                a_id=a_id,
                b_type=b_type,
                b_id=b_id,
                exclude_link_id=link.id,
            )
        ):
            db.delete(link)
            continue
        link.a_type = a_type
        link.a_id = a_id
        link.b_type = b_type
        link.b_id = b_id
        link.updated_at = func.now()

    context_items = db.scalars(
        select(MessageContextItem).where(
            MessageContextItem.user_id == viewer_id,
            MessageContextItem.object_type == "note_block",
            MessageContextItem.object_id == source_block_id,
        )
    )
    for item in context_items:
        item.object_id = target_block_id
        item.context_snapshot_json = hydrate_object_ref(
            db,
            viewer_id,
            ObjectRef(object_type="note_block", object_id=target_block_id),
        ).model_dump(mode="json", by_alias=True)


def _replacement_link_endpoints(
    link: ObjectLink,
    *,
    source_block_id: UUID,
    target_block_id: UUID,
) -> tuple[str, UUID, str, UUID]:
    a_type = link.a_type
    a_id = link.a_id
    b_type = link.b_type
    b_id = link.b_id
    if a_type == "note_block" and a_id == source_block_id:
        a_id = target_block_id
    if b_type == "note_block" and b_id == source_block_id:
        b_id = target_block_id
    return a_type, a_id, b_type, b_id


def _has_duplicate_unlocated_link(
    db: Session,
    viewer_id: UUID,
    *,
    relation_type: str,
    a_type: str,
    a_id: UUID,
    b_type: str,
    b_id: UUID,
    exclude_link_id: UUID | None,
) -> bool:
    statement = select(ObjectLink.id).where(
        ObjectLink.user_id == viewer_id,
        ObjectLink.relation_type == relation_type,
        (
            (
                (ObjectLink.a_type == a_type)
                & (ObjectLink.a_id == a_id)
                & (ObjectLink.b_type == b_type)
                & (ObjectLink.b_id == b_id)
            )
            | (
                (ObjectLink.a_type == b_type)
                & (ObjectLink.a_id == b_id)
                & (ObjectLink.b_type == a_type)
                & (ObjectLink.b_id == a_id)
            )
        ),
        ObjectLink.a_locator_json.is_(None),
        ObjectLink.b_locator_json.is_(None),
    )
    if exclude_link_id is not None:
        statement = statement.where(ObjectLink.id != exclude_link_id)
    return db.scalar(statement.limit(1)) is not None


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


def _children(db: Session, page_id: UUID, parent_id: UUID | None) -> list[NoteBlock]:
    return _siblings(db, page_id, parent_id)


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
            .order_by(NoteBlock.order_key.asc(), NoteBlock.created_at.asc(), NoteBlock.id.asc())
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


def _delete_object_edges(db: Session, object_type: str, object_id: UUID) -> None:
    db.execute(
        delete(ObjectLink).where(
            ((ObjectLink.a_type == object_type) & (ObjectLink.a_id == object_id))
            | ((ObjectLink.b_type == object_type) & (ObjectLink.b_id == object_id))
        )
    )
    db.execute(
        delete(MessageContextItem).where(
            MessageContextItem.object_type == object_type,
            MessageContextItem.object_id == object_id,
        )
    )


def _first_highlight_note_block(
    db: Session, viewer_id: UUID, highlight_id: UUID
) -> NoteBlock | None:
    note_block_join = ((ObjectLink.a_type == "note_block") & (ObjectLink.a_id == NoteBlock.id)) | (
        (ObjectLink.b_type == "note_block") & (ObjectLink.b_id == NoteBlock.id)
    )
    highlight_filter = (
        (ObjectLink.a_type == "note_block")
        & (ObjectLink.b_type == "highlight")
        & (ObjectLink.b_id == highlight_id)
    ) | (
        (ObjectLink.a_type == "highlight")
        & (ObjectLink.a_id == highlight_id)
        & (ObjectLink.b_type == "note_block")
    )
    endpoint_order = case(
        (ObjectLink.a_type == "highlight", ObjectLink.a_order_key),
        else_=ObjectLink.b_order_key,
    )
    return db.scalar(
        select(NoteBlock)
        .join(ObjectLink, note_block_join)
        .where(
            ObjectLink.user_id == viewer_id,
            ObjectLink.relation_type == "note_about",
            highlight_filter,
        )
        .order_by(endpoint_order.asc().nullsfirst(), NoteBlock.id.asc())
    )
