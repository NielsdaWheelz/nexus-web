"""Shared committed publication fixtures for account, provenance and CAS proofs."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID, uuid4

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus, ReaderPublication
from nexus.ids import new_uuid7
from nexus.schemas.reader import (
    ReaderFragmentTarget,
    ReaderQuoteContext,
    ReaderTextLocations,
    WebReaderResumeState,
)
from nexus.schemas.reader_progress import ReaderProgressWrite
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library


@dataclass(frozen=True, slots=True)
class PublishedArticle:
    viewer_id: UUID
    email: str
    media_id: UUID
    fragment_id: UUID


@contextmanager
def committed_published_article(engine: Engine) -> Iterator[PublishedArticle]:
    viewer_id = uuid4()
    media_id = uuid4()
    fragment_id = uuid4()
    email = f"offline-reader-progress-{viewer_id}@example.invalid"
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            email,
        )
        db.add(
            Media(
                id=media_id,
                kind=MediaKind.web_article.value,
                title="Offline reader progress proof",
                processing_status=ProcessingStatus.ready_for_reading,
                created_by_user_id=viewer_id,
            )
        )
        db.add(
            Fragment(
                id=fragment_id,
                media_id=media_id,
                idx=0,
                canonical_text="Publication-fenced progress.",
                html_sanitized="<p>Publication-fenced progress.</p>",
            )
        )
        db.add(ReaderPublication(id=new_uuid7(), media_id=media_id, generation=7))
        db.flush()
        ensure_media_in_default_library(db, viewer_id, media_id)
        db.commit()

    yield PublishedArticle(viewer_id, email, media_id, fragment_id)


def reader_cursor(fragment_id: UUID, *, offset: int) -> WebReaderResumeState:
    progression = offset / 100
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
            quote="progress",
            quote_prefix="Publication-fenced ",
            quote_suffix=".",
        ),
    )


def reader_write(
    *,
    generation: int,
    base_revision: int,
    locator: WebReaderResumeState,
) -> ReaderProgressWrite:
    return ReaderProgressWrite.model_validate(
        {
            "expectedReaderGeneration": generation,
            "baseRevision": base_revision,
            "locator": locator.model_dump(mode="json"),
        }
    )
