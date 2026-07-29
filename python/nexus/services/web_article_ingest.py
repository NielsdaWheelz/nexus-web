"""Web article source materialization ownership."""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
)
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
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.node_ingest import IngestError, IngestResult, run_node_ingest
from nexus.services.reader_apparatus import (
    attach_fragment_locators,
    replace_media_apparatus,
    source_fingerprint,
)
from nexus.services.source_publication import (
    SourcePublicationFence,
    run_source_publication_phase,
)
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_structure import (
    document_embed_artifact_occurrences,
    prepare_web_article_fragment,
)

logger = get_logger(__name__)


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
        # justify-defect: all generic web work is owned by a durable source attempt.
        raise AssertionError("web source publication requires its source attempt")
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

    ingest_result = run_node_ingest(url)

    if isinstance(ingest_result, IngestError):
        logger.warning(
            "node_ingest_failed",
            media_id=str(media_id),
            error_code=ingest_result.error_code.value,
            detail=ingest_result.message,
        )
        raise ApiError(ingest_result.error_code, ingest_result.message)

    assert isinstance(ingest_result, IngestResult)
    canonical_url = normalize_url_for_display(ingest_result.final_url)

    def publish_canonical_url(db: Session, _attempt: object) -> UUID | None:
        winner_id = db.scalar(
            text(
                """
                SELECT id
                FROM media
                WHERE kind = :kind
                  AND canonical_url = :url
                  AND id != :media_id
                ORDER BY id
                LIMIT 1
                """
            ),
            {
                "kind": MediaKind.web_article.value,
                "url": canonical_url,
                "media_id": media_id,
            },
        )
        if winner_id is not None:
            return UUID(str(winner_id))
        updated = db.execute(
            text(
                """
                UPDATE media
                SET canonical_url = :url, updated_at = now()
                WHERE id = :media_id
                RETURNING id
                """
            ),
            {"url": canonical_url, "media_id": media_id},
        ).scalar()
        if updated is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return None

    winner_id = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_web_canonical_identity",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish_canonical_url,
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
            media_title=ingest_result.title,
            extract_embeds=extract_embeds,
        )
        source_apparatus = (
            prepared
            if ingest_result.source_html == ingest_result.content_html
            else prepare_web_article_fragment(
                html=ingest_result.source_html,
                base_url=ingest_result.base_url,
                fragment_idx=0,
                media_title=ingest_result.title,
                extract_embeds=extract_embeds,
            )
        )
    except Exception as exc:
        error_message = f"Article prep failed: {exc}"
        raise ApiError(ApiErrorCode.E_SANITIZATION_FAILED, error_message) from exc

    author_observation = _build_web_article_observation(ingest_result)
    embed_urls = [
        detected.detected.canonical_source_url
        for detected in prepared.document_embeds
        if extract_embeds
        if detected.detected.resolution_status == "pending"
        and detected.detected.canonical_source_url
    ]
    planned_existing_media_ids: set[UUID] = set()
    fragment_id: UUID | None = None
    for _lock_set_attempt in range(3):
        discovery = session_factory()
        try:
            from nexus.services.media_source_ingest import (
                reusable_embedded_source_media_ids,
            )

            if extract_embeds:
                planned_existing_media_ids.update(
                    reusable_embedded_source_media_ids(
                        discovery,
                        viewer_id=actor_user_id,
                        urls=list(embed_urls),
                    )
                )
            discovery.rollback()
        finally:
            discovery.close()

        def publish_artifacts(db: Session, _attempt: object) -> UUID:
            media = db.get(Media, media_id)
            if media is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            owner_user_id = media.created_by_user_id or actor_user_id
            delete_web_article_artifacts(
                db,
                media_id=media_id,
                include_content_index=False,
            )
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
                        fragment_id=fragment.id,
                        document_embeds=prepared.document_embeds,
                    ),
                    extraction_error_code=prepared.document_embed_extraction_error_code,
                    extraction_error_message=prepared.document_embed_extraction_error_message,
                    request_id=request_id,
                    locked_existing_target_media_ids=frozenset(planned_existing_media_ids),
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
                media_kind="web_article",
                source_fingerprint_value=source_fingerprint(
                    "web_article",
                    canonical_url,
                    hashlib.sha256(ingest_result.content_html.encode("utf-8")).hexdigest(),
                    hashlib.sha256(ingest_result.source_html.encode("utf-8")).hexdigest(),
                    prepared.canonical_text,
                ),
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

        try:
            fragment_id = run_source_publication_phase(
                session_factory=session_factory,
                label="publish_web_article_artifacts",
                fence=publication_fence,
                media_ids=tuple({media_id, *planned_existing_media_ids}),
                mutate=publish_artifacts,
            )
            break
        except DocumentEmbedLockSetChanged as exc:
            planned_existing_media_ids.add(exc.media_id)
    if fragment_id is None:
        # justify-defect: a continuously changing child identity cannot be
        # published under a finite exact lock set.
        raise AssertionError("web embed media lock set did not stabilize")

    result: dict[str, object] = {
        "status": "success",
        "canonical_url": canonical_url,
        "title": ingest_result.title,
        "provider_fixture": ingest_result.provider_fixture,
        "fragment_id": str(fragment_id),
        "metadata_enrichment": True,
    }
    attach_author_observation(
        result,
        observation=author_observation,
        source="web_article_byline",
    )
    return result


def _persist_web_metadata(db: Session, media: Media, ingest_result: IngestResult) -> None:
    changed = False
    if ingest_result.excerpt and not media.description:
        media.description = ingest_result.excerpt[:2000]
        changed = True

    if ingest_result.site_name and not media.publisher:
        media.publisher = ingest_result.site_name[:255]
        changed = True

    if ingest_result.published_time and not media.published_date:
        media.published_date = ingest_result.published_time[:64]
        changed = True
    if ingest_result.title:
        changed = True
    if changed:
        bump_all_collection_families(
            db,
            families=(
                CollectionFamily.AuthorWorks,
                CollectionFamily.LibraryEntries,
            ),
        )


def _split_byline_names(byline_raw: str | None) -> list[str]:
    byline = byline_raw.strip() if byline_raw else ""
    byline = re.sub(r"^by\s+", "", byline, flags=re.IGNORECASE)
    # Byline people-splitting is unchanged (D-31 reverses only the PDF rule).
    names = re.split(r"\s*[,;]\s*|\s+and\s+", byline, flags=re.IGNORECASE) if byline else []
    return [name.strip() for name in names if name.strip()]


def _build_web_article_observation(ingest_result: IngestResult) -> ContributorObservationBatch:
    """Structured/captured byline -> one ``{author}`` observation, no identity key.

    A web article carries no typed durable actor key today (spec 5), so the
    observation never claims one. An empty byline is ``not_observed`` (absent
    data preserves prior credits), never an erase.
    """
    names = _split_byline_names(ingest_result.byline)
    if not names:
        return NOT_OBSERVED
    batch, truncated = build_observation(
        {"author": [RawCreditEntry(credited_name=name) for name in names]}
    )
    if truncated:
        logger.info("web_article_author_truncated", truncated=truncated)
    return batch
