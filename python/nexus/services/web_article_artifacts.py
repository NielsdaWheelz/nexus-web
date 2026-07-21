"""Web article artifact cleanup ownership."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, FragmentBlock, Highlight, HighlightFragmentAnchor
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.document_embeds import delete_document_embed_artifacts


def delete_web_article_artifacts(
    db: Session,
    *,
    owner_user_id: UUID,
    media_id: UUID,
    include_content_index: bool,
) -> None:
    """Delete rewriteable web-article artifacts for a media row."""
    delete_document_embed_artifacts(db, owner_user_id=owner_user_id, media_id=media_id)
    if include_content_index:
        delete_content_index(db, owner=IndexOwner("media", media_id))

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
    # Deliberately NOT credits/author memos: every caller of this helper is a
    # LIVE-media refresh/re-ingest (web re-ingest, source requeue, browser
    # re-capture, X thread/post refresh). Refresh keeps the prior author list
    # until the post-commit observation replaces it (spec 2.4), NOT_OBSERVED
    # re-fetches preserve it (AC 10), and a manual pin plus its replay memos
    # survive refresh (AC 13, spec 2.8). Deletion cleanup lives with true
    # deletions only: contributors.cleanup_credits_for_deleted_target.
    # Apparatus likewise survives until replacement reconciles stable keys;
    # media_deletion owns the only full apparatus delete.
    db.flush()
