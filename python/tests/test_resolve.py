"""Integration tests for the covering-span resolver (spec §4.7, AC-7).

``covering_evidence_span_for_highlight`` bridges a highlight's anchor to the
evidence_span covering it, best-effort, over web and pdf; a miss returns None so
the caller falls back to media grain (D8).
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.schemas.highlights import CreateHighlightRequest
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.highlights import create_highlight_for_fragment
from nexus.services.resource_graph.resolve import covering_evidence_span_for_highlight
from tests.factories import create_searchable_media
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def _seed_user(db: Session) -> UUID:
    user_id = create_test_user_id()
    ensure_user_and_default_library(db, user_id)
    return user_id


def _span_owner(db: Session, span_id: UUID) -> UUID | None:
    return db.scalar(
        text("SELECT owner_id FROM evidence_spans WHERE id = :id AND owner_kind = 'media'"),
        {"id": span_id},
    )


def test_web_highlight_resolves_to_covering_span(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Covering Doc")
    fragment_id = db_session.execute(
        select(Fragment.id).where(Fragment.media_id == media_id)
    ).scalar_one()
    highlight = create_highlight_for_fragment(
        db_session,
        user_id,
        fragment_id,
        CreateHighlightRequest(start_offset=0, end_offset=4, color="yellow"),
    )

    ref = covering_evidence_span_for_highlight(db_session, viewer_id=user_id, highlight_id=highlight.id)

    assert ref is not None
    assert ref.scheme == "evidence_span"
    assert _span_owner(db_session, ref.id) == media_id


def test_no_covering_chunk_returns_none(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Uncovered Doc")
    fragment_id = db_session.execute(
        select(Fragment.id).where(Fragment.media_id == media_id)
    ).scalar_one()
    highlight = create_highlight_for_fragment(
        db_session,
        user_id,
        fragment_id,
        CreateHighlightRequest(start_offset=0, end_offset=4, color="yellow"),
    )
    # Strip the chunks' span pointers: no chunk resolves a covering span for the
    # anchor → media fallback (None). (Nulling the pointer, not deleting the
    # chunk, avoids the content_chunk_parts FK.)
    db_session.execute(
        text(
            "UPDATE content_chunks SET primary_evidence_span_id = NULL"
            " WHERE owner_kind = 'media' AND owner_id = :id"
        ),
        {"id": media_id},
    )

    ref = covering_evidence_span_for_highlight(db_session, viewer_id=user_id, highlight_id=highlight.id)

    assert ref is None


def test_missing_highlight_returns_none(db_session: Session) -> None:
    user_id = _seed_user(db_session)
    assert (
        covering_evidence_span_for_highlight(db_session, viewer_id=user_id, highlight_id=uuid4())
        is None
    )
