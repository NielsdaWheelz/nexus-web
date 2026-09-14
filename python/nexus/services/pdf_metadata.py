"""PDF metadata persistence ownership."""

from __future__ import annotations

from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    RawCreditEntry,
    build_observation,
)
from nexus.services.pdf_ingest import PdfExtractionResult


def persist_pdf_metadata(db: Session, media: Media, result: PdfExtractionResult) -> None:
    """Persist PDF document metadata (title/description/date) — never credits.

    Author credits are no longer written here: the source lifecycle emits a
    typed observation (:func:`build_pdf_author_observation`) that the ingest
    runner applies through the author facade in a fresh session (spec 2.4).
    """
    if result.pdf_title and media.title and ".pdf" in media.title.lower():
        media.title = result.pdf_title[:255]

    if result.pdf_subject and not media.description:
        media.description = result.pdf_subject[:2000]

    if result.pdf_creation_date and not media.published_date:
        media.published_date = result.pdf_creation_date


def build_pdf_author_observation(
    result: PdfExtractionResult,
) -> tuple[ContributorObservationBatch, dict[str, int]]:
    """Build the ``author`` observation from PDF author metadata.

    D-31 reverses the old comma-splitting behavior: ``Last, First`` is ONE name.
    Only semicolons separate people (PDF metadata carries no declared list
    delimiter). The old rule split on ``";"`` then, failing that, ``","`` —
    which shattered ``Last, First`` into two authors; that behavior is
    deliberately deleted.
    """
    names = [part.strip() for part in (result.pdf_author or "").split(";") if part.strip()]
    return build_observation({"author": [RawCreditEntry(credited_name=name) for name in names]})
