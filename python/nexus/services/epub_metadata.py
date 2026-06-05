"""EPUB metadata persistence ownership."""

from __future__ import annotations

from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.epub_ingest import EpubExtractionResult


def persist_epub_metadata(db: Session, media: Media, result: EpubExtractionResult) -> None:
    """Persist EPUB OPF metadata to media and contributor credits."""
    if result.title:
        media.title = result.title

    replace_media_contributor_credits(
        db,
        media_id=media.id,
        source="epub_opf",
        credits=[
            {
                "name": name.strip()[:255],
                "role": "author",
                "ordinal": i,
                "source": "epub_opf",
            }
            for i, name in enumerate(result.creators or [])
            if name and name.strip()
        ],
    )

    if result.publisher and not media.publisher:
        media.publisher = result.publisher[:255]

    if result.language and not media.language:
        media.language = result.language[:32]

    if result.description and not media.description:
        media.description = result.description[:2000]

    if result.published_date and not media.published_date:
        media.published_date = result.published_date[:64]
