"""Integration tests for the resource graph connection read model."""

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.resource_graph.citations import replace_citations_for_output
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    CitationInput,
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
)
from tests.factories import (
    create_test_fragment,
    create_test_library,
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


def _li_artifact_with_revision(db: Session, user_id: UUID) -> tuple[ResourceRef, ResourceRef]:
    library_id = create_test_library(db, user_id, "Connection Intelligence")
    artifact_id = db.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (library_id, user_id)
            VALUES (:library_id, :user_id)
            RETURNING id
            """
        ),
        {"library_id": library_id, "user_id": user_id},
    ).scalar_one()
    revision_id = db.execute(
        text(
            """
            INSERT INTO library_intelligence_artifact_revisions (
                artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:artifact_id, 'Revision body.', '[]'::jsonb, 'ready', now())
            RETURNING id
            """
        ),
        {"artifact_id": artifact_id},
    ).scalar_one()
    db.execute(
        text(
            "UPDATE library_intelligence_artifacts "
            "SET current_revision_id = :revision_id WHERE id = :artifact_id"
        ),
        {"revision_id": revision_id, "artifact_id": artifact_id},
    )
    db.flush()
    return (
        ResourceRef(scheme="library_intelligence_artifact", id=artifact_id),
        ResourceRef(scheme="library_intelligence_revision", id=revision_id),
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


def test_exact_li_revision_query_returns_revision_citation_edges(
    db_session: Session, bootstrapped_user: UUID
):
    artifact, revision = _li_artifact_with_revision(db_session, bootstrapped_user)
    target = _media(db_session, bootstrapped_user, "Cited source")
    replace_citations_for_output(
        db_session,
        viewer_id=bootstrapped_user,
        source=revision,
        citations=[
            CitationInput(
                target=target,
                ordinal=1,
                kind="supports",
                snapshot=CitationSnapshot(title="Cited source", excerpt="Evidence"),
            )
        ],
    )

    exact_revision = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(revision,),
            direction="outgoing",
            rollup="exact",
            filters=ConnectionFilters(origins=("citation",)),
            limit=100,
        ),
    )
    exact_artifact = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(artifact,),
            direction="outgoing",
            rollup="exact",
            filters=ConnectionFilters(origins=("citation",)),
            limit=100,
        ),
    )

    assert len(exact_revision.items) == 1
    item = exact_revision.items[0]
    assert item.source_ref == revision
    assert item.target_ref == target
    assert item.ordinal == 1
    assert item.citation is not None
    assert item.other.ref == target
    assert exact_artifact.items == ()


def test_li_artifact_owner_rollup_includes_revision_citation_edges(
    db_session: Session, bootstrapped_user: UUID
):
    artifact, revision = _li_artifact_with_revision(db_session, bootstrapped_user)
    target = _media(db_session, bootstrapped_user, "Rolled-up source")
    replace_citations_for_output(
        db_session,
        viewer_id=bootstrapped_user,
        source=revision,
        citations=[
            CitationInput(
                target=target,
                ordinal=1,
                kind="supports",
                snapshot=CitationSnapshot(title="Rolled-up source", excerpt="Evidence"),
            )
        ],
    )

    page = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(artifact,),
            direction="outgoing",
            rollup="owner",
            filters=ConnectionFilters(origins=("citation",)),
            limit=100,
        ),
    )

    assert len(page.items) == 1
    item = page.items[0]
    assert item.direction == "outgoing"
    assert item.source_ref == revision
    assert item.target_ref == target
    assert item.other.ref == target
