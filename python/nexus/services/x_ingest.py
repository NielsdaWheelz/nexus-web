"""Detached X acquisition and atomic source/reader publication."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.x_source import XSourceAuthor, XSourceSnapshot
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services import document_embeds as embeds
from nexus.services import library_entries
from nexus.services import x_rendering as render
from nexus.services.consumption.reader_cursor import (
    apply_source_replacement,
    prepare_source_replacement,
)
from nexus.services.media_processing_state import mark_ready_for_reading
from nexus.services.media_source_ingest import (
    accept_embedded_source,
    complete_x_post_snapshot_attempt,
    lock_identity,
)
from nexus.services.metadata_dispatch import enqueue_metadata_enrichment
from nexus.services.reader_publication import (
    ReplaceSourceIssues,
    read_publication_generation,
    replace_reader_publication,
)
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.web_article import prepare_article, replace_article_fragments
from nexus.services.web_article_structure import WebArticlePreparedFragment
from nexus.services.x_client import AcquiredXSource, fetch_author_thread, fetch_single_post
from nexus.services.x_identity import canonical_x_post_url, x_post_provider_id
from nexus.services.x_source import (
    authored_text,
    publish_x_source,
    quoted_post_snapshot,
    source_label,
)


@dataclass(frozen=True, slots=True)
class PreparedXDocument:
    snapshot: XSourceSnapshot
    provider_id: str
    fragments: tuple[tuple[render.RenderedPost, WebArticlePreparedFragment], ...]


@dataclass(frozen=True, slots=True)
class PreparedXSource:
    document: PreparedXDocument
    quotes: Mapping[str, PreparedXDocument]


def prepare_x_source(*, post_id: str, author_thread: bool) -> PreparedXSource:
    acquired = fetch_author_thread(post_id) if author_thread else fetch_single_post(post_id)
    snapshot = acquired.snapshot
    quote_ids = {
        reference.post_id
        for primary in snapshot.primary_post_ids
        for reference in snapshot.posts[primary].references
        if reference.kind == "quoted" and reference.availability == "available"
    }
    return PreparedXSource(
        document=_prepare_document(acquired, embed_quotes=True),
        quotes={
            post_id: _prepare_document(
                AcquiredXSource(
                    provider_id=x_post_provider_id(post_id),
                    snapshot=quoted_post_snapshot(snapshot, post_id),
                ),
                embed_quotes=False,
            )
            for post_id in sorted(quote_ids)
        },
    )


def _prepare_document(acquired: AcquiredXSource, *, embed_quotes: bool) -> PreparedXDocument:
    return PreparedXDocument(
        snapshot=acquired.snapshot,
        provider_id=acquired.provider_id,
        fragments=tuple(
            (
                item,
                prepare_article(
                    item.html,
                    base_url=canonical_x_post_url(item.post.id),
                    document_url=canonical_x_post_url(item.post.id),
                    extract_embeds=bool(item.quotes),
                    fragment_idx=index,
                ),
            )
            for index, item in enumerate(
                render.render_source(acquired.snapshot, embed_quotes=embed_quotes)
            )
        ),
    )


def x_publication_media_ids(
    db: Session, *, media_id: UUID, prepared: PreparedXSource
) -> list[UUID]:
    """Discover all existing identities and embed owners before source locks are taken."""
    identities = [
        prepared.document.provider_id,
        *(quote.provider_id for quote in prepared.quotes.values()),
    ]
    ids = set(
        db.scalars(select(Media.id).where(Media.provider == "x", Media.provider_id.in_(identities)))
    )
    ids.add(media_id)
    # Identity reuse also transfers access to the existing holder's embedded targets.
    for identity in tuple(ids):
        ids.update(embeds.resolved_document_embed_target_media_ids(db, media_id=identity))
    ids.update(
        db.scalars(
            text("SELECT DISTINCT media_id FROM document_embeds WHERE target_media_id = ANY(:ids)"),
            {"ids": sorted(ids)},
        )
    )
    return sorted(ids)


def publish_prepared_x_source(
    db: Session,
    *,
    media_id: UUID,
    source_attempt_id: UUID,
    viewer_id: UUID,
    request_id: str | None,
    prepared: PreparedXSource,
) -> SourceRunOutcome:
    """Flush-only; the coordinator fences and commits reader, attempt and jobs together."""
    document = prepared.document
    for identity in sorted(
        {document.provider_id, *(quote.provider_id for quote in prepared.quotes.values())}
    ):
        lock_identity(db, identity)
    library_ids = library_entries.admin_non_default_library_ids_for_media(
        db, viewer_id=viewer_id, media_id=media_id
    )
    holder = db.scalar(
        select(Media).where(
            Media.provider == "x", Media.provider_id == document.provider_id, Media.id != media_id
        )
    )
    if holder is not None:
        for target_id in (
            holder.id,
            *embeds.resolved_document_embed_target_media_ids(db, media_id=holder.id),
        ):
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, target_id, library_ids
            )
        embeds.reconcile_document_embed_edges_for_viewer(
            db, viewer_id=viewer_id, media_id=holder.id
        )
        return SourceRunOutcome(
            diagnostics={
                "processing_status": holder.processing_status.value,
                "ingest_enqueued": False,
                "idempotency_outcome": "reused",
            },
            superseded_by_media_id=holder.id,
            metadata_enrichment=False,
        )
    quote_media_ids: dict[str, UUID] = {}
    completed_quotes: list[UUID] = []
    observations = source_contributor_observations(
        media_id=media_id,
        observation=_author(document.snapshot.posts[document.snapshot.requested_post_id].author),
        source="x_api_author_thread"
        if document.snapshot.source_kind == "author_thread"
        else "x_api_post",
    )
    for quote_id, quote in prepared.quotes.items():
        accepted = accept_embedded_source(
            db=db,
            viewer_id=viewer_id,
            url=canonical_x_post_url(quote_id),
            parent_media_id=media_id,
            document_embed_key=f"x-quote-post:{quote_id}",
            library_ids=library_ids,
        )
        quote_media_ids[quote_id] = accepted.media_id
        # A parent capture never replaces a child's independent published source/refresh.
        if read_publication_generation(db, media_id=accepted.media_id) is not None:
            continue
        child = db.get(Media, accepted.media_id)
        assert child is not None
        attempt = complete_x_post_snapshot_attempt(
            db,
            media=child,
            source_attempt_id=accepted.source_attempt_id,
            parent_source_attempt_id=source_attempt_id,
            viewer_id=viewer_id,
            post_id=quote_id,
            canonical_url=canonical_x_post_url(quote_id),
        )
        _publish_document(
            db,
            media_id=child.id,
            source_attempt_id=attempt.id,
            viewer_id=viewer_id,
            document=quote,
            quote_media_ids={},
        )
        enqueue_metadata_enrichment(
            db,
            media_id=child.id,
            requester_user_id=child.created_by_user_id or viewer_id,
            request_id=request_id,
        )
        completed_quotes.append(child.id)
        observations += source_contributor_observations(
            media_id=child.id,
            observation=_author(quote.snapshot.posts[quote_id].author),
            source="x_api_quoted_post",
        )
    _publish_document(
        db,
        media_id=media_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        document=document,
        quote_media_ids=quote_media_ids,
    )
    return SourceRunOutcome(
        diagnostics={
            "processing_status": "ready_for_reading",
            "ingest_enqueued": False,
            "idempotency_outcome": "refreshed",
        },
        observations=observations,
        additional_reindex_media_ids=tuple(completed_quotes),
        metadata_enrichment=True,
    )


def _publish_document(
    db: Session,
    *,
    media_id: UUID,
    source_attempt_id: UUID,
    viewer_id: UUID,
    document: PreparedXDocument,
    quote_media_ids: Mapping[str, UUID],
) -> None:
    def project(media: Media) -> None:
        snapshot = document.snapshot
        plan = prepare_source_replacement(
            db,
            media_id=media.id,
            replacement_texts=[prepared.canonical_text for _, prepared in document.fragments],
        )
        media.title = source_label(snapshot)
        media.description = "\n\n".join(
            authored_text(snapshot.posts[post_id]) for post_id in snapshot.primary_post_ids
        )[:2000]
        media.canonical_url = (
            canonical_x_post_url(snapshot.requested_post_id)
            if snapshot.source_kind == "post"
            else None
        )
        media.canonical_source_url = canonical_x_post_url(snapshot.primary_post_ids[0])
        media.provider, media.provider_id, media.publisher = "x", document.provider_id, "X"
        fragment_ids = replace_article_fragments(
            db,
            media_id=media.id,
            fragments=[(prepared, item.html) for item, prepared in document.fragments],
        )
        apply_source_replacement(db, plan=plan, replacement_fragment_ids=fragment_ids)
        embeds.replace_document_embed_artifact(
            db,
            owner_user_id=media.created_by_user_id or viewer_id,
            media_id=media.id,
            source_attempt_id=source_attempt_id,
            occurrences=[
                occurrence
                for fragment_id, (item, prepared) in zip(
                    fragment_ids, document.fragments, strict=True
                )
                for occurrence in _quote_occurrences(
                    fragment_id, prepared.canonical_text, item.quotes, quote_media_ids
                )
            ],
            extraction_failed=False,
            locked_existing_target_media_ids=frozenset(),
        )
        publish_x_source(
            db, media_id=media.id, source_attempt_id=source_attempt_id, snapshot=snapshot
        )
        mark_ready_for_reading(db, media)

    replace_reader_publication(
        db,
        media_id=media_id,
        expected_kind="web_article",
        issues=ReplaceSourceIssues(issues=()),
        replace_projection=project,
    )


def _quote_occurrences(
    fragment_id: UUID,
    canonical_text: str,
    quotes: tuple[render.RenderedQuote, ...],
    quote_media_ids: Mapping[str, UUID],
) -> list[embeds.DocumentEmbedArtifactOccurrence]:
    occurrences: list[embeds.DocumentEmbedArtifactOccurrence] = []
    end = 0
    for quote in quotes:
        start = canonical_text.find(quote.placeholder_text, end)
        if start < 0:
            raise ApiError(ApiErrorCode.E_SANITIZATION_FAILED, "X quote placeholder is missing.")
        end = start + len(quote.placeholder_text)
        target_id = quote_media_ids.get(quote.post_id)
        url = canonical_x_post_url(quote.post_id)
        occurrences.append(
            embeds.DocumentEmbedArtifactOccurrence(
                fragment_id=fragment_id,
                ordinal=quote.ordinal,
                occurrence_key=quote.occurrence_key,
                provider="x",
                embed_kind="post",
                source_shape="provider_json",
                source_url=url,
                canonical_source_url=url,
                provider_target_ref=x_post_provider_id(quote.post_id),
                title=None,
                authored_text=None,
                placeholder_text=quote.placeholder_text,
                canonical_start_offset=start,
                canonical_end_offset=end,
                target=embeds.DocumentEmbedTargetMaterialized(media_id=target_id)
                if target_id is not None
                else embeds.DocumentEmbedTargetTerminal(
                    status="failed",
                    error_code=ApiErrorCode.E_X_POST_UNAVAILABLE.value,
                    error_message="Quoted X post is unavailable.",
                ),
            )
        )
    return occurrences


def _author(user: XSourceAuthor) -> taxonomy.ContributorObservationBatch:
    batch, _truncated = taxonomy.build_observation(
        {
            "author": [
                taxonomy.RawCreditEntry(
                    credited_name=user.name,
                    identity_claims=(taxonomy.RawIdentityClaim("x_user", user.id),),
                )
            ]
        }
    )
    return batch
