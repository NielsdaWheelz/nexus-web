"""PDF metadata persistence ownership."""

from __future__ import annotations

from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.pdf_ingest import PdfExtractionResult


def persist_pdf_metadata(db: Session, media: Media, result: PdfExtractionResult) -> None:
    """Persist PDF document metadata extracted from doc.metadata."""
    if result.pdf_title and media.title and ".pdf" in media.title.lower():
        media.title = result.pdf_title[:255]

    names: list[str] = []
    if result.pdf_author:
        for sep in [";", ","]:
            if sep in result.pdf_author:
                names = [n.strip() for n in result.pdf_author.split(sep) if n.strip()]
                break
        else:
            names = [result.pdf_author.strip()]
    replace_media_contributor_credits(
        db,
        media_id=media.id,
        source="pdf_metadata",
        credits=[
            {
                "name": name[:255],
                "role": "author",
                "ordinal": i,
                "source": "pdf_metadata",
            }
            for i, name in enumerate(names)
            if name
        ],
    )

    if result.pdf_subject and not media.description:
        media.description = result.pdf_subject[:2000]

    if result.pdf_creation_date and not media.published_date:
        media.published_date = result.pdf_creation_date
