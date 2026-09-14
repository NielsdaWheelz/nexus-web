"""Priority proof: cursor provenance survives publication replacement."""

from __future__ import annotations

from uuid import UUID

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ReaderPublication
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.consumption import reader_progress
from tests.testkit.reader_progress import (
    committed_published_article as _committed_published_article,
)
from tests.testkit.reader_progress import (
    reader_cursor as _cursor,
)
from tests.testkit.reader_progress import (
    reader_write as _write,
)


def _advance_published_generation(engine: Engine, media_id: UUID) -> None:
    """Advance the article's publication one generation, as a replacement does.

    This fixture seeds its publication row directly, with none of the members a
    prepared replacement installs, so the publication owner has nothing to publish
    here. What a cursor reads -- and what this proof is about -- is the generation
    the row carries and the instant it moved.
    """
    with Session(engine) as db:
        publication = db.scalar(
            select(ReaderPublication).where(ReaderPublication.media_id == media_id)
        )
        assert publication is not None, "the fixture published no reader generation"
        publication.generation += 1
        publication.changed_at = db.scalar(text("SELECT now()"))
        db.commit()


def _prove_source_preserved(engine: Engine) -> None:
    """A current publication read cannot relabel a cursor's original coordinates."""
    with _committed_published_article(engine) as article:
        saved = reader_progress.put(
            viewer_id=article.viewer_id,
            expected_account_id=article.viewer_id,
            media_id=article.media_id,
            write=_write(
                generation=7, base_revision=0, locator=_cursor(article.fragment_id, offset=12)
            ),
        )
        _advance_published_generation(engine, article.media_id)
        with Session(engine) as db:
            current = reader_progress.get(
                db,
                viewer_id=article.viewer_id,
                expected_account_id=article.viewer_id,
                media_id=article.media_id,
            )
        assert current.reader_generation == 8
        assert current.cursor.model_dump(mode="json").get("source") == {
            "kind": "Publication",
            "reader_generation": 7,
        }, "a positioned cursor must retain its source publication after replacement"
        assert current.cursor == saved.cursor


def _prove_source_fences_acknowledgment(engine: Engine) -> None:
    """Equality acknowledges one source+locator, never another publication's write."""
    with _committed_published_article(engine) as article:
        locator = _cursor(article.fragment_id, offset=12)
        reader_progress.put(
            viewer_id=article.viewer_id,
            expected_account_id=article.viewer_id,
            media_id=article.media_id,
            write=_write(generation=7, base_revision=0, locator=locator),
        )
        _advance_published_generation(engine, article.media_id)
        with pytest.raises(ApiError) as conflict:
            reader_progress.put(
                viewer_id=article.viewer_id,
                expected_account_id=article.viewer_id,
                media_id=article.media_id,
                write=_write(generation=8, base_revision=0, locator=locator),
            )
        assert conflict.value.code == ApiErrorCode.E_READER_STATE_CONFLICT


def test_cursor_source_survives_replacement_and_fences_acknowledgment(engine: Engine) -> None:
    _prove_source_preserved(engine)
    _prove_source_fences_acknowledgment(engine)
