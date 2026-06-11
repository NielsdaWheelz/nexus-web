from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page
from nexus.errors import ApiError
from nexus.services.resource_graph.documents import (
    OrderedChildBlock,
    find_block_occurrence,
    load_page_document,
    set_children,
    set_collapsed,
)
from nexus.services.resource_graph.refs import ResourceRef


def _page(db: Session, user_id: UUID, *, title: str = "Page") -> Page:
    page = Page(id=uuid4(), user_id=user_id, title=title)
    db.add(page)
    db.flush()
    return page


def _block(db: Session, user_id: UUID, page: Page, *, text: str) -> NoteBlock:
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        block_kind="bullet",
        body_pm_json={"type": "paragraph"},
        body_markdown=text,
        body_text=text,
    )
    db.add(block)
    db.flush()
    return block


def test_load_page_document_from_containment_edges(db_session: Session, bootstrapped_user: UUID):
    page = _page(db_session, bootstrapped_user)
    first = _block(db_session, bootstrapped_user, page, text="First")
    second = _block(db_session, bootstrapped_user, page, text="Second")
    child = _block(db_session, bootstrapped_user, page, text="Child")

    page_ref = ResourceRef(scheme="page", id=page.id)
    first_ref = ResourceRef(scheme="note_block", id=first.id)
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=page_ref,
        children=[
            OrderedChildBlock(block_id=second.id, source_order_key="0000000002"),
            OrderedChildBlock(block_id=first.id, source_order_key="0000000001"),
        ],
    )
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=first_ref,
        children=[OrderedChildBlock(block_id=child.id, source_order_key="0000000001")],
    )
    set_collapsed(
        db_session,
        user_id=bootstrapped_user,
        parent=first_ref,
        block_id=child.id,
        collapsed=True,
    )

    document = load_page_document(db_session, user_id=bootstrapped_user, page_id=page.id)

    assert [node.block.id for node in document.roots] == [first.id, second.id]
    assert document.roots[0].children[0].block.id == child.id
    assert document.roots[0].children[0].collapsed is True
    assert document.block_ids == [first.id, child.id, second.id]


def test_find_block_occurrence_resolves_page_through_parent_chain(
    db_session: Session, bootstrapped_user: UUID
):
    page = _page(db_session, bootstrapped_user)
    parent = _block(db_session, bootstrapped_user, page, text="Parent")
    child = _block(db_session, bootstrapped_user, page, text="Child")

    page_ref = ResourceRef(scheme="page", id=page.id)
    parent_ref = ResourceRef(scheme="note_block", id=parent.id)
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=page_ref,
        children=[OrderedChildBlock(block_id=parent.id, source_order_key="0000000001")],
    )
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=parent_ref,
        children=[OrderedChildBlock(block_id=child.id, source_order_key="0000000007")],
    )

    occurrence = find_block_occurrence(db_session, user_id=bootstrapped_user, block_id=child.id)

    assert occurrence.page_id == page.id
    assert occurrence.parent == parent_ref
    assert occurrence.source_order_key == "0000000007"


def test_set_children_rejects_containment_cycle(db_session: Session, bootstrapped_user: UUID):
    page = _page(db_session, bootstrapped_user)
    parent = _block(db_session, bootstrapped_user, page, text="Parent")
    child = _block(db_session, bootstrapped_user, page, text="Child")

    page_ref = ResourceRef(scheme="page", id=page.id)
    parent_ref = ResourceRef(scheme="note_block", id=parent.id)
    child_ref = ResourceRef(scheme="note_block", id=child.id)
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=page_ref,
        children=[OrderedChildBlock(block_id=parent.id, source_order_key="0000000001")],
    )
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=parent_ref,
        children=[OrderedChildBlock(block_id=child.id, source_order_key="0000000001")],
    )

    with pytest.raises(ApiError):
        set_children(
            db_session,
            user_id=bootstrapped_user,
            parent=child_ref,
            children=[OrderedChildBlock(block_id=parent.id, source_order_key="0000000001")],
        )


def test_set_children_rejects_second_containment_parent_before_db_constraint(
    db_session: Session, bootstrapped_user: UUID
):
    page = _page(db_session, bootstrapped_user)
    first_parent = _block(db_session, bootstrapped_user, page, text="First parent")
    second_parent = _block(db_session, bootstrapped_user, page, text="Second parent")
    child = _block(db_session, bootstrapped_user, page, text="Child")

    page_ref = ResourceRef(scheme="page", id=page.id)
    first_ref = ResourceRef(scheme="note_block", id=first_parent.id)
    second_ref = ResourceRef(scheme="note_block", id=second_parent.id)
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=page_ref,
        children=[
            OrderedChildBlock(block_id=first_parent.id, source_order_key="0000000001"),
            OrderedChildBlock(block_id=second_parent.id, source_order_key="0000000002"),
        ],
    )
    set_children(
        db_session,
        user_id=bootstrapped_user,
        parent=first_ref,
        children=[OrderedChildBlock(block_id=child.id, source_order_key="0000000001")],
    )

    with pytest.raises(ApiError, match="already has a containment parent"):
        set_children(
            db_session,
            user_id=bootstrapped_user,
            parent=second_ref,
            children=[OrderedChildBlock(block_id=child.id, source_order_key="0000000001")],
        )
