"""Integration test for span-grain synapse edges in the reader projection (S3, AC-1).

Confirms the read model is already span-ready (P-4): a ``highlight``/``media`` →
``evidence_span`` synapse edge surfaces in ``list_reader_connections`` anchored at
the span's reader locator, with no new endpoint.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import EpubNavLocation, Fragment, Media, MediaKind, ResourceEdge
from nexus.schemas.highlights import CreatePdfHighlightRequest, PdfQuadIn
from nexus.schemas.reader_document_map import ReaderEvidenceAnchorOut
from nexus.services import reader_connections
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.pdf_highlights import create_pdf_highlight
from nexus.services.reader_apparatus import replace_media_apparatus, source_fingerprint
from nexus.services.reader_document_map import get_reader_document_map
from nexus.services.resource_graph import citations
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
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
