"""EPUB metadata persistence ownership."""

from __future__ import annotations

from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    RawCreditEntry,
    build_observation,
)
from nexus.services.epub_ingest import EpubExtractionResult


def persist_epub_metadata(db: Session, media: Media, result: EpubExtractionResult) -> None:
    """Persist EPUB OPF metadata (title/publisher/language/…) — never credits.

    Author credits are no longer written here: the source lifecycle emits a
    typed observation (:func:`build_epub_author_observation`) that the ingest
    runner applies through the author facade in a fresh session (spec 2.4).
    """
    if result.title:
        media.title = result.title

    if result.publisher and not media.publisher:
        media.publisher = result.publisher[:255]

    if result.language and not media.language:
        media.language = result.language[:32]

    if result.description and not media.description:
        media.description = result.description[:2000]

    if result.published_date and not media.published_date:
        media.published_date = result.published_date[:64]


def build_epub_author_observation(
    result: EpubExtractionResult,
) -> tuple[ContributorObservationBatch, dict[str, int]]:
    """Build the ``author`` observation from OPF ``dc:creator`` values.

    Each OPF creator is one credited name; only semicolons split a single
    creator string into multiple people (D-31: ``Last, First`` stays one name).
    """
    names: list[str] = []
    for creator in result.creators or []:
        names.extend(part.strip() for part in creator.split(";") if part.strip())
    return build_observation({"author": [RawCreditEntry(credited_name=name) for name in names]})
