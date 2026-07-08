"""Integration test for span-grain synapse edges in the reader projection (S3, AC-1).

Confirms the read model is already span-ready (P-4): a ``highlight``/``media`` →
``evidence_span`` synapse edge surfaces in ``list_reader_connections`` anchored at
the span's reader locator, with no new endpoint.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ResourceEdge
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.reader_connections import list_reader_connections
from tests.factories import create_searchable_media
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
