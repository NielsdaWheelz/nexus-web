"""Graph-owned note/page document structure.

Containment is stored only as ``resource_edges origin=note_containment`` rows.
This module loads and mutates that ordered graph without importing notes.py.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import cast
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, NoteViewState, Page, ResourceEdge
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resources
from nexus.services.resource_graph.edges import replace_edges_for_origin
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_graph.structure import BlockOccurrence, find_block_occurrence


@dataclass(frozen=True, slots=True)
class OrderedChildBlock:
    block_id: UUID
    source_order_key: str


@dataclass(slots=True)
class DocumentBlock:
    block: NoteBlock
    parent: ResourceRef
    source_order_key: str
    collapsed: bool
    children: list[DocumentBlock] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class PageDocument:
    page: Page
    roots: list[DocumentBlock]

    @property
    def block_ids(self) -> list[UUID]:
        out: list[UUID] = []

        def walk(node: DocumentBlock) -> None:
            out.append(node.block.id)
            for child in node.children:
                walk(child)

        for root in self.roots:
            walk(root)
        return out


def load_page_document(db: Session, *, user_id: UUID, page_id: UUID) -> PageDocument:
    page = db.scalar(select(Page).where(Page.id == page_id, Page.user_id == user_id))
    if page is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Page not found")

    rows = _containment_rows(db, user_id=user_id)
    collapsed = _collapsed_by_occurrence(db, user_id=user_id)
    by_parent: dict[tuple[str, UUID], list[tuple[ResourceEdge, NoteBlock]]] = {}
    for edge, block in rows:
        by_parent.setdefault((edge.source_scheme, edge.source_id), []).append((edge, block))
    for siblings in by_parent.values():
        siblings.sort(key=lambda item: (item[0].source_order_key or "", item[0].id))

    page_ref = ResourceRef(scheme="page", id=page.id)

    def build(parent: ResourceRef, path: set[UUID]) -> list[DocumentBlock]:
        nodes: list[DocumentBlock] = []
        for edge, block in by_parent.get((parent.scheme, parent.id), []):
            if block.id in path:
                raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Note containment cycle detected")
            child_parent = ResourceRef(scheme="note_block", id=block.id)
            nodes.append(
                DocumentBlock(
                    block=block,
                    parent=parent,
                    source_order_key=edge.source_order_key or "",
                    collapsed=collapsed.get((parent.scheme, parent.id, block.id), False),
                    children=build(child_parent, {*path, block.id}),
                )
            )
        return nodes

    return PageDocument(page=page, roots=build(page_ref, set()))


def list_page_block_ids(db: Session, *, user_id: UUID, page_id: UUID) -> list[UUID]:
    return load_page_document(db, user_id=user_id, page_id=page_id).block_ids


def find_document_block(document: PageDocument, block_id: UUID) -> DocumentBlock | None:
    def walk(node: DocumentBlock) -> DocumentBlock | None:
        if node.block.id == block_id:
            return node
        for child in node.children:
            found = walk(child)
            if found is not None:
                return found
        return None

    for root in document.roots:
        found = walk(root)
        if found is not None:
            return found
    return None


def set_children(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    children: Sequence[OrderedChildBlock],
) -> None:
    _assert_parent_visible(db, user_id=user_id, parent=parent)
    seen_blocks: set[UUID] = set()
    seen_order: set[str] = set()
    for child in children:
        if child.block_id in seen_blocks:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Child appears more than once")
        if child.source_order_key in seen_order:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Child order key appears more than once")
        seen_blocks.add(child.block_id)
        seen_order.add(child.source_order_key)
        _assert_block_visible(db, user_id=user_id, block_id=child.block_id)
        _assert_single_containment_parent(
            db,
            user_id=user_id,
            parent=parent,
            child_id=child.block_id,
        )
        _assert_no_cycle(db, user_id=user_id, parent=parent, child_id=child.block_id)

    replace_edges_for_origin(
        db,
        viewer_id=user_id,
        source=parent,
        origin="note_containment",
        edges=[
            EdgeCreate(
                source=parent,
                target=ResourceRef(scheme="note_block", id=child.block_id),
                kind="context",
                origin="note_containment",
                source_order_key=child.source_order_key,
            )
            for child in children
        ],
    )


def apply_page_document_structure(
    db: Session,
    *,
    user_id: UUID,
    previous_parents: Iterable[ResourceRef],
    children_by_parent: Mapping[ResourceRef, Sequence[OrderedChildBlock]],
    collapsed_by_block_id: dict[UUID, bool],
    deleted_block_ids: set[UUID],
) -> list[UUID]:
    """Replace a page document's containment/view-state graph; flush-only.

    Product services own command validation, block body writes, idempotency, and
    page versioning. This function owns the graph DML for the resulting document
    shape so containment invariants stay inside the resource graph module.
    """
    for parent in sorted(previous_parents, key=lambda item: (item.scheme, str(item.id))):
        set_children(db, user_id=user_id, parent=parent, children=[])

    changed_edge_ids: list[UUID] = []
    parent_by_block_id: dict[UUID, ResourceRef] = {}
    for parent, children in sorted(
        children_by_parent.items(),
        key=lambda item: (item[0].scheme, str(item[0].id)),
    ):
        set_children(db, user_id=user_id, parent=parent, children=children)
        for child in children:
            parent_by_block_id[child.block_id] = parent
        changed_edge_ids.extend(_edge_ids_for_parent(db, user_id=user_id, parent=parent))

    for block_id, collapsed in collapsed_by_block_id.items():
        parent = parent_by_block_id.get(block_id)
        if parent is None:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Collapsed state target must be in the document command",
            )
        set_collapsed(
            db,
            user_id=user_id,
            parent=parent,
            block_id=block_id,
            collapsed=collapsed,
        )

    delete_view_state_for_blocks(db, user_id=user_id, block_ids=deleted_block_ids)
    return changed_edge_ids


def append_child(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    block_id: UUID,
    before_block_id: UUID | None = None,
    after_block_id: UUID | None = None,
) -> str:
    if before_block_id is not None and after_block_id is not None:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Specify only one of before_block_id or after_block_id",
        )
    children = _children_for_parent(db, user_id=user_id, parent=parent)
    ids = [child.block_id for child in children if child.block_id != block_id]
    insert_at = len(ids)
    if before_block_id is not None:
        if before_block_id not in ids:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "before_block_id is not a sibling")
        insert_at = ids.index(before_block_id)
    if after_block_id is not None:
        if after_block_id not in ids:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "after_block_id is not a sibling")
        insert_at = ids.index(after_block_id) + 1
    ids.insert(insert_at, block_id)
    next_children = [
        OrderedChildBlock(block_id=child_id, source_order_key=f"{index + 1:010d}")
        for index, child_id in enumerate(ids)
    ]
    set_children(db, user_id=user_id, parent=parent, children=next_children)
    return f"{insert_at + 1:010d}"


def move_block(
    db: Session,
    *,
    user_id: UUID,
    block_id: UUID,
    from_parent: ResourceRef,
    to_parent: ResourceRef,
    before_block_id: UUID | None = None,
    after_block_id: UUID | None = None,
) -> BlockOccurrence:
    _assert_parent_visible(db, user_id=user_id, parent=from_parent)
    _assert_parent_visible(db, user_id=user_id, parent=to_parent)
    _assert_block_visible(db, user_id=user_id, block_id=block_id)
    _assert_no_cycle(db, user_id=user_id, parent=to_parent, child_id=block_id)
    to_child_ids = [
        child.block_id
        for child in _children_for_parent(db, user_id=user_id, parent=to_parent)
        if child.block_id != block_id
    ]
    if before_block_id is not None and before_block_id not in to_child_ids:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "before_block_id is not a sibling")
    if after_block_id is not None and after_block_id not in to_child_ids:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "after_block_id is not a sibling")
    from_children = [
        child
        for child in _children_for_parent(db, user_id=user_id, parent=from_parent)
        if child.block_id != block_id
    ]
    set_children(db, user_id=user_id, parent=from_parent, children=from_children)
    append_child(
        db,
        user_id=user_id,
        parent=to_parent,
        block_id=block_id,
        before_block_id=before_block_id,
        after_block_id=after_block_id,
    )
    return find_block_occurrence(db, user_id=user_id, block_id=block_id)


def unlink_block_occurrence(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    block_id: UUID,
) -> None:
    children = [
        child
        for child in _children_for_parent(db, user_id=user_id, parent=parent)
        if child.block_id != block_id
    ]
    set_children(db, user_id=user_id, parent=parent, children=children)


def set_collapsed(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    block_id: UUID,
    collapsed: bool,
) -> None:
    row = db.scalar(
        select(NoteViewState).where(
            NoteViewState.user_id == user_id,
            NoteViewState.context_source_scheme == parent.scheme,
            NoteViewState.context_source_id == parent.id,
            NoteViewState.target_block_id == block_id,
        )
    )
    if row is None:
        db.add(
            NoteViewState(
                user_id=user_id,
                context_source_scheme=parent.scheme,
                context_source_id=parent.id,
                target_block_id=block_id,
                collapsed=collapsed,
            )
        )
        db.flush()
        return
    if row.collapsed != collapsed:
        row.collapsed = collapsed
    db.flush()


def sync_block_body_edges(
    db: Session,
    *,
    user_id: UUID,
    block_id: UUID,
    parsed_refs: Sequence[ResourceRef],
) -> None:
    source = ResourceRef(scheme="note_block", id=block_id)
    replace_edges_for_origin(
        db,
        viewer_id=user_id,
        source=source,
        origin="note_body",
        edges=[
            EdgeCreate(source=source, target=target, kind="context", origin="note_body")
            for target in parsed_refs
        ],
    )


def delete_view_state_for_blocks(
    db: Session,
    *,
    user_id: UUID,
    block_ids: set[UUID],
) -> None:
    if not block_ids:
        return
    db.execute(
        delete(NoteViewState).where(
            NoteViewState.user_id == user_id,
            (
                (NoteViewState.context_source_scheme == "note_block")
                & (NoteViewState.context_source_id.in_(block_ids))
            )
            | (NoteViewState.target_block_id.in_(block_ids)),
        )
    )


def delete_block_subtree(
    db: Session,
    *,
    user_id: UUID,
    root_block_id: UUID,
    parent_context: ResourceRef | None,
) -> list[UUID]:
    if parent_context is not None:
        unlink_block_occurrence(
            db,
            user_id=user_id,
            parent=parent_context,
            block_id=root_block_id,
        )
    deleted = _subtree_ids(db, user_id=user_id, block_id=root_block_id)
    delete_edges_for_deleted_resources(
        db,
        refs=[ResourceRef(scheme="note_block", id=block_id) for block_id in deleted],
    )
    for block_id in deleted:
        db.execute(
            delete(NoteViewState).where(
                NoteViewState.user_id == user_id,
                (
                    (NoteViewState.context_source_scheme == "note_block")
                    & (NoteViewState.context_source_id == block_id)
                )
                | (NoteViewState.target_block_id == block_id),
            )
        )
    return deleted


def _containment_rows(db: Session, *, user_id: UUID) -> list[tuple[ResourceEdge, NoteBlock]]:
    return list(
        db.execute(
            select(ResourceEdge, NoteBlock)
            .join(
                NoteBlock,
                (ResourceEdge.target_scheme == "note_block")
                & (ResourceEdge.target_id == NoteBlock.id),
            )
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "note_containment",
                NoteBlock.user_id == user_id,
            )
        )
        .tuples()
        .all()
    )


def _children_for_parent(
    db: Session, *, user_id: UUID, parent: ResourceRef
) -> list[OrderedChildBlock]:
    rows = (
        db.execute(
            select(ResourceEdge.target_id, ResourceEdge.source_order_key, ResourceEdge.id)
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "note_containment",
                ResourceEdge.source_scheme == parent.scheme,
                ResourceEdge.source_id == parent.id,
                ResourceEdge.target_scheme == "note_block",
            )
            .order_by(ResourceEdge.source_order_key.asc(), ResourceEdge.id.asc())
        )
        .tuples()
        .all()
    )
    return [
        OrderedChildBlock(block_id=block_id, source_order_key=source_order_key or "")
        for block_id, source_order_key, _edge_id in rows
    ]


def _edge_ids_for_parent(db: Session, *, user_id: UUID, parent: ResourceRef) -> list[UUID]:
    return list(
        db.scalars(
            select(ResourceEdge.id)
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "note_containment",
                ResourceEdge.source_scheme == parent.scheme,
                ResourceEdge.source_id == parent.id,
            )
            .order_by(ResourceEdge.source_order_key.asc(), ResourceEdge.id.asc())
        )
    )


def _subtree_ids(db: Session, *, user_id: UUID, block_id: UUID) -> list[UUID]:
    out = [block_id]
    for child in _children_for_parent(
        db,
        user_id=user_id,
        parent=ResourceRef(scheme="note_block", id=block_id),
    ):
        out.extend(_subtree_ids(db, user_id=user_id, block_id=child.block_id))
    return out


def _assert_parent_visible(db: Session, *, user_id: UUID, parent: ResourceRef) -> None:
    if parent.scheme == "page":
        page = db.scalar(select(Page.id).where(Page.id == parent.id, Page.user_id == user_id))
        if page is not None:
            return
    elif parent.scheme == "note_block":
        _assert_block_visible(db, user_id=user_id, block_id=parent.id)
        return
    raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Document parent not found")


def _assert_block_visible(db: Session, *, user_id: UUID, block_id: UUID) -> None:
    exists = db.scalar(
        select(NoteBlock.id).where(NoteBlock.id == block_id, NoteBlock.user_id == user_id)
    )
    if exists is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Note block not found")


def _assert_single_containment_parent(
    db: Session,
    *,
    user_id: UUID,
    parent: ResourceRef,
    child_id: UUID,
) -> None:
    rows = (
        db.execute(
            select(ResourceEdge.source_scheme, ResourceEdge.source_id)
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "note_containment",
                ResourceEdge.target_scheme == "note_block",
                ResourceEdge.target_id == child_id,
            )
            .order_by(ResourceEdge.id.asc())
        )
        .tuples()
        .all()
    )
    for source_scheme, source_id in rows:
        if source_scheme != parent.scheme or source_id != parent.id:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Note block already has a containment parent",
            )


def _assert_no_cycle(db: Session, *, user_id: UUID, parent: ResourceRef, child_id: UUID) -> None:
    if parent.scheme == "page":
        return
    if parent.id == child_id:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Block cannot be moved under itself")
    ancestor = parent
    seen: set[UUID] = set()
    while ancestor.scheme == "note_block":
        if ancestor.id in seen:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Note containment cycle detected")
        if ancestor.id == child_id:
            raise ApiError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Block cannot be moved under one of its descendants",
            )
        seen.add(ancestor.id)
        edge = db.scalar(
            select(ResourceEdge)
            .where(
                ResourceEdge.user_id == user_id,
                ResourceEdge.origin == "note_containment",
                ResourceEdge.target_scheme == "note_block",
                ResourceEdge.target_id == ancestor.id,
            )
            .order_by(ResourceEdge.created_at.asc(), ResourceEdge.id.asc())
        )
        if edge is None:
            return
        ancestor = ResourceRef(scheme=cast(ResourceScheme, edge.source_scheme), id=edge.source_id)


def _collapsed_by_occurrence(db: Session, *, user_id: UUID) -> dict[tuple[str, UUID, UUID], bool]:
    rows = db.execute(
        select(
            NoteViewState.context_source_scheme,
            NoteViewState.context_source_id,
            NoteViewState.target_block_id,
            NoteViewState.collapsed,
        ).where(NoteViewState.user_id == user_id)
    ).all()
    return {(row[0], row[1], row[2]): bool(row[3]) for row in rows}
