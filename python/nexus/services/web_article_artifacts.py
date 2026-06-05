"""Web article artifact cleanup ownership."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, FragmentBlock, Highlight, HighlightFragmentAnchor
from nexus.services.content_indexing import delete_media_content_index


def delete_web_article_artifacts(
    db: Session,
    *,
    media_id: UUID,
    include_content_index: bool,
) -> None:
    """Delete rewriteable web-article artifacts for a media row."""
    if include_content_index:
        delete_media_content_index(db, media_id=media_id)

    fragment_ids = (
        db.execute(select(Fragment.id).where(Fragment.media_id == media_id)).scalars().all()
    )

    if fragment_ids:
        db.execute(
            delete(Highlight).where(
                Highlight.id.in_(
                    select(HighlightFragmentAnchor.highlight_id).where(
                        HighlightFragmentAnchor.fragment_id.in_(fragment_ids)
                    )
                )
            )
        )
        db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(fragment_ids)))

    db.execute(delete(Fragment).where(Fragment.media_id == media_id))
    db.execute(
        text("DELETE FROM contributor_credits WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.flush()
