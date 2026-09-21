"""Web article source materialization: node ingest, dedupe, fenced publication."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Environment, get_settings
from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.presence import Present
from nexus.schemas.publication_dates import normalize_source_publication_date
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    build_observation,
)
from nexus.services.document_embeds import (
    DocumentEmbedLockSetChanged,
    replace_document_embed_artifact,
)
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.html_apparatus import attach_fragment_locators
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.node_ingest import (
    IngestError,
    IngestResult,
    local_node_ingest_command,
    run_node_ingest,
)
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.services.reader_publication import replace_reader_publication
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_structure import (
    WebArticlePreparedFragment,
    document_embed_artifact_occurrences,
    prepare_web_article_fragment,
)

logger = get_logger(__name__)


def run_web_article_node_ingest(
    url: str,
    *,
    environment: Environment,
) -> IngestResult | IngestError:
    """Run the environment-owned Node composition for one accepted URL."""
    return run_node_ingest(
        url,
        command=(
            local_node_ingest_command()
            if environment in {Environment.LOCAL, Environment.TEST}
            else None
        ),
    )


def materialize_web_article_source(
    session_factory: sessionmaker[Session],
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
    source_attempt_id: UUID | None = None,
    *,
    extract_embeds: bool,
    publication_fence: SourcePublicationFence,
) -> dict[str, object]:
    """Materialize a generic web URL under the durable source-ingest owner."""
    if source_attempt_id is None:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Web source publication requires its attempt.")
    snapshot = session_factory()
    try:
        media = snapshot.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        if media.processing_status != ProcessingStatus.extracting:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Web source is not extracting.")
        url = media.requested_url
        if not url:
            raise ApiError(ApiErrorCode.E_INGEST_FAILED, "No requested_url on media")
        snapshot.rollback()
    finally:
        snapshot.close()

    ingest_result = run_web_article_node_ingest(url, environment=get_settings().nexus_env)
    if isinstance(ingest_result, IngestError):
        logger.warning(
            "node_ingest_failed",
            media_id=str(media_id),
            error_code=ingest_result.error_code.value,
            detail=ingest_result.message,
        )
        raise ApiError(ingest_result.error_code, ingest_result.message)
    canonical_url = normalize_url_for_display(ingest_result.final_url)

    winner_id = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_web_canonical_identity",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=lambda db, _attempt: _claim_canonical_url(
            db, media_id=media_id, canonical_url=canonical_url
        ),
    )
    if winner_id is not None:
        return {
            "status": "deduped",
            "canonical_url": canonical_url,
            "superseded_by_media_id": str(winner_id),
        }

    try:
        prepared = prepare_web_article_fragment(
            html=ingest_result.content_html,
            embed_source_html=ingest_result.source_html,
            base_url=ingest_result.base_url,
            fragment_idx=0,
            extract_embeds=extract_embeds,
        )
        source_apparatus = (
            prepared
            if ingest_result.source_html == ingest_result.content_html
            else prepare_web_article_fragment(
                html=ingest_result.source_html,
                base_url=ingest_result.base_url,
                fragment_idx=0,
                extract_embeds=extract_embeds,
            )
        )
    except Exception as exc:
        raise ApiError(ApiErrorCode.E_SANITIZATION_FAILED, f"Article prep failed: {exc}") from exc

    embed_urls = [
        item.detected.canonical_source_url
        for item in prepared.document_embeds
        if extract_embeds
        and item.detected.resolution_status == "pending"
        and item.detected.canonical_source_url
    ]
    planned_existing_media_ids: set[UUID] = set()
    fragment_id: UUID | None = None
    for _lock_set_attempt in range(3):
        if extract_embeds and embed_urls:
            discovery = session_factory()
            try:
                from nexus.services.media_source_ingest import reusable_embedded_source_media_ids

                planned_existing_media_ids.update(
                    reusable_embedded_source_media_ids(
                        discovery, viewer_id=actor_user_id, urls=list(embed_urls)
                    )
                )
                discovery.rollback()
            finally:
                discovery.close()

        def publish(db: Session, _attempt: object) -> UUID:
            return replace_reader_publication(
                db,
                media_id=media_id,
                expected_kind="web_article",
                replace_projection=lambda media: _replace_projection(
                    db,
                    media=media,
                    media_id=media_id,
                    actor_user_id=actor_user_id,
                    source_attempt_id=source_attempt_id,
                    request_id=request_id,
                    extract_embeds=extract_embeds,
                    ingest_result=ingest_result,
                    prepared=prepared,
                    source_apparatus=source_apparatus,
                    locked_embed_media_ids=frozenset(planned_existing_media_ids),
                ),
            )

        try:
            fragment_id = run_source_publication_phase(
                session_factory=session_factory,
                label="publish_web_article_artifacts",
                fence=publication_fence,
                media_ids=tuple({media_id, *planned_existing_media_ids}),
                mutate=publish,
            )
            break
        except DocumentEmbedLockSetChanged as exc:
            planned_existing_media_ids.add(exc.media_id)
    if fragment_id is None:
        # A continuously changing child identity cannot be published under a
        # finite exact lock set.
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "Web embed media lock set did not stabilize")

    result: dict[str, object] = {
        "status": "success",
        "canonical_url": canonical_url,
        "title": ingest_result.title,
        "fragment_id": str(fragment_id),
        "metadata_enrichment": True,
    }
    attach_author_observation(
        result,
        observation=_web_article_observation(ingest_result),
        source="web_article_byline",
    )
    return result


def _claim_canonical_url(db: Session, *, media_id: UUID, canonical_url: str) -> UUID | None:
    """Claim the canonical URL, or name the existing article that already holds it."""
    winner_id = db.scalar(
        text("""
            SELECT id FROM media
            WHERE kind = :kind AND canonical_url = :url AND id != :media_id
            ORDER BY id LIMIT 1
        """),
        {"kind": MediaKind.web_article.value, "url": canonical_url, "media_id": media_id},
    )
    if winner_id is not None:
        return UUID(str(winner_id))
    updated = db.execute(
        text("""
            UPDATE media SET canonical_url = :url, updated_at = now()
            WHERE id = :media_id RETURNING id
        """),
        {"url": canonical_url, "media_id": media_id},
    ).scalar()
    if updated is None:
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return None


def _replace_projection(
    db: Session,
    *,
    media: Media,
    media_id: UUID,
    actor_user_id: UUID,
    source_attempt_id: UUID,
    request_id: str | None,
    extract_embeds: bool,
    ingest_result: IngestResult,
    prepared: WebArticlePreparedFragment,
    source_apparatus: WebArticlePreparedFragment,
    locked_embed_media_ids: frozenset[UUID],
) -> UUID:
    """Replace the fragment, embeds, metadata and apparatus inside the fence."""
    owner_user_id = media.created_by_user_id or actor_user_id
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
    if extract_embeds:
        queued_children = replace_document_embed_artifact(
            db,
            owner_user_id=owner_user_id,
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            occurrences=document_embed_artifact_occurrences(
                fragment_id=fragment.id, document_embeds=prepared.document_embeds
            ),
            extraction_failed=prepared.document_embed_extraction_failed,
            request_id=request_id,
            locked_existing_target_media_ids=locked_embed_media_ids,
        )
        from nexus.services.media_source_ingest import (
            enqueue_accepted_source_attempt_in_transaction,
        )

        for child_media_id, child_attempt_id in queued_children:
            enqueue_accepted_source_attempt_in_transaction(
                db,
                media_id=child_media_id,
                attempt_id=child_attempt_id,
                actor_user_id=actor_user_id,
                request_id=request_id,
            )
    if ingest_result.title:
        media.title = ingest_result.title[:255]
    _persist_web_metadata(db, media, ingest_result)
    replace_media_apparatus(
        db,
        media_id=media_id,
        items=attach_fragment_locators(
            media_id=media_id,
            fragment_id=fragment.id,
            media_kind="web_article",
            canonical_text=prepared.canonical_text,
            items=source_apparatus.apparatus_items,
            html_sanitized=prepared.html_sanitized,
        ),
        edges=source_apparatus.apparatus_edges,
    )
    return fragment.id


def _persist_web_metadata(db: Session, media: Media, ingest_result: IngestResult) -> None:
    changed = bool(ingest_result.title)
    if ingest_result.excerpt and not media.description:
        media.description = ingest_result.excerpt[:2000]
        changed = True
    if ingest_result.site_name and not media.publisher:
        media.publisher = ingest_result.site_name[:255]
        changed = True
    edition_date = normalize_source_publication_date(ingest_result.published_time)
    if isinstance(edition_date, Present):
        media.edition_published_date = edition_date.value
        changed = True
    if changed:
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )


def _web_article_observation(ingest_result: IngestResult) -> ContributorObservationBatch:
    """The captured byline becomes one `author` observation with no identity key.

    An empty byline is `not_observed`: absent data preserves prior credits.
    """
    byline = re.sub(r"^by\s+", "", (ingest_result.byline or "").strip(), flags=re.IGNORECASE)
    # Byline people-splitting is unchanged (D-31 reverses only the PDF rule).
    names = [
        name.strip()
        for name in re.split(r"\s*[,;]\s*|\s+and\s+", byline, flags=re.IGNORECASE)
        if name.strip()
    ]
    if not names:
        return NOT_OBSERVED
    batch, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=name) for name in names]}
    )
    if truncated:
        logger.info("web_article_author_truncated", truncated=truncated)
    return batch
