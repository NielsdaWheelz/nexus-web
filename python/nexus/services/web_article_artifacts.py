"""Prepared single-fragment article publication and artifact cleanup."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, FragmentBlock
from nexus.schemas.presence import Presence, Present
from nexus.services.content_indexing import IndexOwner, delete_content_index
from nexus.services.document_embeds import (
    prepare_document_embed_artifacts_for_fragment_replacement,
    replace_document_embed_artifact,
)
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.html_apparatus import (
    accepted_apparatus_spans,
    attach_fragment_locators,
    derive_fragment_note_groups,
)
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.services.web_article_structure import (
    WebArticlePreparedFragment,
    document_embed_artifact_occurrences,
)


@dataclass(frozen=True, slots=True)
class ArticleEmbedReplacement:
    owner_user_id: UUID
    child_actor_user_id: UUID
    source_attempt_id: UUID
    request_id: str | None
    locked_existing_target_media_ids: frozenset[UUID]


def replace_prepared_article_content(
    db: Session,
    *,
    media_id: UUID,
    prepared: WebArticlePreparedFragment,
    embeds: Presence[ArticleEmbedReplacement],
) -> UUID:
    """Replace one prepared article's content and optional embed set; flush only."""
    delete_web_article_artifacts(db, media_id=media_id, include_content_index=False)
    fragment = Fragment(
        media_id=media_id,
        idx=0,
        html_sanitized=prepared.html_sanitized,
        canonical_text=prepared.canonical_text,
        created_at=datetime.now(UTC),
    )
    db.add(fragment)
    db.flush()
    insert_fragment_blocks(db, fragment.id, prepared.fragment_blocks)
    if isinstance(embeds, Present):
        replacement = embeds.value
        queued_children = replace_document_embed_artifact(
            db,
            owner_user_id=replacement.owner_user_id,
            media_id=media_id,
            source_attempt_id=replacement.source_attempt_id,
            occurrences=document_embed_artifact_occurrences(
                fragment_id=fragment.id, document_embeds=prepared.document_embeds
            ),
            extraction_failed=prepared.document_embed_extraction_failed,
            locked_existing_target_media_ids=replacement.locked_existing_target_media_ids,
        )
        from nexus.services.media_source_ingest import (
            enqueue_accepted_source_attempt_in_transaction,
        )

        for child_media_id, child_attempt_id in queued_children:
            enqueue_accepted_source_attempt_in_transaction(
                db,
                media_id=child_media_id,
                attempt_id=child_attempt_id,
                actor_user_id=replacement.child_actor_user_id,
                request_id=replacement.request_id,
            )
    return fragment.id


def install_prepared_article_apparatus(
    db: Session,
    *,
    media_id: UUID,
    fragment_id: UUID,
    prepared: WebArticlePreparedFragment,
    source_html: str,
) -> None:
    """Install apparatus for that fresh fragment in the same publication transaction."""
    accepted_spans = accepted_apparatus_spans(prepared.structure, prepared.canonical_text)
    replace_media_apparatus(
        db,
        media_id=media_id,
        items=attach_fragment_locators(
            media_id=media_id,
            fragment_id=fragment_id,
            media_kind="web_article",
            canonical_text=prepared.canonical_text,
            items=prepared.apparatus_items,
            accepted_spans=accepted_spans,
            html_sanitized=prepared.html_sanitized,
        ),
        edges=prepared.apparatus_edges,
        note_groups=derive_fragment_note_groups(
            prepared.html_sanitized,
            prepared.canonical_text,
            fragment_id,
            structure=prepared.structure,
            accepted_spans=accepted_spans,
            source_html=source_html,
        ),
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
