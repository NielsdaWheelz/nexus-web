"""Integration tests for the graph write owner (§18.1).

Covers edge-creation rejections, citation ordinal density/uniqueness, bare-pair
dedup (including the undirected user check), ``replace_edges_for_origin``
scoping, the two cleanup rules, and identity-merge repoint with collision drop.
Assertions go through the package's public surface.
"""

from __future__ import annotations

from typing import cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, NoteBlock, ResourceEdge
from nexus.errors import ApiError, InvalidRequestError, NotFoundError
from nexus.schemas.highlights import CreateHighlightRequest
from nexus.services.highlights import create_highlight_for_fragment
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.resource_graph import adjacency as graph_adjacency
from nexus.services.resource_graph.citations import (
    build_citation_outs,
    record_citation,
    replace_citations_for_output,
)
from nexus.services.resource_graph.cleanup import (
    assert_no_dangling_bare_edges,
    delete_edges_for_deleted_resource,
    detach_link_note_motif,
)
from nexus.services.resource_graph.connections import query_connections
from nexus.services.resource_graph.edges import (
    create_edge,
    delete_edge,
    replace_edges_for_origin,
)
from nexus.services.resource_graph.refs import ResourceRef, ResourceScheme
from nexus.services.resource_graph.schemas import (
    CitationInput,
    CitationSnapshot,
    ConnectionFilters,
    ConnectionQuery,
    EdgeCreate,
    EdgeKind,
    EdgeOrigin,
    EdgeOut,
)
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
    create_test_conversation_with_message,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.test_resource_graph_resolve import _make_page

pytestmark = pytest.mark.integration

_SNAPSHOT = CitationSnapshot(title="Cited Title", excerpt="cited excerpt", deep_link="/media/x#y")


def _connection_edges(
    db: Session,
    *,
    viewer_id: UUID,
    ref: ResourceRef,
    kind: EdgeKind | None = None,
    origin: EdgeOrigin | None = None,
) -> list[EdgeOut]:
    out: list[EdgeOut] = []
    cursor = None
    while True:
        page = query_connections(
            db,
            viewer_id=viewer_id,
            query=ConnectionQuery(
                refs=(ref,),
                direction="both",
                rollup="exact",
                filters=ConnectionFilters(
                    kinds=(kind,) if kind is not None else None,
                    origins=(origin,) if origin is not None else None,
                ),
                limit=100,
                cursor=cursor,
            ),
        )
        out.extend(
            EdgeOut(
                id=edge.edge_id,
                source=edge.source_ref,
                target=edge.target_ref,
                kind=edge.kind,
                origin=edge.origin,
                source_order_key=edge.source_order_key,
                target_order_key=edge.target_order_key,
                ordinal=edge.ordinal,
                snapshot=edge.snapshot,
                created_at=edge.created_at,
            )
            for edge in page.items
        )
        if page.next_cursor is None:
            return out
        cursor = page.next_cursor


def _media_ref(db: Session, user_id: UUID, *, title: str = "Edge Media") -> ResourceRef:
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    media_id = create_test_media_in_library(db, user_id, library_id, title=title)
    return ResourceRef(scheme="media", id=media_id)


def _page_ref(db: Session, user_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="page", id=_make_page(db, user_id))


def _note_block_ref(db: Session, user_id: UUID, *, text: str = "Block") -> ResourceRef:
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph"},
        body_text=text,
    )
    db.add(block)
    db.flush()
    return ResourceRef(scheme="note_block", id=block.id)


def _message_ref(db: Session, user_id: UUID) -> ResourceRef:
    _conversation_id, message_id = create_test_conversation_with_message(db, user_id)
    return ResourceRef(scheme="message", id=message_id)


def _indexed_note_refs(db: Session, user_id: UUID) -> tuple[ResourceRef, ResourceRef, ResourceRef]:
    block = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={
            "type": "paragraph",
            "content": [{"type": "text", "text": "A cited note block for graph evidence."}],
        },
        body_text="A cited note block for graph evidence.",
    )
    db.add(block)
    db.flush()
    result = rebuild_note_content_index(db, note_block_id=block.id, reason="test")
    assert result.status == "ready", f"expected indexed note, got {result.status}"
    row = (
        db.execute(
            text(
                """
                SELECT id, primary_evidence_span_id
                FROM content_chunks
                WHERE owner_kind = 'note_block'
                  AND owner_id = :note_block_id
                ORDER BY chunk_idx ASC
                LIMIT 1
                """
            ),
            {"note_block_id": block.id},
        )
        .mappings()
        .one()
    )
    assert row["primary_evidence_span_id"] is not None, "note chunk should produce evidence"
    return (
        ResourceRef(scheme="note_block", id=block.id),
        ResourceRef(scheme="content_chunk", id=row["id"]),
        ResourceRef(scheme="evidence_span", id=row["primary_evidence_span_id"]),
    )


def _bare(source: ResourceRef, target: ResourceRef, *, origin: EdgeOrigin = "user") -> EdgeCreate:
    return EdgeCreate(source=source, target=target, kind="context", origin=origin)


# =============================================================================
# Creation validation (AC20)
# =============================================================================


def test_create_edge_rejects_missing_target(db_session: Session, bootstrapped_user: UUID):
    source = _page_ref(db_session, bootstrapped_user)
    missing_target = ResourceRef(scheme="media", id=uuid4())
    with pytest.raises(NotFoundError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, missing_target))


def test_create_edge_rejects_missing_source(db_session: Session, bootstrapped_user: UUID):
    target = _media_ref(db_session, bootstrapped_user)
    missing_source = ResourceRef(scheme="page", id=uuid4())
    with pytest.raises(NotFoundError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(missing_source, target))


def test_create_edge_rejects_user_link_to_external_snapshot_target(
    db_session: Session, bootstrapped_user: UUID
):
    source = _page_ref(db_session, bootstrapped_user)
    target = ResourceRef(scheme="external_snapshot", id=uuid4())
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, target))


def _highlight_and_span_refs(db: Session, user_id: UUID) -> tuple[ResourceRef, ResourceRef]:
    """A user Link/stance source (highlight in doc A) + a derived span in doc B."""
    source_media = create_searchable_media(db, user_id, title="Cite From Doc")
    fragment_id = db.execute(
        select(Fragment.id).where(Fragment.media_id == source_media)
    ).scalar_one()
    highlight = create_highlight_for_fragment(
        db,
        user_id,
        fragment_id,
        CreateHighlightRequest(start_offset=0, end_offset=4, color="yellow"),
    )
    target_media = create_searchable_media(db, user_id, title="Cite To Doc")
    span_id = db.scalar(
        text(
            "SELECT primary_evidence_span_id FROM content_chunks"
            " WHERE owner_kind = 'media' AND owner_id = :id"
            " AND primary_evidence_span_id IS NOT NULL ORDER BY chunk_idx LIMIT 1"
        ),
        {"id": target_media},
    )
    assert span_id is not None
    return (
        ResourceRef(scheme="highlight", id=highlight.id),
        ResourceRef(scheme="evidence_span", id=span_id),
    )


def test_user_edges_carry_no_snapshot_and_reject_derived_span_targets(
    db_session: Session, bootstrapped_user: UUID
):
    # Link (kind=context) and stance (supports/contradicts) mint neutral
    # user-origin edges with no snapshot; the CHECK forbids any. A derived
    # evidence_span is a materialize_passage candidate (Invariant 4) that the
    # Link service must convert into a passage_anchor — never a direct
    # user-edge endpoint.
    source, span = _highlight_and_span_refs(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user, title="Link To Doc")
    for kind in cast("list[EdgeKind]", ["context", "supports", "contradicts"]):
        edge = create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(source=source, target=target, kind=kind, origin="user"),
        )
        assert edge.origin == "user"
        assert edge.snapshot is None
        assert edge.ordinal is None
        delete_edge(db_session, viewer_id=bootstrapped_user, edge_id=edge.id)

    with pytest.raises(InvalidRequestError):
        create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(source=source, target=span, kind="context", origin="user"),
        )

    with pytest.raises(InvalidRequestError):
        create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(
                source=source, target=target, kind="context", origin="user", snapshot=_SNAPSHOT
            ),
        )

    leaked = db_session.scalar(
        text("SELECT count(*) FROM resource_edges WHERE origin = 'user' AND snapshot IS NOT NULL")
    )
    assert leaked == 0


def test_create_edge_rejects_unknown_kind(db_session: Session, bootstrapped_user: UUID):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(source=source, target=target, kind=cast("EdgeKind", "about"), origin="user")
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_unknown_origin(db_session: Session, bootstrapped_user: UUID):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source, target=target, kind="context", origin=cast("EdgeOrigin", "robot")
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_ordinal_without_snapshot(db_session: Session, bootstrapped_user: UUID):
    source = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(source=source, target=target, kind="context", origin="citation", ordinal=1)
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


@pytest.mark.parametrize("source_scheme", ["conversation", "artifact"])
def test_create_edge_rejects_ordinal_citation_from_non_output_source(
    db_session: Session, bootstrapped_user: UUID, source_scheme: str
):
    source = ResourceRef(scheme=cast(ResourceScheme, source_scheme), id=uuid4())
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source,
        target=target,
        kind="context",
        origin="citation",
        ordinal=1,
        snapshot=_SNAPSHOT,
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_non_synapse_bare_snapshot(
    db_session: Session, bootstrapped_user: UUID
):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source,
        target=target,
        kind="context",
        origin="user",
        snapshot=_SNAPSHOT,
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_bare_citation_snapshot(db_session: Session, bootstrapped_user: UUID):
    source = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source,
        target=target,
        kind="context",
        origin="citation",
        snapshot=_SNAPSHOT,
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_allows_synapse_snapshot_on_bare_edge(
    db_session: Session, bootstrapped_user: UUID
):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=source, target=target, kind="context", origin="synapse", snapshot=_SNAPSHOT
        ),
    )
    assert edge.ordinal is None and edge.snapshot == _SNAPSHOT, (
        f"bare-edge snapshot must persist; got {edge}"
    )


@pytest.mark.parametrize(
    "snapshot",
    [
        CitationSnapshot(title="Missing rationale"),
        CitationSnapshot(excerpt=" "),
    ],
)
def test_create_edge_rejects_synapse_snapshot_without_excerpt(
    db_session: Session, bootstrapped_user: UUID, snapshot: CitationSnapshot
):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source,
        target=target,
        kind="context",
        origin="synapse",
        snapshot=snapshot,
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_synapse_without_snapshot(db_session: Session, bootstrapped_user: UUID):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(source=source, target=target, kind="context", origin="synapse")
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_synapse_target_outside_candidate_vocabulary(
    db_session: Session, bootstrapped_user: UUID
):
    bad = EdgeCreate(
        source=_page_ref(db_session, bootstrapped_user),
        target=ResourceRef(scheme="artifact_revision", id=uuid4()),
        kind="context",
        origin="synapse",
        snapshot=_SNAPSHOT,
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_non_positive_ordinal(db_session: Session, bootstrapped_user: UUID):
    source = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source,
        target=target,
        kind="context",
        origin="citation",
        ordinal=0,
        snapshot=_SNAPSHOT,
    )
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


# =============================================================================
# Citation ordinals: uniqueness and density
# =============================================================================


def test_record_citation_rejects_duplicate_ordinal_per_source(
    db_session: Session, bootstrapped_user: UUID
):
    source = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    record_citation(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        target=target,
        ordinal=1,
        kind="context",
        snapshot=_SNAPSHOT,
    )
    with pytest.raises(InvalidRequestError):
        record_citation(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
            target=_media_ref(db_session, bootstrapped_user, title="Other Media"),
            ordinal=1,
            kind="context",
            snapshot=_SNAPSHOT,
        )


def test_replace_citations_rejects_non_dense_ordinals(db_session: Session, bootstrapped_user: UUID):
    source = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    with pytest.raises(InvalidRequestError):
        replace_citations_for_output(
            db_session,
            viewer_id=bootstrapped_user,
            source=source,
            citations=[
                CitationInput(target=target, ordinal=1, kind="supports", snapshot=_SNAPSHOT),
                CitationInput(target=target, ordinal=3, kind="supports", snapshot=_SNAPSHOT),
            ],
        )


def test_replace_citations_swaps_the_citation_set(db_session: Session, bootstrapped_user: UUID):
    source = _message_ref(db_session, bootstrapped_user)
    first = _media_ref(db_session, bootstrapped_user, title="First Source")
    second = _media_ref(db_session, bootstrapped_user, title="Second Source")
    replace_citations_for_output(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        citations=[
            CitationInput(target=first, ordinal=1, kind="supports", snapshot=_SNAPSHOT),
            CitationInput(target=second, ordinal=2, kind="contradicts", snapshot=_SNAPSHOT),
        ],
    )

    replace_citations_for_output(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        citations=[CitationInput(target=second, ordinal=1, kind="context", snapshot=_SNAPSHOT)],
    )

    outs = build_citation_outs(db_session, viewer_id=bootstrapped_user, source=source)
    assert [(out.ordinal, out.role, out.target_ref.id) for out in outs] == [
        (1, "context", second.id)
    ], f"Replace-set must fully swap the citation set; got {outs}"
    assert outs[0].deep_link == _SNAPSHOT.deep_link, (
        f"deep_link must be lifted from the edge snapshot; got {outs[0].deep_link}"
    )


# =============================================================================
# Bare-pair dedup
# =============================================================================


def test_create_edge_returns_existing_neutral_link_idempotently(
    db_session: Session, bootstrapped_user: UUID
):
    """A duplicate neutral Link is successful idempotency, not another edge (§ Mutation APIs)."""
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    first = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, target))
    again = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, target))
    assert again.id == first.id, "the exact same Link row is returned, not a duplicate"
    rows = db_session.scalar(
        text("SELECT count(*) FROM resource_edges WHERE origin = 'user' AND kind = 'context'")
    )
    assert rows == 1


def test_user_link_reverse_creation_returns_existing_link(
    db_session: Session, bootstrapped_user: UUID
):
    """Reverse creation resolves to the existing canonical Link, either orientation."""
    a = _page_ref(db_session, bootstrapped_user)
    b = _media_ref(db_session, bootstrapped_user)
    first = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(a, b, origin="user"))
    reverse = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(b, a, origin="user"))
    assert reverse.id == first.id
    assert reverse.source == a and reverse.target == b, "the stored orientation is preserved"


def test_machine_origin_dedup_is_directed_only(db_session: Session, bootstrapped_user: UUID):
    """The undirected check is user-link semantics; machine writers stay directed."""
    a = _note_block_ref(db_session, bootstrapped_user)
    b = _media_ref(db_session, bootstrapped_user)
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(a, b, origin="user"))
    reverse = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=b,
            target=a,
            kind="context",
            origin="synapse",
            snapshot=_SNAPSHOT,
        ),
    )
    assert reverse.source == b and reverse.target == a, (
        "A reverse-direction machine edge must coexist with a user link"
    )


def test_same_directed_pair_can_exist_under_different_origins(
    db_session: Session, bootstrapped_user: UUID
):
    source = _note_block_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    user_edge = create_edge(
        db_session, viewer_id=bootstrapped_user, input=_bare(source, target, origin="user")
    )
    note_body_edge = create_edge(
        db_session, viewer_id=bootstrapped_user, input=_bare(source, target, origin="note_body")
    )

    assert user_edge.id != note_body_edge.id
    edges = _connection_edges(db_session, viewer_id=bootstrapped_user, ref=source)
    assert {(edge.origin, edge.target.id) for edge in edges} == {
        ("user", target.id),
        ("note_body", target.id),
    }


def test_user_context_edges_allow_source_order_key(db_session: Session, bootstrapped_user: UUID):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)

    edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=source,
            target=target,
            kind="context",
            origin="user",
            source_order_key="0000000001",
        ),
    )
    assert edge.source_order_key == "0000000001"

    with pytest.raises(InvalidRequestError):
        create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(
                source=source,
                target=_media_ref(db_session, bootstrapped_user, title="Ordered Stance"),
                kind="supports",
                origin="user",
                source_order_key="0000000002",
            ),
        )


def test_conversation_context_edges_allow_source_order_key(
    db_session: Session, bootstrapped_user: UUID
):
    source = ResourceRef(
        scheme="conversation",
        id=create_test_conversation(db_session, bootstrapped_user),
    )
    target = _media_ref(db_session, bootstrapped_user)

    user_context_edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=source,
            target=target,
            kind="context",
            origin="user",
            source_order_key="0000000001",
        ),
    )
    assert user_context_edge.source_order_key == "0000000001"

    citation_context_edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=source,
            target=_page_ref(db_session, bootstrapped_user),
            kind="context",
            origin="citation",
            source_order_key="0000000002",
        ),
    )

    assert citation_context_edge.source_order_key == "0000000002"

    system_context_edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=source,
            target=_media_ref(db_session, bootstrapped_user, title="System Context"),
            kind="context",
            origin="system",
            source_order_key="0000000003",
        ),
    )

    assert system_context_edge.source_order_key == "0000000003"


def test_conversation_source_order_key_rejects_non_context_origins(
    db_session: Session, bootstrapped_user: UUID
):
    source = ResourceRef(
        scheme="conversation",
        id=create_test_conversation(db_session, bootstrapped_user),
    )
    target = _media_ref(db_session, bootstrapped_user)

    for origin in ("note_body", "highlight_note", "synapse"):
        bad = EdgeCreate(
            source=source,
            target=target,
            kind="context",
            origin=cast(EdgeOrigin, origin),
            source_order_key="0000000001",
        )
        with pytest.raises(InvalidRequestError):
            create_edge(db_session, viewer_id=bootstrapped_user, input=bad)


def test_create_edge_rejects_unowned_origin_shapes(db_session: Session, bootstrapped_user: UUID):
    page = _page_ref(db_session, bootstrapped_user)
    media = _media_ref(db_session, bootstrapped_user)
    conversation = ResourceRef(
        scheme="conversation",
        id=create_test_conversation(db_session, bootstrapped_user),
    )

    for edge in (
        EdgeCreate(source=page, target=media, kind="context", origin="citation"),
        EdgeCreate(source=page, target=media, kind="context", origin="system"),
        EdgeCreate(source=media, target=page, kind="context", origin="note_body"),
        EdgeCreate(source=conversation, target=media, kind="context", origin="synapse"),
    ):
        with pytest.raises(InvalidRequestError):
            create_edge(db_session, viewer_id=bootstrapped_user, input=edge)


def test_document_embed_origin_accepts_media_to_media_context_edge(
    db_session: Session, bootstrapped_user: UUID
):
    parent = _media_ref(db_session, bootstrapped_user, title="Parent article")
    child = _media_ref(db_session, bootstrapped_user, title="Embedded video")

    edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=parent,
            target=child,
            kind="context",
            origin="document_embed",
        ),
    )

    assert edge.source == parent
    assert edge.target == child
    assert edge.kind == "context"
    assert edge.origin == "document_embed"
    assert edge.source_order_key is None
    assert edge.target_order_key is None
    assert edge.ordinal is None
    assert edge.snapshot is None


def test_document_embed_origin_rejects_non_media_refs_and_edge_metadata(
    db_session: Session, bootstrapped_user: UUID
):
    parent = _media_ref(db_session, bootstrapped_user, title="Parent article")
    child = _media_ref(db_session, bootstrapped_user, title="Embedded video")
    page = _page_ref(db_session, bootstrapped_user)

    invalid_edges = (
        EdgeCreate(source=parent, target=page, kind="context", origin="document_embed"),
        EdgeCreate(source=page, target=child, kind="context", origin="document_embed"),
        EdgeCreate(
            source=parent,
            target=child,
            kind=cast(EdgeKind, "supports"),
            origin="document_embed",
        ),
        EdgeCreate(
            source=parent,
            target=child,
            kind="context",
            origin="document_embed",
            source_order_key="0000000001",
        ),
        EdgeCreate(
            source=parent,
            target=child,
            kind="context",
            origin="document_embed",
            target_order_key="0000000001",
        ),
        EdgeCreate(
            source=parent,
            target=child,
            kind="context",
            origin="document_embed",
            ordinal=1,
            snapshot=_SNAPSHOT,
        ),
        EdgeCreate(
            source=parent,
            target=child,
            kind="context",
            origin="document_embed",
            snapshot=_SNAPSHOT,
        ),
    )

    for edge in invalid_edges:
        with pytest.raises(InvalidRequestError):
            create_edge(db_session, viewer_id=bootstrapped_user, input=edge)


def test_user_ordered_adjacency_allows_shared_target_and_rejects_target_order_key(
    db_session: Session, bootstrapped_user: UUID
):
    page = _page_ref(db_session, bootstrapped_user)
    other_page = _page_ref(db_session, bootstrapped_user)
    block = _note_block_ref(db_session, bootstrapped_user)

    edge_ids = graph_adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=page,
        targets=[graph_adjacency.OrderedTarget(block, "0000000001")],
    )
    edge = db_session.get(ResourceEdge, edge_ids[0])
    assert edge is not None

    assert edge.source_order_key == "0000000001"
    assert edge.target_order_key is None
    assert edge.origin == "user"

    shared_edge_ids = graph_adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=other_page,
        targets=[graph_adjacency.OrderedTarget(block, "0000000001")],
    )
    shared = db_session.get(ResourceEdge, shared_edge_ids[0])
    assert shared is not None
    assert shared.target_scheme == block.scheme
    assert shared.target_id == block.id

    with pytest.raises(InvalidRequestError):
        create_edge(
            db_session,
            viewer_id=bootstrapped_user,
            input=EdgeCreate(
                source=page,
                target=_note_block_ref(db_session, bootstrapped_user, text="Reserved order"),
                kind="context",
                origin="user",
                source_order_key="0000000003",
                target_order_key="0000000001",
            ),
        )


def test_link_stance_and_ordered_occurrence_coexist_on_one_pair(
    db_session: Session, bootstrapped_user: UUID
):
    """A Link, a stance, and an ordered occurrence may share endpoints (AC4)."""
    page = _page_ref(db_session, bootstrapped_user)
    block = _note_block_ref(db_session, bootstrapped_user)

    graph_adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=page,
        targets=[graph_adjacency.OrderedTarget(block, "0000000001")],
    )
    link = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, block))
    stance = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=page, target=block, kind="supports", origin="user"),
    )

    rows = db_session.execute(
        text(
            "SELECT kind, source_order_key FROM resource_edges"
            " WHERE user_id = :uid AND origin = 'user'"
            " AND source_scheme = 'page' AND source_id = :sid"
            " AND target_scheme = 'note_block' AND target_id = :tid"
        ),
        {"uid": bootstrapped_user, "sid": page.id, "tid": block.id},
    ).all()
    assert {(kind, order is not None) for kind, order in rows} == {
        ("context", True),  # ordered occurrence
        ("context", False),  # neutral Link
        ("supports", False),  # stance
    }, f"Link, stance, and ordered occurrence must all survive; got {rows}"
    assert link.source_order_key is None and stance.kind == "supports"


def test_replace_ordered_targets_rejects_duplicate_target_ref(
    db_session: Session, bootstrapped_user: UUID
):
    """Two order keys pointing at one target in a single set is rejected in app
    validation now that the broad ordinal-null pair index is gone."""
    page = _page_ref(db_session, bootstrapped_user)
    block = _note_block_ref(db_session, bootstrapped_user)
    with pytest.raises(ApiError):
        graph_adjacency.replace_ordered_targets(
            db_session,
            user_id=bootstrapped_user,
            source=page,
            targets=[
                graph_adjacency.OrderedTarget(block, "0000000001"),
                graph_adjacency.OrderedTarget(block, "0000000002"),
            ],
        )


def test_replace_ordered_targets_preserves_a_neutral_link_on_the_same_pair(
    db_session: Session, bootstrapped_user: UUID
):
    """Adding an outline occurrence must not silently destroy an existing Link
    on the same endpoints (the removed pre-delete data-loss bug)."""
    page = _page_ref(db_session, bootstrapped_user)
    block = _note_block_ref(db_session, bootstrapped_user)
    link = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, block))

    graph_adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=page,
        targets=[graph_adjacency.OrderedTarget(block, "0000000001")],
    )

    assert db_session.get(ResourceEdge, link.id) is not None, "the neutral Link must survive"


# =============================================================================
# replace_edges_for_origin scoping
# =============================================================================


def test_replace_edges_for_origin_replaces_exactly_its_set(
    db_session: Session, bootstrapped_user: UUID
):
    source = _note_block_ref(db_session, bootstrapped_user)
    a = _media_ref(db_session, bootstrapped_user, title="Ref A")
    b = _media_ref(db_session, bootstrapped_user, title="Ref B")
    c = _media_ref(db_session, bootstrapped_user, title="Ref C")
    d = _media_ref(db_session, bootstrapped_user, title="Ref D")

    replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        origin="note_body",
        edges=[_bare(source, a, origin="note_body"), _bare(source, b, origin="note_body")],
    )
    user_edge = create_edge(
        db_session, viewer_id=bootstrapped_user, input=_bare(source, c, origin="user")
    )

    replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        origin="note_body",
        edges=[_bare(source, b, origin="note_body"), _bare(source, d, origin="note_body")],
    )

    edges = _connection_edges(db_session, viewer_id=bootstrapped_user, ref=source)
    by_origin: dict[str, set[UUID]] = {}
    for edge in edges:
        by_origin.setdefault(edge.origin, set()).add(edge.target.id)
    assert by_origin.get("note_body") == {b.id, d.id}, (
        f"note_body set must be exactly the new refs; got {by_origin}"
    )
    assert by_origin.get("user") == {c.id}, (
        f"The user link must survive a note_body replace-set; got {by_origin}"
    )
    assert any(edge.id == user_edge.id for edge in edges), "user edge row must be untouched"


def test_replace_edges_drops_self_target_member(db_session: Session, bootstrapped_user: UUID):
    """A machine-extracted set (e.g. a note body that refs its own block) must drop
    the self-target member, not raise or store a self-edge (§5.4)."""
    source = _note_block_ref(db_session, bootstrapped_user)
    other = _media_ref(db_session, bootstrapped_user)

    created = replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        origin="note_body",
        edges=[
            _bare(source, source, origin="note_body"),
            _bare(source, other, origin="note_body"),
        ],
    )

    assert [edge.target.id for edge in created] == [other.id], (
        f"The self-target member must be dropped; only real targets remain; got {created}"
    )
    edges = _connection_edges(db_session, viewer_id=bootstrapped_user, ref=source)
    assert all(edge.source != edge.target for edge in edges), (
        f"No self-edge may be stored from a replace-set; got "
        f"{[(e.source.uri, e.target.uri) for e in edges]}"
    )


def test_replace_edges_keeps_pairs_owned_by_another_origin(
    db_session: Session, bootstrapped_user: UUID
):
    source = _note_block_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    user_edge = create_edge(
        db_session, viewer_id=bootstrapped_user, input=_bare(source, target, origin="user")
    )

    created = replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=source,
        origin="note_body",
        edges=[_bare(source, target, origin="note_body")],
    )

    assert len(created) == 1, "A note_body edge is distinct from the user's explicit link"
    edges = _connection_edges(db_session, viewer_id=bootstrapped_user, ref=source)
    assert {(edge.origin, edge.id) for edge in edges} == {
        ("user", user_edge.id),
        ("note_body", created[0].id),
    }, f"Both origins must coexist; got {[(e.origin, e.target.uri) for e in edges]}"


# =============================================================================
# Cleanup: the two rules (§9.6)
# =============================================================================


def test_cleanup_bare_edges_die_with_either_endpoint_cited_edges_survive_target(
    db_session: Session, bootstrapped_user: UUID
):
    message = _message_ref(db_session, bootstrapped_user)
    page = _page_ref(db_session, bootstrapped_user)
    other = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user, title="Doomed Media")

    cited = record_citation(
        db_session,
        viewer_id=bootstrapped_user,
        source=message,
        target=target,
        ordinal=1,
        kind="supports",
        snapshot=_SNAPSHOT,
    )
    # target appears at both endpoints, with distinct other-ends so undirected
    # user dedup does not collide: a bare edge into it and one out of it.
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, target))
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(target, other))

    with pytest.raises(AssertionError):
        assert_no_dangling_bare_edges(db_session, ref=target)

    delete_edges_for_deleted_resource(db_session, ref=target)

    assert_no_dangling_bare_edges(db_session, ref=target)
    remaining = _connection_edges(db_session, viewer_id=bootstrapped_user, ref=target)
    assert [edge.id for edge in remaining] == [cited.id], (
        f"Rule 1: the cited edge must outlive its target; got {remaining}"
    )
    assert remaining[0].ordinal == 1 and remaining[0].snapshot is not None, (
        "The surviving citation keeps its ordinal/snapshot for display"
    )


def test_cleanup_cited_edges_die_with_their_source(db_session: Session, bootstrapped_user: UUID):
    message = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    record_citation(
        db_session,
        viewer_id=bootstrapped_user,
        source=message,
        target=target,
        ordinal=1,
        kind="context",
        snapshot=_SNAPSHOT,
    )

    delete_edges_for_deleted_resource(db_session, ref=message)

    assert _connection_edges(db_session, viewer_id=bootstrapped_user, ref=message) == [], (
        "Rule 1: a citation dies with its domain parent (the source)"
    )


# =============================================================================
# Link-note motif cleanup (§ Graph Shapes)
# =============================================================================


def _attach_link_note(
    db: Session, user_id: UUID, note: ResourceRef, *endpoints: ResourceRef
) -> None:
    for endpoint in endpoints:
        create_edge(
            db,
            viewer_id=user_id,
            input=EdgeCreate(source=note, target=endpoint, kind="context", origin="link_note"),
        )


def _link_note_edge_count(db: Session, note: ResourceRef) -> int:
    return db.scalar(
        text(
            "SELECT count(*) FROM resource_edges WHERE origin = 'link_note'"
            " AND source_scheme = 'note_block' AND source_id = :nid"
        ),
        {"nid": note.id},
    )


def test_endpoint_deletion_removes_both_link_note_halves_preserving_note(
    db_session: Session, bootstrapped_user: UUID
):
    a = _media_ref(db_session, bootstrapped_user, title="Endpoint A")
    b = _media_ref(db_session, bootstrapped_user, title="Endpoint B")
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(a, b))
    note = _note_block_ref(db_session, bootstrapped_user, text="why a and b relate")
    _attach_link_note(db_session, bootstrapped_user, note, a, b)
    assert _link_note_edge_count(db_session, note) == 2

    delete_edges_for_deleted_resource(db_session, ref=a)

    assert _link_note_edge_count(db_session, note) == 0, (
        "the sibling half targeting the surviving endpoint dies with the motif"
    )
    assert db_session.get(NoteBlock, note.id) is not None, "note prose is preserved"


def test_detach_link_note_motif_preserves_link_and_note(
    db_session: Session, bootstrapped_user: UUID
):
    a = _media_ref(db_session, bootstrapped_user, title="Detach A")
    b = _media_ref(db_session, bootstrapped_user, title="Detach B")
    link = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(a, b))
    note = _note_block_ref(db_session, bootstrapped_user, text="detachable rationale")
    _attach_link_note(db_session, bootstrapped_user, note, a, b)

    detach_link_note_motif(db_session, viewer_id=bootstrapped_user, a=a, b=b)

    assert _link_note_edge_count(db_session, note) == 0
    assert db_session.get(ResourceEdge, link.id) is not None, "Remove-note keeps the Link"
    assert db_session.get(NoteBlock, note.id) is not None, "note survives as detached prose"


def test_citations_accept_note_owned_evidence_and_build_note_targets(
    db_session: Session, bootstrapped_user: UUID
):
    message = _message_ref(db_session, bootstrapped_user)
    note_block, chunk, span = _indexed_note_refs(db_session, bootstrapped_user)

    for ordinal, target in enumerate((span, chunk, note_block), start=1):
        record_citation(
            db_session,
            viewer_id=bootstrapped_user,
            source=message,
            target=target,
            ordinal=ordinal,
            kind="context",
            snapshot=CitationSnapshot(
                title="Note page",
                excerpt="A cited note block",
                result_type=target.scheme,
                deep_link=f"/notes/{note_block.id}",
            ),
        )

    outs = build_citation_outs(db_session, viewer_id=bootstrapped_user, source=message)

    assert [out.target_ref.type for out in outs] == [
        "evidence_span",
        "content_chunk",
        "note_block",
    ], f"citation read-model should preserve note target grains; got {outs}"
    for out in outs:
        locator = out.locator.model_dump(mode="json") if out.locator is not None else None
        assert out.media_id is None, f"note citations must not expose a media id; got {out}"
        assert locator is not None and locator["type"] == "note_block_offsets", (
            f"note citations must carry note activation locators; got {out}"
        )
        assert locator["block_id"] == str(note_block.id), (
            f"note citation should activate the contained block; got {locator}"
        )


def test_note_block_citation_locator_resolves_nested_block(
    db_session: Session,
    bootstrapped_user: UUID,
):
    message = _message_ref(db_session, bootstrapped_user)
    page_id = _make_page(db_session, bootstrapped_user)
    parent = NoteBlock(
        id=uuid4(),
        user_id=bootstrapped_user,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": "Parent"}]},
        body_text="Parent",
    )
    child = NoteBlock(
        id=uuid4(),
        user_id=bootstrapped_user,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": "Nested child"}]},
        body_text="Nested child",
    )
    db_session.add_all([parent, child])
    db_session.flush()
    graph_adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=ResourceRef(scheme="page", id=page_id),
        targets=[
            graph_adjacency.OrderedTarget(
                ResourceRef(scheme="note_block", id=parent.id),
                "0000000001",
            )
        ],
    )
    graph_adjacency.replace_ordered_targets(
        db_session,
        user_id=bootstrapped_user,
        source=ResourceRef(scheme="note_block", id=parent.id),
        targets=[
            graph_adjacency.OrderedTarget(
                ResourceRef(scheme="note_block", id=child.id),
                "0000000001",
            )
        ],
    )
    record_citation(
        db_session,
        viewer_id=bootstrapped_user,
        source=message,
        target=ResourceRef(scheme="note_block", id=child.id),
        ordinal=1,
        kind="context",
        snapshot=CitationSnapshot(
            title="Nested note page",
            excerpt="Nested child",
            result_type="note_block",
            deep_link=f"/pages/{page_id}",
        ),
    )

    outs = build_citation_outs(db_session, viewer_id=bootstrapped_user, source=message)

    assert len(outs) == 1
    locator = outs[0].locator.model_dump(mode="json") if outs[0].locator is not None else None
    assert locator is not None
    assert locator["type"] == "note_block_offsets"
    assert "page_id" not in locator
    assert locator["block_id"] == str(child.id)
    assert locator["start_offset"] == 0
    assert locator["end_offset"] == len("Nested child")


# =============================================================================
# create_edge self-edge guard
# =============================================================================


def test_create_edge_rejects_self_edge(db_session: Session, bootstrapped_user: UUID):
    """A resource cannot link/cite/support itself (§5.4)."""
    ref = _media_ref(db_session, bootstrapped_user)
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(ref, ref))


# =============================================================================
# delete_edge
# =============================================================================


def test_delete_edge_removes_the_row_and_404s_on_unknown(
    db_session: Session, bootstrapped_user: UUID
):
    page = _page_ref(db_session, bootstrapped_user)
    media = _media_ref(db_session, bootstrapped_user)
    edge = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, media))

    delete_edge(db_session, viewer_id=bootstrapped_user, edge_id=edge.id)

    assert _connection_edges(db_session, viewer_id=bootstrapped_user, ref=page) == []
    with pytest.raises(NotFoundError):
        delete_edge(db_session, viewer_id=bootstrapped_user, edge_id=edge.id)
