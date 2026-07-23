"""Integration tests for the resource graph connection read model."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock
from nexus.services.resource_graph import citations
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
    create_test_conversation_with_message,
    create_test_fragment,
    create_test_highlight,
    create_test_library,
    create_test_library_artifact,
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


def _note_block(db: Session, user_id: UUID, body: str) -> ResourceRef:
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph"},
        body_text=body,
    )
    db.add(block)
    db.flush()
    return ResourceRef(scheme="note_block", id=block.id)


def _attach_link_note(db: Session, user_id: UUID, note: ResourceRef, *endpoints: ResourceRef):
    for endpoint in endpoints:
        create_edge(
            db,
            viewer_id=user_id,
            input=EdgeCreate(source=note, target=endpoint, kind="context", origin="link_note"),
        )


def _dossier_artifact_with_revision(
    db: Session, user_id: UUID
) -> tuple[ResourceRef, ResourceRef]:
    library_id = create_test_library(db, user_id, "Connection Intelligence")
    artifact_id, revision_id = create_test_library_artifact(
        db,
        library_id=library_id,
        requester_user_id=user_id,
        content_md="Revision body.",
    )
    return (
        ResourceRef(scheme="artifact", id=artifact_id),
        ResourceRef(scheme="artifact_revision", id=revision_id),
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


def test_neutral_link_is_undirected_with_far_endpoint_as_other(
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
    assert item.direction == "undirected"
    assert item.source_ref == source
    assert item.target_ref == target
    assert item.other.ref == target
    assert item.link_note is None


def test_owner_rollup_matches_media_child_refs(db_session: Session, bootstrapped_user: UUID):
    # A highlight is the durable user-linkable media child (derived
    # fragment/span rows are materialize_passage candidates, never direct user
    # endpoints): querying the owning media with rollup="owner" must surface
    # an edge landing on it.
    source = _media(db_session, bootstrapped_user, "source")
    media = _media(db_session, bootstrapped_user, "target media")
    fragment_id = create_test_fragment(db_session, media.id, "Fragment body")
    highlight = ResourceRef(
        scheme="highlight",
        id=create_test_highlight(db_session, bootstrapped_user, fragment_id),
    )
    edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=source, target=highlight, kind="context", origin="user"),
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
    assert item.direction == "undirected"
    assert item.target_ref == highlight
    assert item.other.ref == source


def test_link_note_motif_folds_onto_its_link_and_is_never_bare(
    db_session: Session, bootstrapped_user: UUID
):
    a = _media(db_session, bootstrapped_user, "A")
    b = _media(db_session, bootstrapped_user, "B")
    link = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=a, target=b, kind="context", origin="user"),
    )
    note = _note_block(db_session, bootstrapped_user, "Why these two relate")
    _attach_link_note(db_session, bootstrapped_user, note, a, b)

    for ref in (a, b):
        page = query_connections(
            db_session,
            viewer_id=bootstrapped_user,
            query=ConnectionQuery(
                refs=(ref,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(),
                limit=100,
            ),
        )
        assert all(item.origin != "link_note" for item in page.items), (
            "structural attachment edges must never render as their own connection"
        )
        item = next(item for item in page.items if item.edge_id == link.id)
        assert item.link_note is not None
        assert item.link_note.ref == note
        assert item.link_note.preview == "Why these two relate"


def test_link_note_folding_ignores_other_links_notes(db_session: Session, bootstrapped_user: UUID):
    """A note attaching to a and c must not fold onto the a-b Link."""
    a = _media(db_session, bootstrapped_user, "A")
    b = _media(db_session, bootstrapped_user, "B")
    c = _media(db_session, bootstrapped_user, "C")
    link_ab = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=a, target=b, kind="context", origin="user"),
    )
    other_note = _note_block(db_session, bootstrapped_user, "About a and c")
    _attach_link_note(db_session, bootstrapped_user, other_note, a, c)

    page = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(a,),
            direction="both",
            rollup="exact",
            filters=ConnectionFilters(),
            limit=100,
        ),
    )
    item = next(item for item in page.items if item.edge_id == link_ab.id)
    assert item.link_note is None, "only the note attaching to BOTH a and b folds in"


def test_structural_link_note_rows_are_suppressed_from_note_reads(
    db_session: Session, bootstrapped_user: UUID
):
    a = _media(db_session, bootstrapped_user, "A")
    b = _media(db_session, bootstrapped_user, "B")
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=a, target=b, kind="context", origin="user"),
    )
    note = _note_block(db_session, bootstrapped_user, "rationale")
    _attach_link_note(db_session, bootstrapped_user, note, a, b)

    page = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(note,),
            direction="both",
            rollup="exact",
            filters=ConnectionFilters(),
            limit=100,
        ),
    )
    assert page.items == (), "the note_block's own link_note edges never surface bare"


def test_exact_li_revision_query_returns_revision_citation_edges(
    db_session: Session, bootstrapped_user: UUID
):
    artifact, revision = _dossier_artifact_with_revision(db_session, bootstrapped_user)
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
    artifact, revision = _dossier_artifact_with_revision(db_session, bootstrapped_user)
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


def test_connection_page_resolves_repeated_citation_target_once(
    db_session: Session,
    bootstrapped_user: UUID,
    monkeypatch: pytest.MonkeyPatch,
):
    media = _media(db_session, bootstrapped_user, "Repeated citation target")
    fragment = ResourceRef(
        scheme="fragment",
        id=create_test_fragment(db_session, media.id, "Repeated evidence"),
    )
    for _index in range(2):
        _conversation_id, message_id = create_test_conversation_with_message(
            db_session,
            bootstrapped_user,
        )
        create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=fragment,
                kind="context",
                origin="citation",
                ordinal=1,
                snapshot=CitationSnapshot(title="Repeated evidence", excerpt="Evidence"),
            ),
        )

    call_count = 0
    original = citations.reader_target_for_citation_target

    def counted_reader_target(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(citations, "reader_target_for_citation_target", counted_reader_target)
    page = query_connections(
        db_session,
        viewer_id=bootstrapped_user,
        query=ConnectionQuery(
            refs=(media,),
            direction="incoming",
            rollup="owner",
            filters=ConnectionFilters(origins=("citation",)),
            limit=100,
        ),
    )

    assert len(page.items) == 2
    assert call_count == 1
