"""Priority proof: reader cursor replacement is atomic and revision-fenced."""

from __future__ import annotations

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from nexus.db.models import ReaderEngagementState, ReaderMediaState
from nexus.errors import ApiErrorCode, ConflictError
from nexus.services import reader_publication
from nexus.services.consumption import reader_progress
from tests.testkit.reader_progress import (
    committed_published_article,
    reader_cursor,
    reader_write,
)


def test_reader_cursor_cas_rejects_stale_progress_without_partial_side_effects(
    engine: Engine,
) -> None:
    """A stale save cannot replace cursor or advance its coupled engagement fact."""
    with committed_published_article(engine) as article:
        accepted = reader_cursor(article.fragment_id, offset=25)
        stale = reader_cursor(article.fragment_id, offset=75)
        with Session(engine) as db:
            generation = reader_publication.read_publication_generation(
                db, media_id=article.media_id
            )
        assert generation is not None

        first = reader_progress.put(
            viewer_id=article.viewer_id,
            expected_account_id=article.viewer_id,
            media_id=article.media_id,
            write=reader_write(generation=generation, base_revision=0, locator=accepted),
        )
        assert first.cursor.revision == 1, (
            f"first accepted cursor must establish revision 1: {first!r}"
        )

        with pytest.raises(ConflictError) as raised:
            reader_progress.put(
                viewer_id=article.viewer_id,
                expected_account_id=article.viewer_id,
                media_id=article.media_id,
                write=reader_write(generation=generation, base_revision=0, locator=stale),
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
