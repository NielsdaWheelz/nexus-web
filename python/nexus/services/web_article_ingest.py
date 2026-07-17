"""Web article source materialization ownership."""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.contributor_taxonomy import (
    NOT_OBSERVED,
    ContributorObservationBatch,
    RawCreditEntry,
    build_observation,
)
from nexus.services.contributors import MediaTarget, replace_observed_role_slices
from nexus.services.document_embeds import replace_document_embed_artifact
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.media_deletion import (
    delete_document_storage_objects,
    delete_duplicate_document_media,
)
from nexus.services.media_processing_state import (
    begin_extraction,
    mark_ready_for_reading,
)
from nexus.services.media_processing_state import (
    mark_failed as mark_media_failed,
)
from nexus.services.metadata_dispatch import try_enqueue_metadata_enrichment
from nexus.services.node_ingest import IngestError, IngestResult, run_node_ingest
from nexus.services.reader_apparatus import (
    attach_fragment_locators,
    replace_media_apparatus,
    source_fingerprint,
)
from nexus.services.url_normalize import normalize_url_for_display
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_indexing import index_web_article_evidence
from nexus.services.web_article_structure import prepare_web_article_fragment

logger = get_logger(__name__)


def materialize_web_article_source(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
    source_attempt_id: UUID | None = None,
) -> dict[str, object]:
    """Materialize a generic web URL under the durable source-ingest owner."""
    return _do_ingest(
        db,
        media_id,
        actor_user_id,
        request_id,
        begin_media_extraction=False,
        mark_terminal_media_state=False,
        index_content=False,
        dispatch_metadata_enrichment=False,
        source_attempt_id=source_attempt_id,
    )


def run_ingest_sync(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None = None,
    source_attempt_id: UUID | None = None,
) -> dict[str, object]:
    """Run web article ingestion synchronously with the provided session."""
    return _do_ingest(db, media_id, actor_user_id, request_id, source_attempt_id=source_attempt_id)


def _do_ingest(
    db: Session,
    media_id: UUID,
    actor_user_id: UUID,
    request_id: str | None,
    *,
    begin_media_extraction: bool = True,
    mark_terminal_media_state: bool = True,
    index_content: bool = True,
    dispatch_metadata_enrichment: bool = True,
    source_attempt_id: UUID | None = None,
) -> dict[str, object]:
    media = db.get(Media, media_id)
    if media is None:
        if not mark_terminal_media_state:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return {"status": "skipped", "reason": "media_not_found"}

    if media.processing_status == ProcessingStatus.ready_for_reading:
        fragments = (
            db.query(Fragment)
            .filter(Fragment.media_id == media_id)
            .order_by(Fragment.idx.asc())
            .all()
        )
        content_index_ready = db.execute(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM content_index_states mcis
                    JOIN content_chunks cc ON cc.owner_kind = mcis.owner_kind AND cc.owner_id = mcis.owner_id
                    WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :id
                      AND mcis.status = 'ready'
                      AND cc.source_kind = 'web_article'
                )
                """
            ),
            {"id": media_id},
        ).scalar()
        if fragments and content_index_ready:
            return {"status": "skipped", "reason": "already_ready"}
        if fragments:
            index_web_article_evidence(
                db,
                media_id=media_id,
                fragment_id=fragments[0].id,
                fragments=fragments,
                reason="web_article_repair",
                language=media.language,
                request_id=request_id,
                log_event="web_article_repair_index_failed",
            )
            return {"status": "success", "reason": "rebuilt_content_index"}

    if begin_media_extraction:
        begin_extraction(db, media)
        db.commit()

    url = media.requested_url
    if not url:
        error_message = "No requested_url on media"
        if mark_terminal_media_state:
            mark_web_article_failed(db, media_id, ApiErrorCode.E_INGEST_FAILED, error_message)
            return {"status": "failed", "reason": "no_url"}
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, error_message)

    ingest_result = run_node_ingest(url)

    if isinstance(ingest_result, IngestError):
        logger.warning(
            "node_ingest_failed",
            media_id=str(media_id),
            error_code=ingest_result.error_code.value,
            detail=ingest_result.message,
        )
        if mark_terminal_media_state:
            mark_web_article_failed(db, media_id, ingest_result.error_code, ingest_result.message)
            return {"status": "failed", "reason": str(ingest_result.error_code.value)}
        raise ApiError(ingest_result.error_code, ingest_result.message)

    assert isinstance(ingest_result, IngestResult)
    canonical_url = normalize_url_for_display(ingest_result.final_url)
    dedup_result = _try_set_canonical_url(db, media_id, canonical_url)

    if dedup_result == "duplicate":
        winner_id = _handle_duplicate(
            db,
            media_id,
            canonical_url,
            actor_user_id,
            delete_loser=mark_terminal_media_state,
        )
        if winner_id is None:
            error_message = "Canonical duplicate winner not found"
            if mark_terminal_media_state:
                mark_web_article_failed(
                    db,
                    media_id,
                    ApiErrorCode.E_INGEST_FAILED,
                    error_message,
                )
                return {"status": "failed", "reason": "duplicate_winner_not_found"}
            raise ApiError(ApiErrorCode.E_INGEST_FAILED, error_message)
        return {
            "status": "deduped",
            "canonical_url": canonical_url,
            "media_id": str(winner_id),
        }

    if dedup_result == "media_gone":
        if not mark_terminal_media_state:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return {"status": "skipped", "reason": "media_deleted"}

    try:
        prepared = prepare_web_article_fragment(
            html=ingest_result.content_html,
            embed_source_html=ingest_result.source_html,
            base_url=ingest_result.base_url,
            fragment_idx=0,
            media_title=ingest_result.title,
            extract_embeds=True,
        )
        source_apparatus = (
            prepared
            if ingest_result.source_html == ingest_result.content_html
            else prepare_web_article_fragment(
                html=ingest_result.source_html,
                base_url=ingest_result.base_url,
                fragment_idx=0,
                media_title=ingest_result.title,
            )
        )
    except Exception as exc:
        error_message = f"Article prep failed: {exc}"
        if mark_terminal_media_state:
            mark_web_article_failed(db, media_id, ApiErrorCode.E_SANITIZATION_FAILED, error_message)
            return {"status": "failed", "reason": "sanitization_failed"}
        raise ApiError(ApiErrorCode.E_SANITIZATION_FAILED, error_message) from exc

    now = datetime.now(UTC)
    delete_web_article_artifacts(
        db,
        owner_user_id=media.created_by_user_id or actor_user_id,
        media_id=media_id,
        include_content_index=False,
    )

    fragment = Fragment(
        media_id=media_id,
        idx=0,
        html_sanitized=prepared.html_sanitized,
        canonical_text=prepared.canonical_text,
        created_at=now,
    )
    db.add(fragment)
    db.flush()
    insert_fragment_blocks(db, fragment.id, prepared.fragment_blocks)
    queued_children = replace_document_embed_artifact(
        db,
        owner_user_id=media.created_by_user_id or actor_user_id,
        media_id=media_id,
        source_attempt_id=source_attempt_id,
        fragment_id=fragment.id,
        document_embeds=prepared.document_embeds,
        extraction_error_code=prepared.document_embed_extraction_error_code,
        extraction_error_message=prepared.document_embed_extraction_error_message,
        request_id=request_id,
    )

    media = db.get(Media, media_id)
    if media is None:
        if not mark_terminal_media_state:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        return {"status": "failed", "reason": "media_deleted_during_ingest"}

    if ingest_result.title:
        media.title = ingest_result.title[:255]

    _persist_web_metadata(media, ingest_result)
    author_observation = _build_web_article_observation(ingest_result)

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

    fragment_id = fragment.id
    media_language = media.language
    db.commit()

    # End the source transaction, then the fresh-session author mutation, then
    # cross ready (spec 2.4). NOT_OBSERVED returns before any session opens and
    # preserves any prior byline. In the worker path ``run_source_attempt`` owns
    # the ready transition; the author op still lands first because it completes
    # before this handler returns.
    replace_observed_role_slices(
        target=MediaTarget(media_id),
        observation=author_observation,
        source="web_article_byline",
    )

    if mark_terminal_media_state:
        media = db.get(Media, media_id)
        if media is not None:
            mark_ready_for_reading(db, media)
            db.commit()

    if queued_children:
        from nexus.services.media_source_ingest import enqueue_accepted_source_attempt

        for child_media_id, child_attempt_id in queued_children:
            enqueue_accepted_source_attempt(
                db,
                media_id=child_media_id,
                attempt_id=child_attempt_id,
                actor_user_id=actor_user_id,
                request_id=request_id,
            )

    if index_content:
        index_web_article_evidence(
            db,
            media_id=media_id,
            fragment_id=fragment_id,
            fragments=[fragment],
            reason="web_article_ingest",
            language=media_language,
            request_id=request_id,
        )

    if dispatch_metadata_enrichment:
        if try_enqueue_metadata_enrichment(db, media_id=media_id, request_id=request_id):
            db.commit()

    result: dict[str, object] = {
        "status": "success",
        "canonical_url": canonical_url,
        "title": ingest_result.title,
        "provider_fixture": ingest_result.provider_fixture,
    }
    if not index_content:
        result["post_success_index"] = "web_article"
        result["fragment_id"] = str(fragment_id)
    if not dispatch_metadata_enrichment:
        result["metadata_enrichment"] = True
    return result


def mark_web_article_failed(
    db: Session,
    media_id: UUID,
    error_code: ApiErrorCode,
    message: str,
) -> None:
    """Mark web article media as failed with extract-stage error details."""
    media = db.get(Media, media_id)
    if media is None:
        db.commit()
        return
    mark_media_failed(
        db,
        media,
        stage="extract",
        error_code=error_code.value,
        error_message=message[:1000],
    )


def _persist_web_metadata(media: Media, ingest_result: IngestResult) -> None:
    if ingest_result.excerpt and not media.description:
        media.description = ingest_result.excerpt[:2000]

    if ingest_result.site_name and not media.publisher:
        media.publisher = ingest_result.site_name[:255]

    if ingest_result.published_time and not media.published_date:
        media.published_date = ingest_result.published_time[:64]


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


def _try_set_canonical_url(
    db: Session,
    media_id: UUID,
    canonical_url: str,
) -> str:
    row = db.execute(
        text("SELECT id FROM media WHERE id = :id FOR UPDATE"),
        {"id": media_id},
    ).fetchone()
    if not row:
        return "media_gone"

    try:
        db.execute(
            text("UPDATE media SET canonical_url = :url WHERE id = :id"),
            {"url": canonical_url, "id": media_id},
        )
        db.flush()
        db.commit()
        return "success"
    except IntegrityError:
        db.rollback()
        return "duplicate"


def _handle_duplicate(
    db: Session,
    loser_id: UUID,
    canonical_url: str,
    actor_user_id: UUID,
    *,
    delete_loser: bool,
) -> UUID | None:
    from nexus.services.media_deletion import clear_user_media_deletion

    winner_row = db.execute(
        text(
            """
            SELECT id FROM media
            WHERE kind = :kind AND canonical_url = :url AND id != :loser_id
            LIMIT 1
            """
        ),
        {"kind": MediaKind.web_article.value, "url": canonical_url, "loser_id": loser_id},
    ).fetchone()

    if not winner_row:
        return None

    winner_id = winner_row[0]
    library_row = db.execute(
        text(
            """
            SELECT id FROM libraries
            WHERE owner_user_id = :user_id AND is_default = true
            """
        ),
        {"user_id": actor_user_id},
    ).fetchone()

    if library_row:
        from nexus.services import library_entries

        # The physical entry IS the whole direct-default contract now (no
        # separate intrinsic/closure provenance). ensure_entry runs the
        # teardown reference barrier (spec S3/S4.3) itself before the first
        # lifetime reference; there is no intervening library lock here to
        # make a separate pre-check load-bearing (unlike add_media_to_library).
        library_entries.ensure_entry(
            db, library_row[0], library_entries.media_target(winner_id)
        )
        clear_user_media_deletion(db, actor_user_id, winner_id)

    storage_paths: list[str] = []
    if delete_loser:
        storage_paths = delete_duplicate_document_media(db, loser_id)
    else:
        db.flush()
    db.commit()
    delete_document_storage_objects(storage_paths)
    return winner_id
