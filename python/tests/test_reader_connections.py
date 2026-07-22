"""Integration test for span-grain synapse edges in the reader projection (S3, AC-1).

Confirms the read model is already span-ready (P-4): a ``highlight``/``media`` →
``evidence_span`` synapse edge surfaces in ``list_reader_connections`` anchored at
the span's reader locator, with no new endpoint.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import EpubNavLocation, Fragment, Media, MediaKind, NoteBlock, ResourceEdge
from nexus.schemas.highlights import CreatePdfHighlightRequest, PdfQuadIn
from nexus.schemas.reader_document_map import ReaderEvidenceAnchorOut
from nexus.services import passage_anchors, reader_connections
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.pdf_highlights import create_pdf_highlight
from nexus.services.reader_apparatus import replace_media_apparatus, source_fingerprint
from nexus.services.reader_connections import list_reader_connections
from nexus.services.reader_document_map import get_reader_document_map
from nexus.services.resource_graph import citations, edges
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
from nexus.services.resource_items.capabilities import expand_owned_child_refs
from tests.factories import (
    add_context_edge,
    create_pdf_media_with_text,
    create_searchable_media,
    create_test_conversation_with_message,
)
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
    replace_media_apparatus(
        db_session,
        media_id=target_media,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint("reader-connections", target_media),
        items=[],
        edges=[],
        status="empty",
    )
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

    page = reader_connections.list_reader_connections(
        db_session,
        viewer_id=user_id,
        media_id=target_media,
        origins=("synapse",),
        source_schemes=None,
        limit=50,
        cursor=None,
    )

    assert len(page.items) == 1, "the span-grain synapse edge must surface anchored"
    row = page.items[0]
    assert row.anchor is not None
    assert row.anchor.order_key, "the span anchor carries a reader order key (passage grain)"
    assert row.excerpt == "It restates the claim."

    document_map = get_reader_document_map(db_session, viewer_id=user_id, media_id=target_media)
    group = next(
        group
        for group in document_map.evidence.passage_groups
        if group.locus_ref == f"evidence_span:{span_id}"
    )
    assert group.resolution.kind == "Resolved"
    synapse = next(item for item in group.items if item.kind == "Synapse")
    assert synapse.edge_id == row.connection.edge_id
    assert synapse.rationale == "It restates the claim."


def test_epub_fragment_connection_uses_cross_section_activation_locator(
    db_session: Session,
) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="EPUB Anchor Work")
    media = db_session.get(Media, media_id)
    assert media is not None
    media.kind = MediaKind.epub.value
    fragment = db_session.scalar(
        select(Fragment).where(Fragment.media_id == media_id).order_by(Fragment.idx)
    )
    assert fragment is not None
    section_id = "text/chapter-one.xhtml"
    db_session.add(
        EpubNavLocation(
            media_id=media_id,
            location_id=section_id,
            ordinal=0,
            source_node_id=None,
            label="Chapter one",
            fragment_idx=fragment.idx,
            href_path=section_id,
            href_fragment=None,
            source="spine",
        )
    )
    conversation_id, _message_id = create_test_conversation_with_message(db_session, user_id)
    edge_id = add_context_edge(db_session, conversation_id, f"fragment:{fragment.id}")
    db_session.flush()

    page = reader_connections.list_reader_connections(
        db_session,
        viewer_id=user_id,
        media_id=media_id,
        origins=None,
        source_schemes=None,
        limit=50,
        cursor=None,
    )

    row = next(item for item in page.items if item.connection.edge_id == edge_id)
    assert row.anchor is not None
    assert row.anchor.locator == {
        "type": "epub_fragment_offsets",
        "media_id": str(media_id),
        "fragment_id": str(fragment.id),
        "start_offset": 0,
        "end_offset": 1,
        "media_kind": "epub",
        "section_id": section_id,
    }


def test_pdf_highlight_connection_reuses_the_strict_quote_enriched_locator(
    db_session: Session,
) -> None:
    user_id = create_test_user_id()
    library_id = ensure_user_and_default_library(db_session, user_id)
    media_id = create_pdf_media_with_text(
        db_session,
        user_id,
        library_id,
        plain_text="A strict PDF quote lives on this page.",
        page_count=1,
    )
    highlight = create_pdf_highlight(
        db_session,
        user_id,
        media_id,
        CreatePdfHighlightRequest(
            page_number=1,
            quads=[
                PdfQuadIn(
                    x1=72,
                    y1=700,
                    x2=200,
                    y2=700,
                    x3=200,
                    y3=712,
                    x4=72,
                    y4=712,
                )
            ],
            exact="strict PDF quote",
            color="yellow",
        ),
    )
    conversation_id, _message_id = create_test_conversation_with_message(db_session, user_id)
    edge_id = add_context_edge(db_session, conversation_id, f"highlight:{highlight.id}")
    db_session.flush()

    page = reader_connections.list_reader_connections(
        db_session,
        viewer_id=user_id,
        media_id=media_id,
        origins=None,
        source_schemes=None,
        limit=50,
        cursor=None,
    )

    row = next(item for item in page.items if item.connection.edge_id == edge_id)
    assert row.anchor is not None
    assert row.anchor.locator["exact"] == "strict PDF quote"
    assert row.anchor.locator["text_quote_selector"] == {
        "exact": "strict PDF quote",
        "prefix": "A ",
        "suffix": " lives on this page.",
    }
    ReaderEvidenceAnchorOut(locator=row.anchor.locator)


def test_repeated_citation_target_resolves_once_through_reader_projection(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Repeated target")
    replace_media_apparatus(
        db_session,
        media_id=media_id,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint("reader-connections", media_id),
        items=[],
        edges=[],
        status="empty",
    )
    span_id = _first_span(db_session, media_id)
    assert span_id is not None
    for title in ("First chat", "Second chat"):
        _conversation_id, message_id = create_test_conversation_with_message(db_session, user_id)
        create_edge(
            db_session,
            viewer_id=user_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="message", id=message_id),
                target=ResourceRef(scheme="evidence_span", id=span_id),
                kind="context",
                origin="citation",
                ordinal=1,
                snapshot=CitationSnapshot(title=title, excerpt="Same target"),
            ),
        )
    db_session.flush()

    graph_resolution_calls = 0
    reader_resolution_calls = 0
    graph_resolver = citations.reader_target_for_citation_target
    reader_resolver = reader_connections.reader_target_for_citation_target

    def count_graph_resolution(*args, **kwargs):
        nonlocal graph_resolution_calls
        graph_resolution_calls += 1
        return graph_resolver(*args, **kwargs)

    def count_reader_resolution(*args, **kwargs):
        nonlocal reader_resolution_calls
        reader_resolution_calls += 1
        return reader_resolver(*args, **kwargs)

    monkeypatch.setattr(citations, "reader_target_for_citation_target", count_graph_resolution)
    monkeypatch.setattr(
        reader_connections,
        "reader_target_for_citation_target",
        count_reader_resolution,
    )

    page = reader_connections.list_reader_connections(
        db_session,
        viewer_id=user_id,
        media_id=media_id,
        origins=("citation",),
        source_schemes=None,
        limit=50,
        cursor=None,
    )

    assert len(page.items) == 2
    assert all(item.anchor is not None for item in page.items)
    assert graph_resolution_calls == 1
    assert reader_resolution_calls == 0


# --- Universal-link-authoring passage-anchor reader coverage --------------------
# Re-applied onto main's evidence-scope projection: main rebuilt the reader row
# model (``ReaderConnectionPage.items`` of ``ReaderConnectionRow``; the anchor is a
# resolved locator, evidence-item identity now lives in ``reader_evidence``), so
# these assert against ``.items`` filtered by locality rather than the old
# ``anchored``/``unanchored`` split or a per-row id. A same-media Link between two
# local passages emits one row per local endpoint (each activating the opposite
# one); whole-media/cross-document anchoring, live fail-closed resolution, the
# per-read source cache, undirected direction, and the folded link note all survive.

_QUOTE_A = "canonical text for {title}"
_QUOTE_B = "searchable content about various topics"


def _anchored(page) -> list:
    return [row for row in page.items if row.anchor is not None]


def _unanchored(page) -> list:
    return [row for row in page.items if row.anchor is None]


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


def test_cross_document_link_anchors_in_each_reader(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Alpha Doc")
    media_b = create_searchable_media(db_session, user_id, title="Beta Doc")
    anchor_a = _anchor(
        db_session, user_id=user_id, media_id=media_a, exact=_QUOTE_A.format(title="Alpha Doc")
    )
    anchor_b = _anchor(
        db_session, user_id=user_id, media_id=media_b, exact=_QUOTE_A.format(title="Beta Doc")
    )
    _link(db_session, user_id=user_id, a=anchor_a, b=anchor_b)

    anchored_a = _anchored(_user_connections(db_session, user_id=user_id, media_id=media_a))
    assert len(anchored_a) == 1, "the cross-document Link anchors exactly once in reader A"
    row_a = anchored_a[0]
    assert row_a.connection.direction == "undirected"
    assert row_a.connection.other.ref == f"passage_anchor:{anchor_b}"

    anchored_b = _anchored(_user_connections(db_session, user_id=user_id, media_id=media_b))
    assert len(anchored_b) == 1, "and exactly once in reader B, anchored at its own endpoint"
    assert anchored_b[0].connection.other.ref == f"passage_anchor:{anchor_a}"


def test_same_media_link_emits_one_row_per_local_endpoint(db_session: Session) -> None:
    """A neutral Link between two passages in the SAME document is undirected and
    anchors at both endpoints, so the reader emits one row per local passage. Each
    row activates the OPPOSITE endpoint (via ``connection.other``, swapped between
    the two rows) so both passages surface the Link in this reader (AC17)."""
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Solo Doc")
    anchor_a = _anchor(
        db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_A.format(title="Solo Doc")
    )
    anchor_b = _anchor(db_session, user_id=user_id, media_id=media_id, exact=_QUOTE_B)
    _link(db_session, user_id=user_id, a=anchor_a, b=anchor_b)

    anchored = _anchored(_user_connections(db_session, user_id=user_id, media_id=media_id))
    assert len(anchored) == 2, "each local passage of a same-media Link emits its own row"
    assert all(row.connection.direction == "undirected" for row in anchored)
    assert {row.connection.other.ref for row in anchored} == {
        f"passage_anchor:{anchor_a}",
        f"passage_anchor:{anchor_b}",
    }, "each row activates the opposite endpoint"
    assert {row.anchor.passage_anchor_id for row in anchored} == {anchor_a, anchor_b}


def test_whole_media_link_surfaces_peer_not_self(db_session: Session) -> None:
    """A whole-media↔whole-media Link anchors nowhere locally, so it surfaces as one
    unanchored row per reader that names the PEER (via ``connection.other``, chosen
    by locality) rather than the open document (AC17)."""
    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Whole A")
    media_b = create_searchable_media(db_session, user_id, title="Whole B")
    _media_link(db_session, user_id=user_id, media_a=media_a, media_b=media_b)

    page_a = _user_connections(db_session, user_id=user_id, media_id=media_a)
    assert _anchored(page_a) == []
    unanchored_a = _unanchored(page_a)
    assert len(unanchored_a) == 1
    assert unanchored_a[0].connection.other.ref == f"media:{media_b}", "reader A surfaces peer B"
    assert unanchored_a[0].connection.direction == "undirected"

    page_b = _user_connections(db_session, user_id=user_id, media_id=media_b)
    unanchored_b = _unanchored(page_b)
    assert len(unanchored_b) == 1
    assert unanchored_b[0].connection.other.ref == f"media:{media_a}", "reader B surfaces peer A"


def test_reader_link_note_folds_onto_connection(db_session: Session) -> None:
    """The Link's ordinary note folds onto the reader connection row (Invariant 12):
    the reader lane serializes through the shared ``connection_out``."""
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

    row = _unanchored(_user_connections(db_session, user_id=user_id, media_id=media_a))[0]
    assert row.connection.link_note is not None, "the Link's note must fold onto the reader row"
    assert row.connection.link_note.note_block_id == note.id
    assert row.connection.link_note.preview == "Why these relate"


def test_passage_anchor_page_loads_each_owner_sources_once(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reader page carrying many same-owner passage-anchor connections reloads the
    owner's normalized sources ONCE for the whole page, not once per anchor. The
    per-read ``sources_cache`` memoizes the fetch+normalize; resolution stays LIVE."""
    from nexus.services import text_quote

    user_id = _seed_user(db_session)
    media_a = create_searchable_media(db_session, user_id, title="Sources A")
    media_b = create_searchable_media(db_session, user_id, title="Sources B")

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
        if cache is None or media_id not in cache:
            fetches.append(media_id)
        return real_load(db, media_id=media_id, cache=cache)

    monkeypatch.setattr(text_quote, "load_normalized_media_sources", _spy)

    page = _user_connections(db_session, user_id=user_id, media_id=media_a)

    assert len(_anchored(page)) == 3, "each local passage anchor surfaces one anchored row"
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

    assert _anchored(page) == [], "the drifted anchor must not produce a false jump"
    assert len(_unanchored(page)) == 1, "the Link stays visible in the unanchored collection"
