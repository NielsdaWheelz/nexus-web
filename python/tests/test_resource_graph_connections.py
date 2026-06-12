"""Integration tests for the resource graph connection read model."""

from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import ConnectionFilters, ConnectionQuery, EdgeCreate
from tests.factories import (
    create_test_fragment,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def _media(db: Session, user_id: UUID, title: str) -> ResourceRef:
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    return ResourceRef(
        scheme="media",
        id=create_test_media_in_library(db, user_id, library_id, title=title),
    )


def test_connection_cursor_uses_last_returned_row(db_session: Session, bootstrapped_user: UUID):
    source = _media(db_session, bootstrapped_user, "source")
    targets = [_media(db_session, bootstrapped_user, f"target {index}") for index in range(3)]
    created = [
        create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(source=source, target=target, kind="context", origin="user"),
        )
        for target in targets
    ]

    first = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(source,),
            direction="outgoing",
            rollup="exact",
            filters=ConnectionFilters(),
            limit=2,
        ),
    )
    assert len(first.items) == 2
    assert first.next_cursor is not None

    second = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(source,),
            direction="outgoing",
            rollup="exact",
            filters=ConnectionFilters(),
            limit=2,
            cursor=first.next_cursor,
        ),
    )

    seen = [edge.edge_id for edge in [*first.items, *second.items]]
    assert len(second.items) == 1
    assert set(seen) == {edge.id for edge in created}
    assert len(seen) == len(set(seen))


def test_outgoing_multi_ref_keeps_source_side_direction(
    db_session: Session, bootstrapped_user: UUID
):
    source = _media(db_session, bootstrapped_user, "source")
    target = _media(db_session, bootstrapped_user, "target")
    edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=source, target=target, kind="context", origin="user"),
    )

    page = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(source, target),
            direction="outgoing",
            rollup="exact",
            filters=ConnectionFilters(),
            limit=100,
        ),
    )

    item = next(item for item in page.items if item.edge_id == edge.id)
    assert item.direction == "outgoing"
    assert item.source_ref == source
    assert item.target_ref == target
    assert item.other.ref == target


def test_owner_rollup_matches_media_child_refs(db_session: Session, bootstrapped_user: UUID):
    source = _media(db_session, bootstrapped_user, "source")
    media = _media(db_session, bootstrapped_user, "target media")
    fragment = ResourceRef(
        scheme="fragment",
        id=create_test_fragment(db_session, media.id, "Fragment body"),
    )
    edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=source, target=fragment, kind="context", origin="user"),
    )

    page = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(media,),
            direction="incoming",
            rollup="owner",
            filters=ConnectionFilters(),
            limit=100,
        ),
    )

    item = next(item for item in page.items if item.edge_id == edge.id)
    assert item.direction == "incoming"
    assert item.target_ref == fragment
    assert item.other.ref == source
