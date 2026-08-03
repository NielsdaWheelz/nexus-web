"""Priority proof: reader cursor replacement is atomic and revision-fenced."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import (
    Fragment,
    Media,
    MediaKind,
    ProcessingStatus,
    ReaderEngagementState,
    ReaderMediaState,
)
from nexus.errors import ApiErrorCode, ConflictError
from nexus.schemas.reader import (
    CursorWrite,
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.consumption import service as consumption
from nexus.services.library_entries import ensure_media_in_default_library


@dataclass(frozen=True, slots=True)
class _ReadableArticle:
    viewer_id: UUID
    media_id: UUID
    fragment_id: UUID


@contextmanager
def _committed_readable_article(engine: Engine) -> Iterator[_ReadableArticle]:
    """Publish one real, externally visible article for fresh service sessions."""
    viewer_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"reader-proof-{viewer_id}@example.invalid",
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Reader CAS proof",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="A durable reading position.",
                html_sanitized="<p>A durable reading position.</p>",
            )
        )
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()

    yield _ReadableArticle(viewer_id, media_id, fragment_id)


def _cursor(fragment_id: UUID, *, offset: int, progression: float) -> WebReaderResumeState:
    return WebReaderResumeState(
        kind="web",
        target=ReaderFragmentTarget(fragment_id=str(fragment_id)),
        locations=ReaderTextLocations(
            text_offset=offset,
            progression=progression,
            total_progression=progression,
            position=1,
        ),
        text=ReaderQuoteContext(
            quote="durable",
            quote_prefix="A ",
            quote_suffix=" reading position.",
        ),
    )


def test_reader_cursor_cas_rejects_stale_progress_without_partial_side_effects(
    engine: Engine,
) -> None:
    """A stale save cannot replace cursor or advance its coupled engagement fact."""
    with _committed_readable_article(engine) as article:
        accepted = _cursor(article.fragment_id, offset=4, progression=0.25)
        stale = _cursor(article.fragment_id, offset=12, progression=0.75)

        first = consumption.put_reader_cursor(
            article.viewer_id,
            article.media_id,
            CursorWrite(locator=accepted, base_revision=0),
        )
        assert first.revision == 1, f"first accepted cursor must establish revision 1: {first!r}"

        with pytest.raises(ConflictError) as raised:
            consumption.put_reader_cursor(
                article.viewer_id,
                article.media_id,
                CursorWrite(locator=stale, base_revision=0),
            )
        assert raised.value.code == ApiErrorCode.E_READER_STATE_CONFLICT

        with Session(engine) as oracle:
            cursor_row = oracle.execute(
                select(ReaderMediaState.revision, ReaderMediaState.locator).where(
                    ReaderMediaState.user_id == article.viewer_id,
                    ReaderMediaState.media_id == article.media_id,
                )
            ).one()
            engagement_row = oracle.execute(
                select(ReaderEngagementState.max_total_progression).where(
                    ReaderEngagementState.user_id == article.viewer_id,
                    ReaderEngagementState.media_id == article.media_id,
                )
            ).one()

        assert cursor_row[0] == 1, f"stale write advanced cursor revision: {cursor_row!r}"
        assert cursor_row[1] == accepted.model_dump(mode="json"), (
            f"stale write replaced the accepted locator: {cursor_row[1]!r}"
        )
        assert float(engagement_row[0]) == pytest.approx(0.25), (
            f"stale write partially advanced engagement: {engagement_row!r}"
        )
