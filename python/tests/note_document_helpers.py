from collections.abc import Callable, Mapping
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from nexus.db.models import Page
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.notes import (
    NOTE_BLOCK_KINDS,
    CreatePageRequest,
    NoteBlockOut,
    PatchPageDocumentRequest,
)
from nexus.services import notes
from nexus.services.resource_graph import documents as graph_documents
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import EdgeCreate


def create_block_via_document(
    db: Session,
    viewer_id: UUID,
    request: Mapping[str, Any] | None = None,
    *,
    page_id: UUID | None = None,
    block_id: UUID | None = None,
    parent_block_id: UUID | None = None,
    after_block_id: UUID | None = None,
    before_block_id: UUID | None = None,
    block_kind: NOTE_BLOCK_KINDS = "bullet",
    body_pm_json: dict[str, Any] | None = None,
    body_markdown: str | None = None,
    linked_highlight_id: UUID | None = None,
) -> NoteBlockOut:
    if request is not None:
        page_id = request.get("page_id", page_id)
        block_id = request.get("id", block_id)
        parent_block_id = request.get("parent_block_id", parent_block_id)
        after_block_id = request.get("after_block_id", after_block_id)
        before_block_id = request.get("before_block_id", before_block_id)
        block_kind = request.get("block_kind", block_kind)
        body_pm_json = request.get("body_pm_json", body_pm_json)
        body_markdown = request.get("body_markdown", body_markdown)
        linked_object = request.get("linked_object")
        if isinstance(linked_object, Mapping):
            linked_highlight_id = linked_object.get("object_id") or linked_object.get("objectId")

    if page_id is None:
        page_id = _default_page_id_for_test(db, viewer_id)

    block_id = block_id or uuid4()
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page_id)
    blocks, containment_by_parent = _document_command_payload(document)

    parent = ResourceRef(scheme="page", id=page_id)
    if parent_block_id is not None:
        parent_occurrence = graph_documents.find_block_occurrence(
            db, user_id=viewer_id, block_id=parent_block_id
        )
        if parent_occurrence.page_id != page_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be on the same page")
        parent = ResourceRef(scheme="note_block", id=parent_block_id)

    blocks.append(
        {
            "id": block_id,
            "block_kind": block_kind,
            "body_pm_json": body_pm_json or notes.pm_doc_from_text(body_markdown or ""),
        }
    )
    siblings = containment_by_parent.setdefault(parent, [])
    _insert_child(
        siblings,
        {"block_id": block_id, "source_order_key": "0000000000", "collapsed": False},
        before_block_id=before_block_id,
        after_block_id=after_block_id,
    )
    after_apply = None
    if linked_highlight_id is not None:

        def attach_highlight_note() -> list[UUID]:
            edge = create_edge(
                db,
                viewer_id=viewer_id,
                input=EdgeCreate(
                    source=ResourceRef(scheme="highlight", id=cast(UUID, linked_highlight_id)),
                    target=ResourceRef(scheme="note_block", id=block_id),
                    kind="context",
                    origin="highlight_note",
                ),
            )
            return [edge.id]

        after_apply = attach_highlight_note

    result = patch_document_via_command(
        db,
        viewer_id,
        page_id=page_id,
        blocks=blocks,
        containment_by_parent=containment_by_parent,
        focus_block_id=block_id,
        after_apply=after_apply,
    )
    if result.focused_block is not None:
        return result.focused_block
    return notes.get_note_block(db, viewer_id, block_id)


def update_block_via_document(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
    request: Mapping[str, Any] | None = None,
    *,
    body_pm_json: dict[str, Any] | None = None,
    body_markdown: str | None = None,
    block_kind: NOTE_BLOCK_KINDS | None = None,
    collapsed: bool | None = None,
) -> NoteBlockOut:
    if request is not None:
        body_pm_json = request.get("body_pm_json", body_pm_json)
        body_markdown = request.get("body_markdown", body_markdown)
        block_kind = request.get("block_kind", block_kind)
        collapsed = request.get("collapsed", collapsed)

    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=block_id)
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=occurrence.page_id)
    body_updates: dict[UUID, dict[str, Any]] = {}
    if body_pm_json is not None:
        body_updates[block_id] = body_pm_json
    elif body_markdown is not None:
        body_updates[block_id] = notes.pm_doc_from_text(body_markdown)
    kind_updates = {block_id: block_kind} if block_kind is not None else {}
    collapsed_updates = {block_id: collapsed} if collapsed is not None else {}
    blocks, containment_by_parent = _document_command_payload(
        document,
        body_updates=body_updates,
        kind_updates=kind_updates,
        collapsed_updates=collapsed_updates,
    )
    result = patch_document_via_command(
        db,
        viewer_id,
        page_id=occurrence.page_id,
        blocks=blocks,
        containment_by_parent=containment_by_parent,
        focus_block_id=block_id,
    )
    if result.focused_block is not None:
        return result.focused_block
    return notes.get_note_block(db, viewer_id, block_id)


def move_block_via_document(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
    request: Mapping[str, Any] | None = None,
    *,
    parent_block_id: UUID | None = None,
    before_block_id: UUID | None = None,
    after_block_id: UUID | None = None,
) -> NoteBlockOut:
    if request is not None:
        parent_block_id = request.get("parent_block_id", parent_block_id)
        before_block_id = request.get("before_block_id", before_block_id)
        after_block_id = request.get("after_block_id", after_block_id)

    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=block_id)
    page_id = occurrence.page_id
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=page_id)
    blocks, containment_by_parent = _document_command_payload(document)
    child_payload = _remove_child(containment_by_parent, block_id)
    if child_payload is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")

    parent = ResourceRef(scheme="page", id=page_id)
    if parent_block_id is not None:
        parent_occurrence = graph_documents.find_block_occurrence(
            db, user_id=viewer_id, block_id=parent_block_id
        )
        if parent_occurrence.page_id != page_id:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Parent must be on the same page")
        parent = ResourceRef(scheme="note_block", id=parent_block_id)
    siblings = containment_by_parent.setdefault(parent, [])
    _insert_child(
        siblings,
        child_payload,
        before_block_id=before_block_id,
        after_block_id=after_block_id,
    )
    result = patch_document_via_command(
        db,
        viewer_id,
        page_id=page_id,
        blocks=blocks,
        containment_by_parent=containment_by_parent,
        focus_block_id=block_id,
    )
    if result.focused_block is not None:
        return result.focused_block
    return notes.get_note_block(db, viewer_id, block_id)


def delete_block_via_document(
    db: Session,
    viewer_id: UUID,
    block_id: UUID,
) -> None:
    occurrence = graph_documents.find_block_occurrence(db, user_id=viewer_id, block_id=block_id)
    document = graph_documents.load_page_document(db, user_id=viewer_id, page_id=occurrence.page_id)
    node = graph_documents.find_document_block(document, block_id)
    if node is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")
    deleted_ids = _subtree_ids(node)
    blocks, containment_by_parent = _document_command_payload(document, skip_ids=deleted_ids)
    patch_document_via_command(
        db,
        viewer_id,
        page_id=occurrence.page_id,
        blocks=blocks,
        containment_by_parent=containment_by_parent,
        deleted_block_ids=sorted(deleted_ids, key=str),
    )


def patch_document_via_command(
    db: Session,
    viewer_id: UUID,
    *,
    page_id: UUID,
    blocks: list[dict[str, Any]],
    containment_by_parent: dict[ResourceRef, list[dict[str, Any]]],
    deleted_block_ids: list[UUID] | None = None,
    focus_block_id: UUID | None = None,
    after_apply: Callable[[], list[UUID]] | None = None,
):
    page = db.get(Page, page_id)
    if page is None or page.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")
    return notes.patch_page_document(
        db,
        viewer_id,
        page_id,
        PatchPageDocumentRequest(
            client_mutation_id=f"test-doc-{uuid4()}",
            base_document_version=page.document_version,
            focus_block_id=focus_block_id,
            blocks=blocks,
            containment=_containment_payload(containment_by_parent),
            deleted_block_ids=deleted_block_ids or [],
        ),
        after_apply=after_apply,
    )


def _document_command_payload(
    document: graph_documents.PageDocument,
    *,
    skip_ids: set[UUID] | None = None,
    body_updates: dict[UUID, dict[str, Any]] | None = None,
    kind_updates: dict[UUID, NOTE_BLOCK_KINDS] | None = None,
    collapsed_updates: dict[UUID, bool] | None = None,
) -> tuple[list[dict[str, Any]], dict[ResourceRef, list[dict[str, Any]]]]:
    skip_ids = skip_ids or set()
    body_updates = body_updates or {}
    kind_updates = kind_updates or {}
    collapsed_updates = collapsed_updates or {}
    blocks: list[dict[str, Any]] = []
    containment_by_parent: dict[ResourceRef, list[dict[str, Any]]] = {}

    def visit(node: graph_documents.DocumentBlock) -> None:
        if node.block.id in skip_ids:
            return
        blocks.append(
            {
                "id": node.block.id,
                "block_kind": kind_updates.get(node.block.id, node.block.block_kind),
                "body_pm_json": body_updates.get(node.block.id, node.block.body_pm_json),
            }
        )
        containment_by_parent.setdefault(node.parent, []).append(
            {
                "block_id": node.block.id,
                "source_order_key": node.source_order_key,
                "collapsed": collapsed_updates.get(node.block.id, node.collapsed),
            }
        )
        for child in node.children:
            visit(child)

    for root in document.roots:
        visit(root)
    return blocks, containment_by_parent


def _containment_payload(
    containment_by_parent: dict[ResourceRef, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    return [
        {
            "parent": {"scheme": parent.scheme, "id": parent.id},
            "children": children,
        }
        for parent, children in containment_by_parent.items()
    ]


def _default_page_id_for_test(db: Session, viewer_id: UUID) -> UUID:
    page = db.query(Page).filter(Page.user_id == viewer_id, Page.title == "Notes").first()
    if page is None:
        page = notes.create_page(db, viewer_id, CreatePageRequest(title="Notes"))
        return page.id
    return page.id


def _insert_child(
    siblings: list[dict[str, Any]],
    child: dict[str, Any],
    *,
    before_block_id: UUID | None,
    after_block_id: UUID | None,
) -> None:
    if before_block_id is not None and after_block_id is not None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Only one insertion anchor is allowed")
    if before_block_id is not None:
        index = _child_index(siblings, before_block_id)
    elif after_block_id is not None:
        index = _child_index(siblings, after_block_id) + 1
    else:
        index = len(siblings)
    siblings.insert(index, child)
    _renumber(siblings)


def _child_index(siblings: list[dict[str, Any]], block_id: UUID) -> int:
    for index, child in enumerate(siblings):
        if child["block_id"] == block_id:
            return index
    raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Insertion anchor must share the same parent")


def _remove_child(
    containment_by_parent: dict[ResourceRef, list[dict[str, Any]]],
    block_id: UUID,
) -> dict[str, Any] | None:
    for siblings in containment_by_parent.values():
        for index, child in enumerate(siblings):
            if child["block_id"] == block_id:
                removed = siblings.pop(index)
                _renumber(siblings)
                return removed
    return None


def _renumber(siblings: list[dict[str, Any]]) -> None:
    for index, child in enumerate(siblings):
        child["source_order_key"] = f"{index + 1:010d}"


def _subtree_ids(node: graph_documents.DocumentBlock) -> set[UUID]:
    ids = {node.block.id}
    for child in node.children:
        ids.update(_subtree_ids(child))
    return ids
