from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, Page, ResourceEdge
from nexus.services.resource_graph import adjacency
from nexus.services.resource_graph.refs import ResourceRef
from tests.factories import (
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def _note(db: Session, user_id, text: str) -> NoteBlock:
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": text}]},
        body_text=text,
    )
    db.add(block)
    db.flush()
    return block


def test_load_page_surface_from_user_ordered_edges(db_session: Session, bootstrapped_user):
    page = Page(user_id=bootstrapped_user, title="Graph surface")
    parent = _note(db_session, bootstrapped_user, "parent")
    child = _note(db_session, bootstrapped_user, "child")
    db_session.add(page)
    db_session.flush()

    adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=ResourceRef(scheme="page", id=page.id),
        targets=[
            adjacency.OrderedTarget(
                target=ResourceRef(scheme="note_block", id=parent.id),
                source_order_key="0000000001",
            )
        ],
    )
    adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=ResourceRef(scheme="note_block", id=parent.id),
        targets=[
            adjacency.OrderedTarget(
                target=ResourceRef(scheme="note_block", id=child.id),
                source_order_key="0000000001",
            )
        ],
    )

    surface = adjacency.load_page_surface(db_session, user_id=bootstrapped_user, page_id=page.id)

    assert [node.block.id for node in surface.roots] == [parent.id]
    assert [node.block.id for node in surface.roots[0].children] == [child.id]


def test_same_note_can_be_ordered_under_two_sources(db_session: Session, bootstrapped_user):
    first = Page(user_id=bootstrapped_user, title="First")
    second = Page(user_id=bootstrapped_user, title="Second")
    block = _note(db_session, bootstrapped_user, "shared")
    db_session.add_all([first, second])
    db_session.flush()

    for page in (first, second):
        adjacency.replace_ordered_targets(
            db_session,
            user_id=bootstrapped_user,
            source=ResourceRef(scheme="page", id=page.id),
            targets=[
                adjacency.OrderedTarget(
                    target=ResourceRef(scheme="note_block", id=block.id),
                    source_order_key="0000000001",
                )
            ],
        )

    assert adjacency.load_page_surface(
        db_session, user_id=bootstrapped_user, page_id=first.id
    ).block_ids == [block.id]
    assert adjacency.load_page_surface(
        db_session, user_id=bootstrapped_user, page_id=second.id
    ).block_ids == [block.id]


def test_page_and_note_ordered_adjacency_accept_mixed_capability_targets(
    db_session: Session, bootstrapped_user
):
    page_source = Page(user_id=bootstrapped_user, title="Page source")
    note_source = _note(db_session, bootstrapped_user, "note source")
    target_page = Page(user_id=bootstrapped_user, title="Target page")
    target_note = _note(db_session, bootstrapped_user, "target note")
    db_session.add_all([page_source, target_page])
    db_session.flush()

    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Target media"
    )
    fragment_id = create_test_fragment(db_session, media_id, "target fragment")
    highlight_id = create_test_highlight(db_session, bootstrapped_user, fragment_id, "target")
    conversation_id, message_id = create_test_conversation_with_message(
        db_session, bootstrapped_user
    )

    targets = [
        ResourceRef(scheme="page", id=target_page.id),
        ResourceRef(scheme="note_block", id=target_note.id),
        ResourceRef(scheme="media", id=media_id),
        ResourceRef(scheme="highlight", id=highlight_id),
        ResourceRef(scheme="conversation", id=conversation_id),
        ResourceRef(scheme="message", id=message_id),
    ]

    for source in (
        ResourceRef(scheme="page", id=page_source.id),
        ResourceRef(scheme="note_block", id=note_source.id),
    ):
        adjacency.replace_ordered_targets(
            db_session,
            user_id=bootstrapped_user,
            source=source,
            targets=[
                adjacency.OrderedTarget(target, f"{index + 1:010d}")
                for index, target in enumerate(targets)
            ],
        )

    for source in (
        ResourceRef(scheme="page", id=page_source.id),
        ResourceRef(scheme="note_block", id=note_source.id),
    ):
        rows = (
            db_session.query(ResourceEdge)
            .filter(
                ResourceEdge.user_id == bootstrapped_user,
                ResourceEdge.source_scheme == source.scheme,
                ResourceEdge.source_id == source.id,
                ResourceEdge.source_order_key.is_not(None),
            )
            .order_by(ResourceEdge.source_order_key.asc())
            .all()
        )
        assert [row.target_scheme for row in rows] == [
            "page",
            "note_block",
            "media",
            "highlight",
            "conversation",
            "message",
        ]
