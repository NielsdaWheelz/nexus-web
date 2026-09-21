"""Web article artifact cleanup, run before a refresh publishes new fragments."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, FragmentBlock
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.document_embeds import (
    prepare_document_embed_artifacts_for_fragment_replacement,
)


def delete_web_article_artifacts(
    db: Session,
    *,
    media_id: UUID,
    include_content_index: bool,
) -> None:
    """Drop fragments and their blocks, keeping every authored artifact.

    Highlights, credits and apparatus survive: a refresh republishes fragments
    and authored selectors re-resolve by quote against the new content. The
    document-embed owner keeps its rows and viewer-scoped edges until it
    replaces them, so only their fragment locators are released here.
    """
    prepare_document_embed_artifacts_for_fragment_replacement(db, media_id=media_id)
    if include_content_index:
        delete_content_index(db, owner=IndexOwner("media", media_id))
    fragment_ids = (
        db.execute(select(Fragment.id).where(Fragment.media_id == media_id)).scalars().all()
    )
    if fragment_ids:
        db.execute(delete(FragmentBlock).where(FragmentBlock.fragment_id.in_(fragment_ids)))
    db.execute(delete(Fragment).where(Fragment.media_id == media_id))
    db.flush()
