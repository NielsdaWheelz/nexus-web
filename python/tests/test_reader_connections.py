"""Integration test for span-grain synapse edges in the reader projection (S3, AC-1).

Confirms the read model is already span-ready (P-4): a ``highlight``/``media`` →
``evidence_span`` synapse edge surfaces in ``list_reader_connections`` anchored at
the span's reader locator, with no new endpoint.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import NoteBlock, ResourceEdge
from nexus.services import passage_anchors
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.reader_connections import list_reader_connections
from nexus.services.resource_graph import edges
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import EdgeCreate
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from tests.factories import create_searchable_media
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def _seed_user(db: Session) -> UUID:
    user_id = create_test_user_id()
    ensure_user_and_default_library(db, user_id)
    return user_id


def _anchor(db: Session, *, user_id: UUID, media_id: UUID, exact: str) -> UUID:
    anchor = passage_anchors.materialize_or_reuse(
        db, user_id=user_id, owner_scheme="media", owner_id=media_id, exact=exact
    )
    db.flush()
    return anchor.id


def _link(db: Session, *, user_id: UUID, a: UUID, b: UUID) -> UUID:
    """Create a neutral Link between two passage anchors in canonical pair order."""
    refs = {(ref.scheme, str(ref.id)): ref for ref in (_pa(a), _pa(b))}
    lo, hi = sorted(refs)
    write = edges.create_link(db, viewer_id=user_id, source=refs[lo], target=refs[hi])
    db.flush()
    return write.edge.id


def _pa(anchor_id: UUID) -> ResourceRef:
    return ResourceRef(scheme="passage_anchor", id=anchor_id)


def _media_link(db: Session, *, user_id: UUID, media_a: UUID, media_b: UUID) -> UUID:
    """A neutral Link between two whole media documents, in canonical pair order."""
    ref_a = ResourceRef(scheme="media", id=media_a)
    ref_b = ResourceRef(scheme="media", id=media_b)
    lo, hi = sorted((ref_a, ref_b), key=lambda ref: (ref.scheme, str(ref.id)))
    write = edges.create_link(db, viewer_id=user_id, source=lo, target=hi)
    db.flush()
    return write.edge.id


def _user_connections(db: Session, *, user_id: UUID, media_id: UUID):
    return list_reader_connections(
        db,
        viewer_id=user_id,
        media_id=media_id,
        origins=("user",),
        source_schemes=None,
        limit=50,
        cursor=None,
    )


def _first_span(db: Session, media_id: UUID) -> UUID:
    return db.scalar(
        text(
            """
            SELECT primary_evidence_span_id
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :id
              AND primary_evidence_span_id IS NOT NULL
            ORDER BY chunk_idx
            LIMIT 1
            """
        ),
        {"id": media_id},
    )


def test_span_grain_synapse_edge_surfaces_anchored(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    target_media = create_searchable_media(db_session, user_id, title="Anchor Work")
    source_media = create_searchable_media(db_session, user_id, title="Resonant Work")
    span_id = _first_span(db_session, target_media)
    assert span_id is not None, "indexed media must carry a primary evidence span"

    db_session.add(
        ResourceEdge(
            user_id=user_id,
            kind="context",
            origin="synapse",
            source_scheme="media",
            source_id=source_media,
            target_scheme="evidence_span",
            target_id=span_id,
            snapshot={"title": "Resonant Work", "excerpt": "It restates the claim."},
        )
    )
    db_session.flush()

    page = list_reader_connections(
        db_session,
        viewer_id=user_id,
        media_id=target_media,
        origins=("synapse",),
        source_schemes=None,
        limit=50,
        cursor=None,
    )

    assert len(page.anchored) == 1, "the span-grain synapse edge must surface anchored"
    row = page.anchored[0]
    assert row.anchor is not None
    assert row.anchor.evidence_span_id == span_id
    assert row.anchor.order_key, "the span anchor carries a reader order key (passage grain)"
    assert row.excerpt == "It restates the claim."


_QUOTE_A = "canonical text for {title}"
_QUOTE_B = "searchable content about various topics"


def test_passage_anchor_rollup_discovers_media_owned_anchors(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Rollup Doc")
    anchor_id = _anchor(
        db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_A.format(title="Rollup Doc")
    )

    children = expand_owned_child_refs(
        db_session, viewer_id=user_id, ref=ResourceRef(scheme="media", id=media_id)
    )

    assert _pa(anchor_id) in children, "media owner rollup must discover its passage anchors"


def test_cross_document_link_anchors_once_in_each_reader(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Alpha Doc")
    media_b = create_searchable_media(db_session, user_id, title="Beta Doc")
    anchor_a = _anchor(
        db_session, user_id=user_id, media_id=media_a, exact=_QUOTE_A.format(title="Alpha Doc")
    )
    anchor_b = _anchor(
        db_session, user_id=user_id, media_id=media_b, exact=_QUOTE_A.format(title="Beta Doc")
    )
    edge_id = _link(db_session, user_id=user_id, a=anchor_a, b=anchor_b)

    page_a = _user_connections(db_session, user_id=user_id, media_id=media_a)
    assert len(page_a.anchored) == 1, "the cross-document Link anchors exactly once in reader A"
    row_a = page_a.anchored[0]
    assert row_a.anchor is not None
    assert row_a.anchor.passage_anchor_id == anchor_a
    assert row_a.connection.direction == "undirected"
    assert row_a.id == f"edge:{edge_id}:anchor:passage_anchor:{anchor_a}"
    assert row_a.connection.other.ref == f"passage_anchor:{anchor_b}"

    page_b = _user_connections(db_session, user_id=user_id, media_id=media_b)
    assert len(page_b.anchored) == 1, "and exactly once in reader B, anchored at its own endpoint"
    row_b = page_b.anchored[0]
    assert row_b.anchor is not None
    assert row_b.anchor.passage_anchor_id == anchor_b
    assert row_b.id == f"edge:{edge_id}:anchor:passage_anchor:{anchor_b}"
    assert row_b.connection.other.ref == f"passage_anchor:{anchor_a}"


def test_same_media_link_emits_two_rows_with_opposite_activation(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Local Doc")
    anchor_1 = _anchor(
        db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_A.format(title="Local Doc")
    )
    anchor_2 = _anchor(db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_B)
    edge_id = _link(db_session, user_id=user_id, a=anchor_1, b=anchor_2)

    page = _user_connections(db_session, user_id=user_id, media_id=media_id)

    assert len(page.anchored) == 2, "a same-media Link between two local passages emits two rows"
    assert page.unanchored == []
    by_anchor = {row.anchor.passage_anchor_id: row for row in page.anchored}
    assert set(by_anchor) == {anchor_1, anchor_2}
    # Each row activates the opposite endpoint.
    assert by_anchor[anchor_1].connection.other.ref == f"passage_anchor:{anchor_2}"
    assert by_anchor[anchor_2].connection.other.ref == f"passage_anchor:{anchor_1}"
    # Distinct, anchor-keyed, stable identities — never a bare edge:{id} collision.
    assert {row.id for row in page.anchored} == {
        f"edge:{edge_id}:anchor:passage_anchor:{anchor_1}",
        f"edge:{edge_id}:anchor:passage_anchor:{anchor_2}",
    }
    assert all(row.connection.direction == "undirected" for row in page.anchored)


def test_same_media_row_identity_is_stable_across_reads(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Stable Doc")
    anchor_1 = _anchor(
        db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_A.format(title="Stable Doc")
    )
    anchor_2 = _anchor(db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_B)
    _link(db_session, user_id=user_id, a=anchor_1, b=anchor_2)

    first = {
        row.id for row in _user_connections(db_session, user_id=user_id, media_id=media_id).anchored
    }
    second = {
        row.id for row in _user_connections(db_session, user_id=user_id, media_id=media_id).anchored
    }
    assert first == second and len(first) == 2, "row identity is stable across independent reads"


def test_whole_media_link_surfaces_peer_not_self(db_session: Session) -> None:
    """A direct whole-media↔whole-media Link anchors nowhere locally, so it becomes
    one unanchored row per reader. The row must name the PEER, never the open
    document, whichever endpoint canonical (scheme, uuid) order stored as target
    — the fallback derives ``other`` from locality, not storage direction (AC17).
    """
    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Whole A")
    media_b = create_searchable_media(db_session, user_id, title="Whole B")
    edge_id = _media_link(db_session, user_id=user_id, media_a=media_a, media_b=media_b)

    page_a = _user_connections(db_session, user_id=user_id, media_id=media_a)
    assert page_a.anchored == []
    assert len(page_a.unanchored) == 1
    row_a = page_a.unanchored[0]
    assert row_a.connection.other.ref == f"media:{media_b}", "reader A must surface peer B, not A"
    assert row_a.id == f"edge:{edge_id}:anchor:media:{media_a}"
    assert row_a.connection.direction == "undirected"

    page_b = _user_connections(db_session, user_id=user_id, media_id=media_b)
    assert len(page_b.unanchored) == 1
    row_b = page_b.unanchored[0]
    assert row_b.connection.other.ref == f"media:{media_a}", "reader B must surface peer A, not B"
    assert row_b.id == f"edge:{edge_id}:anchor:media:{media_b}"


def test_reader_link_note_folds_onto_connection(db_session: Session) -> None:
    """The Link's ordinary note folds onto the reader connection row (Invariant 12,
    AC11) — the reader lane serializes through the shared ``connection_out``.
    """
    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Note A")
    media_b = create_searchable_media(db_session, user_id, title="Note B")
    _media_link(db_session, user_id=user_id, media_a=media_a, media_b=media_b)

    note = NoteBlock(
        id=uuid4(),
        user_id=user_id,
        body_pm_json={"type": "paragraph"},
        body_text="Why these relate",
    )
    db_session.add(note)
    db_session.flush()
    note_ref = ResourceRef(scheme="note_block", id=note.id)
    for endpoint in (
        ResourceRef(scheme="media", id=media_a),
        ResourceRef(scheme="media", id=media_b),
    ):
        edges.create_edge(
            db_session,
            viewer_id=user_id,
            input=EdgeCreate(source=note_ref, target=endpoint, kind="context", origin="link_note"),
        )
    db_session.flush()

    row = _user_connections(db_session, user_id=user_id, media_id=media_a).unanchored[0]
    assert row.connection.link_note is not None, "the Link's note must fold onto the reader row"
    assert row.connection.link_note.note_block_id == note.id
    assert row.connection.link_note.preview == "Why these relate"


def test_passage_anchor_page_loads_each_owner_sources_once(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reader page carrying many same-owner passage-anchor connections reloads the
    owner's normalized sources ONCE, not once per anchor (MAJOR 6).

    The headline use case: a page with N passage-anchor rows all owned by the read
    media. The per-read ``sources_cache`` memoizes the O(fragments) fetch+normalize
    so the loader fires once per distinct owner. Resolution stays LIVE (nothing is
    persisted); the cache lives only for this one ``list_reader_connections`` call.
    """
    from nexus.services import text_quote

    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Sources A")
    media_b = create_searchable_media(db_session, user_id, title="Sources B")

    # Three distinct local passage anchors on media_a, each linked to the whole
    # peer document. The peer (media scheme) resolves without loading sources, so
    # only media_a's anchors drive the sources loader.
    media_b_ref = ResourceRef(scheme="media", id=media_b)
    for exact in (
        _QUOTE_A.format(title="Sources A"),
        _QUOTE_B,
        "It contains searchable content",
    ):
        pa = _pa(_anchor(db_session, user_id=user_id, media_id=media_a, exact=exact))
        lo, hi = sorted((pa, media_b_ref), key=lambda ref: (ref.scheme, str(ref.id)))
        edges.create_link(db_session, viewer_id=user_id, source=lo, target=hi)
        db_session.flush()

    real_load = text_quote.load_normalized_media_sources
    fetches: list[UUID] = []

    def _spy(db, *, media_id, cache=None):
        # Count only genuine fetch+normalize work: a cache hit short-circuits
        # inside the real loader, so the per-read memo means one fetch per owner.
        if cache is None or media_id not in cache:
            fetches.append(media_id)
        return real_load(db, media_id=media_id, cache=cache)

    monkeypatch.setattr(text_quote, "load_normalized_media_sources", _spy)

    page = _user_connections(db_session, user_id=user_id, media_id=media_a)

    assert len(page.anchored) == 3, "each local passage anchor surfaces one anchored row"
    assert fetches == [media_a], (
        "the owner's normalized sources are fetched+normalized exactly once for the "
        "whole page, not once per passage anchor"
    )


def test_unresolved_local_anchor_stays_unanchored_and_not_navigable(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Drift Doc")
    media_b = create_searchable_media(db_session, user_id, title="Peer Doc")
    anchor_a = _anchor(
        db_session, user_id=user_id, media_id=media_a, exact=_QUOTE_A.format(title="Drift Doc")
    )
    anchor_b = _anchor(
        db_session, user_id=user_id, media_id=media_b, exact=_QUOTE_A.format(title="Peer Doc")
    )
    _link(db_session, user_id=user_id, a=anchor_a, b=anchor_b)

    # Content drift: the quote no longer resolves against media A's current text.
    db_session.execute(
        text(
            "UPDATE fragments SET canonical_text = 'Rewritten body with no prior quote.' "
            "WHERE media_id = :media_id"
        ),
        {"media_id": media_a},
    )
    db_session.flush()

    page = _user_connections(db_session, user_id=user_id, media_id=media_a)

    assert page.anchored == [], "the drifted anchor must not produce a false jump"
    assert len(page.unanchored) == 1, "the Link stays visible in the unanchored collection"
    assert page.unanchored[0].anchor is None
