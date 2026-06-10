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
from sqlalchemy.orm import Session

from nexus.db.models import Contributor
from nexus.errors import InvalidRequestError, NotFoundError
from nexus.services.resource_graph.citations import (
    build_citation_outs,
    record_citation,
    replace_citations_for_output,
)
from nexus.services.resource_graph.cleanup import (
    assert_no_dangling_bare_edges,
    delete_edges_for_deleted_resource,
)
from nexus.services.resource_graph.edges import (
    create_edge,
    delete_edge,
    list_edges_for_ref,
    replace_edges_for_origin,
    repoint_edges,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import (
    CitationInput,
    CitationSnapshot,
    EdgeCreate,
    EdgeKind,
    EdgeOrigin,
)
from tests.factories import (
    create_test_conversation_with_message,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.test_resource_graph_resolve import _make_page

pytestmark = pytest.mark.integration

_SNAPSHOT = CitationSnapshot(title="Cited Title", excerpt="cited excerpt", deep_link="/media/x#y")


def _media_ref(db: Session, user_id: UUID, *, title: str = "Edge Media") -> ResourceRef:
    library_id = get_user_default_library(db, user_id)
    assert library_id is not None
    media_id = create_test_media_in_library(db, user_id, library_id, title=title)
    return ResourceRef(scheme="media", id=media_id)


def _page_ref(db: Session, user_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="page", id=_make_page(db, user_id))


def _message_ref(db: Session, user_id: UUID) -> ResourceRef:
    _conversation_id, message_id = create_test_conversation_with_message(db, user_id)
    return ResourceRef(scheme="message", id=message_id)


def _contributor_ref(db: Session, *, name: str) -> ResourceRef:
    contributor = Contributor(
        id=uuid4(),
        handle=f"{name.lower().replace(' ', '-')}-{uuid4().hex[:8]}",
        display_name=name,
        sort_name=name,
    )
    db.add(contributor)
    db.commit()
    return ResourceRef(scheme="contributor", id=contributor.id)


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


def test_create_edge_allows_unresolvable_external_snapshot_target(
    db_session: Session, bootstrapped_user: UUID
):
    """external_snapshot targets are exempt from target resolution (§7.3)."""
    source = _page_ref(db_session, bootstrapped_user)
    target = ResourceRef(scheme="external_snapshot", id=uuid4())
    edge = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, target))
    assert edge.target == target, f"external_snapshot target must be accepted; got {edge}"


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


def test_create_edge_rejects_snapshot_without_ordinal(db_session: Session, bootstrapped_user: UUID):
    source = _message_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    bad = EdgeCreate(
        source=source, target=target, kind="context", origin="citation", snapshot=_SNAPSHOT
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


def test_create_edge_rejects_duplicate_directed_pair(db_session: Session, bootstrapped_user: UUID):
    source = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, target))
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(source, target))


def test_user_link_dedup_checks_both_directions(db_session: Session, bootstrapped_user: UUID):
    a = _page_ref(db_session, bootstrapped_user)
    b = _media_ref(db_session, bootstrapped_user)
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(a, b, origin="user"))
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(b, a, origin="user"))


def test_machine_origin_dedup_is_directed_only(db_session: Session, bootstrapped_user: UUID):
    """The undirected check is user-link semantics; machine writers stay directed."""
    a = _page_ref(db_session, bootstrapped_user)
    b = _media_ref(db_session, bootstrapped_user)
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(a, b, origin="user"))
    reverse = create_edge(
        db_session, viewer_id=bootstrapped_user, input=_bare(b, a, origin="note_body")
    )
    assert reverse.source == b and reverse.target == a, (
        "A reverse-direction machine edge must coexist with a user link"
    )


# =============================================================================
# replace_edges_for_origin scoping
# =============================================================================


def test_replace_edges_for_origin_replaces_exactly_its_set(
    db_session: Session, bootstrapped_user: UUID
):
    page = _page_ref(db_session, bootstrapped_user)
    a = _media_ref(db_session, bootstrapped_user, title="Ref A")
    b = _media_ref(db_session, bootstrapped_user, title="Ref B")
    c = _media_ref(db_session, bootstrapped_user, title="Ref C")
    d = _media_ref(db_session, bootstrapped_user, title="Ref D")

    replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=page,
        origin="note_body",
        edges=[_bare(page, a, origin="note_body"), _bare(page, b, origin="note_body")],
    )
    user_edge = create_edge(
        db_session, viewer_id=bootstrapped_user, input=_bare(page, c, origin="user")
    )

    replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=page,
        origin="note_body",
        edges=[_bare(page, b, origin="note_body"), _bare(page, d, origin="note_body")],
    )

    edges = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=page)
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
    page = _page_ref(db_session, bootstrapped_user)
    other = _media_ref(db_session, bootstrapped_user)

    created = replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=page,
        origin="note_body",
        edges=[_bare(page, page, origin="note_body"), _bare(page, other, origin="note_body")],
    )

    assert [edge.target.id for edge in created] == [other.id], (
        f"The self-target member must be dropped; only real targets remain; got {created}"
    )
    edges = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=page)
    assert all(edge.source != edge.target for edge in edges), (
        f"No self-edge may be stored from a replace-set; got "
        f"{[(e.source.uri, e.target.uri) for e in edges]}"
    )


def test_replace_edges_skips_pairs_owned_by_another_origin(
    db_session: Session, bootstrapped_user: UUID
):
    page = _page_ref(db_session, bootstrapped_user)
    target = _media_ref(db_session, bootstrapped_user)
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, target, origin="user"))

    created = replace_edges_for_origin(
        db_session,
        viewer_id=bootstrapped_user,
        source=page,
        origin="note_body",
        edges=[_bare(page, target, origin="note_body")],
    )

    assert created == [], "A pair already owned by a user link must be skipped, not duplicated"
    edges = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=page)
    assert [edge.origin for edge in edges] == ["user"], (
        f"Exactly the user edge must remain; got {[(e.origin, e.target.uri) for e in edges]}"
    )


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
    remaining = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=target)
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

    assert list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=message) == [], (
        "Rule 1: a citation dies with its domain parent (the source)"
    )


# =============================================================================
# Repoint (identity merges)
# =============================================================================


def test_repoint_moves_every_kind_and_keeps_ordinals(db_session: Session, bootstrapped_user: UUID):
    duplicate = _contributor_ref(db_session, name="Dupe Author")
    canonical = _contributor_ref(db_session, name="Canonical Author")
    page = _page_ref(db_session, bootstrapped_user)
    media = _media_ref(db_session, bootstrapped_user)
    message = _message_ref(db_session, bootstrapped_user)

    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, duplicate))
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=duplicate, target=media, kind="supports", origin="user"),
    )
    record_citation(
        db_session,
        viewer_id=bootstrapped_user,
        source=message,
        target=duplicate,
        ordinal=1,
        kind="context",
        snapshot=_SNAPSHOT,
    )

    moved = repoint_edges(
        db_session, viewer_id=bootstrapped_user, from_ref=duplicate, to_ref=canonical
    )

    assert moved == 3, f"All three edges touch the duplicate and must move; got {moved}"
    assert list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=duplicate) == [], (
        "No edge may still reference the merged-away identity"
    )
    repointed = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=canonical)
    assert len(repointed) == 3, f"Every kind moves (bare, stance, citation); got {repointed}"
    citation = next(edge for edge in repointed if edge.ordinal is not None)
    assert citation.ordinal == 1 and citation.snapshot is not None, (
        "Repoint must leave ordinals and snapshots untouched"
    )
    stance = next(edge for edge in repointed if edge.kind == "supports")
    assert stance.source == canonical and stance.target == media, (
        f"Source endpoints repoint too; got {stance}"
    )


def test_repoint_drops_bare_duplicates_on_reverse_collision(
    db_session: Session, bootstrapped_user: UUID
):
    """User links are undirected (§5.4): a merge into the reverse pair must not leave
    a symmetric duplicate that double-renders."""
    duplicate = _contributor_ref(db_session, name="Dupe Author")
    canonical = _contributor_ref(db_session, name="Canonical Author")
    page = _page_ref(db_session, bootstrapped_user)

    # A user link toward the duplicate, plus the *reverse* pair toward canonical.
    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, duplicate))
    kept = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(canonical, page))

    moved = repoint_edges(
        db_session, viewer_id=bootstrapped_user, from_ref=duplicate, to_ref=canonical
    )

    assert moved == 1, f"The reverse-colliding edge is processed (dropped); got {moved}"
    edges = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=canonical)
    assert [edge.id for edge in edges] == [kept.id], (
        f"Repoint must not leave a symmetric user-link pair; got "
        f"{[(e.source.uri, e.target.uri) for e in edges]}"
    )


def test_repoint_drops_edge_that_would_become_a_self_edge(
    db_session: Session, bootstrapped_user: UUID
):
    """Merging A into B when a user link A<->B exists must not mint a B->B self-edge
    (§5.4 has no self-links); the moving row is dropped."""
    duplicate = _contributor_ref(db_session, name="Dupe Author")
    canonical = _contributor_ref(db_session, name="Canonical Author")

    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(duplicate, canonical))

    moved = repoint_edges(
        db_session, viewer_id=bootstrapped_user, from_ref=duplicate, to_ref=canonical
    )

    assert moved == 1, f"The would-be self-edge is processed (dropped); got {moved}"
    edges = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=canonical)
    assert edges == [], (
        f"A repoint collapsing both endpoints must drop the row, not store a self-edge; "
        f"got {[(e.source.uri, e.target.uri) for e in edges]}"
    )


def test_create_edge_rejects_self_edge(db_session: Session, bootstrapped_user: UUID):
    """A resource cannot link/cite/support itself (§5.4)."""
    ref = _media_ref(db_session, bootstrapped_user)
    with pytest.raises(InvalidRequestError):
        create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(ref, ref))


def test_repoint_drops_bare_duplicates_on_collision(db_session: Session, bootstrapped_user: UUID):
    duplicate = _contributor_ref(db_session, name="Dupe Author")
    canonical = _contributor_ref(db_session, name="Canonical Author")
    page = _page_ref(db_session, bootstrapped_user)

    create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, duplicate))
    kept = create_edge(db_session, viewer_id=bootstrapped_user, input=_bare(page, canonical))

    moved = repoint_edges(
        db_session, viewer_id=bootstrapped_user, from_ref=duplicate, to_ref=canonical
    )

    assert moved == 1, f"The colliding edge is processed (dropped); got {moved}"
    edges = list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=canonical)
    assert [edge.id for edge in edges] == [kept.id], (
        f"The pre-existing pair survives; the moving duplicate is dropped; got {edges}"
    )


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

    assert list_edges_for_ref(db_session, viewer_id=bootstrapped_user, ref=page) == []
    with pytest.raises(NotFoundError):
        delete_edge(db_session, viewer_id=bootstrapped_user, edge_id=edge.id)
