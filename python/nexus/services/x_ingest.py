"""X thread and single-post materialization."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Fragment, Media, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services import library_entries
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.contributor_taxonomy import (
    ContributorObservationBatch,
    RawCreditEntry,
    RawIdentityClaim,
    build_observation,
)
from nexus.services.document_embeds import (
    DocumentEmbedArtifactOccurrence,
    DocumentEmbedTargetMaterialized,
    DocumentEmbedTargetTerminal,
    delete_document_embed_artifacts,
    reconcile_document_embed_edges_for_viewer,
    replace_document_embed_artifact,
    resolved_document_embed_target_media_ids,
)
from nexus.services.fragment_blocks import FragmentBlockSpec, insert_fragment_blocks
from nexus.services.media_author_observation_seam import attach_author_observation
from nexus.services.media_processing_state import mark_ready_for_reading
from nexus.services.reader_apparatus import (
    attach_fragment_locators,
    replace_media_apparatus,
    source_fingerprint,
)
from nexus.services.reader_publication import replace_reader_publication
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_structure import (
    WEB_ARTICLE_HTML_MAX_BYTES,
    prepare_web_article_fragment,
)
from nexus.services.x_client import fetch_author_thread_snapshot, fetch_single_post_snapshot
from nexus.services.x_rendering import (
    RenderedXQuoteOccurrence,
    post_description,
    post_title,
    render_author_thread_fragment_html,
    render_single_post_html,
    thread_description,
    thread_title,
)
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XProviderError,
    XProviderErrorCode,
    XResolvedQuoteReference,
    XSinglePostSnapshot,
    canonical_x_post_url,
    x_author_thread_provider_id,
    x_post_provider_id,
)

logger = get_logger(__name__)

_PROVIDER_ERRORS: dict[XProviderErrorCode, tuple[ApiErrorCode, str]] = {
    XProviderErrorCode.CREDITS_DEPLETED: (
        ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED,
        "X imports are temporarily unavailable.",
    ),
    XProviderErrorCode.AUTH_REJECTED: (
        ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED,
        "X imports are temporarily unavailable.",
    ),
    XProviderErrorCode.RATE_LIMITED: (
        ApiErrorCode.E_X_PROVIDER_RATE_LIMITED,
        "X is rate limiting imports.",
    ),
    XProviderErrorCode.TIMEOUT: (ApiErrorCode.E_X_PROVIDER_TIMEOUT, "X import timed out."),
    XProviderErrorCode.POST_UNAVAILABLE: (
        ApiErrorCode.E_X_POST_UNAVAILABLE,
        "That X post is not available.",
    ),
    XProviderErrorCode.UNAVAILABLE: (
        ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
        "X imports are temporarily unavailable.",
    ),
}


@dataclass(frozen=True, slots=True)
class _PreparedXFragment:
    fragment: Fragment
    fragment_blocks: list[FragmentBlockSpec]
    apparatus_items: list[dict[str, object]]
    apparatus_edges: list[dict[str, object]]
    quote_occurrences: tuple[tuple[RenderedXQuoteOccurrence, int, int], ...]


def materialize_x_author_thread_media(
    session_factory: sessionmaker[Session],
    *,
    viewer_id: UUID,
    media_id: UUID,
    post_id: str,
    source_attempt_id: UUID,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> dict[str, object]:
    """Publish the author thread, deduping onto an existing canonical thread media."""
    snapshot = _fetch(lambda: fetch_author_thread_snapshot(post_id), viewer_id, request_id)
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")
    provider_id = x_author_thread_provider_id(snapshot.author.id, snapshot.conversation_id)
    quoted_posts = {
        quoted_id: reference.post
        for quoted_id, reference in snapshot.quote_references.items()
        if isinstance(reference, XResolvedQuoteReference)
    }
    discovered: dict[str, UUID] = {}

    def discover(db: Session) -> list[UUID]:
        """Read every affected media id before the phase takes its locks."""
        discovered.clear()
        winner_id = _other_media_with_provider_id(db, provider_id, media_id)
        if winner_id is not None:
            discovered["winner"] = winner_id
        for quoted_post in quoted_posts.values():
            existing = _other_media_with_provider_id(db, x_post_provider_id(quoted_post.id), None)
            if existing is not None:
                discovered[f"quote:{quoted_post.id}"] = existing
        return list(discovered.values())

    def publish(
        db: Session, _attempt: object
    ) -> tuple[UUID | None, str, dict[str, UUID], list[UUID]]:
        from nexus.services.media_source_ingest import (
            accept_embedded_source,
            complete_x_post_snapshot_attempt,
            lock_identity,
        )

        locked_quote_ids = {value for key, value in discovered.items() if key.startswith("quote:")}
        for lock_id in sorted(
            {provider_id, *(x_post_provider_id(post.id) for post in quoted_posts.values())}
        ):
            lock_identity(db, lock_id)

        source_library_ids = library_entries.admin_non_default_library_ids_for_media(
            db, viewer_id=viewer_id, media_id=media_id
        )
        winner_id = discovered.get("winner")
        if winner_id is not None:
            library_entries.assign_libraries_for_media_in_current_transaction(
                db, viewer_id, winner_id, source_library_ids
            )
            resolved_target_ids = resolved_document_embed_target_media_ids(db, media_id=winner_id)
            for target_media_id in resolved_target_ids:
                library_entries.assign_libraries_for_media_in_current_transaction(
                    db, viewer_id, target_media_id, source_library_ids
                )
            reconcile_document_embed_edges_for_viewer(db, viewer_id=viewer_id, media_id=winner_id)
            winner = db.get(Media, winner_id)
            if winner is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return winner_id, winner.processing_status.value, {}, resolved_target_ids

        media = db.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        now = datetime.now(UTC)
        quote_media_ids: dict[str, UUID] = {}
        for quoted_id, quoted_post in quoted_posts.items():
            accepted = accept_embedded_source(
                db=db,
                viewer_id=viewer_id,
                url=canonical_x_post_url(quoted_id),
                parent_media_id=media.id,
                document_embed_key=f"x-quote-post:{quoted_id}",
                library_ids=source_library_ids,
                request_id=request_id,
            )
            quote_media = db.get(Media, accepted.media_id)
            if quote_media is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            already_published = (
                quote_media.processing_status == ProcessingStatus.ready_for_reading
                and accepted.source_attempt_status == "succeeded"
            )
            if not already_published:
                _replace_post_artifacts(
                    db,
                    viewer_id=viewer_id,
                    media=quote_media,
                    snapshot=XSinglePostSnapshot(
                        requested_post_id=quoted_post.id,
                        canonical_url=canonical_x_post_url(quoted_post.id),
                        post=quoted_post,
                        users=snapshot.users,
                        media=snapshot.media,
                    ),
                    now=now,
                )
                mark_ready_for_reading(db, quote_media)
                complete_x_post_snapshot_attempt(
                    db,
                    media=quote_media,
                    source_attempt_id=accepted.source_attempt_id,
                    viewer_id=viewer_id,
                    post_id=quoted_post.id,
                    canonical_url=canonical_x_post_url(quoted_post.id),
                    request_id=request_id,
                )
            quote_media_ids[quoted_id] = quote_media.id

        replace_reader_publication(
            db,
            media_id=media.id,
            expected_kind="web_article",
            replace_projection=lambda locked_media: _replace_thread_projection(
                db,
                viewer_id=viewer_id,
                media=locked_media,
                snapshot=snapshot,
                now=now,
                provider_id=provider_id,
                source_attempt_id=source_attempt_id,
                request_id=request_id,
                quote_media_ids=quote_media_ids,
                locked_quote_ids=locked_quote_ids,
            ),
        )
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
        return (
            None,
            ProcessingStatus.ready_for_reading.value,
            quote_media_ids,
            sorted(set(quote_media_ids.values()), key=str),
        )

    winner_id, processing_status, quote_media_ids, reindex_media_ids = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_x_thread_artifacts",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=discover,
    )
    result: dict[str, object] = {
        "processing_status": processing_status,
        "ingest_enqueued": False,
        "idempotency_outcome": "reused" if winner_id else "refreshed",
        "metadata_enrichment": True,
        "additional_reindex_media_ids": [str(value) for value in reindex_media_ids],
    }
    author_observation = _author_observation(snapshot.author.name, snapshot.author.id)
    if winner_id is not None:
        result["superseded_by_media_id"] = str(winner_id)
        attach_author_observation(
            result,
            media_id=winner_id,
            observation=author_observation,
            source="x_api_author_thread",
        )
        return result
    attach_author_observation(
        result, media_id=media_id, observation=author_observation, source="x_api_author_thread"
    )
    for quoted_id, quoted_post in quoted_posts.items():
        quoted_author = snapshot.users.get(quoted_post.author_id)
        if quoted_author is not None:
            attach_author_observation(
                result,
                media_id=quote_media_ids[quoted_id],
                observation=_author_observation(quoted_author.name, quoted_author.id),
                source="x_api_quoted_post",
            )
    return result


def materialize_x_post_media(
    session_factory: sessionmaker[Session],
    *,
    viewer_id: UUID,
    media_id: UUID,
    post_id: str,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> dict[str, object]:
    """Publish one single X post, deduping onto an existing canonical post media."""
    snapshot = _fetch(lambda: fetch_single_post_snapshot(post_id), viewer_id, request_id)
    provider_id = x_post_provider_id(snapshot.post.id)
    discovered: list[UUID] = []

    def discover(db: Session) -> list[UUID]:
        discovered.clear()
        existing_id = _other_media_with_provider_id(db, provider_id, media_id)
        if existing_id is not None:
            discovered.append(existing_id)
        return list(discovered)

    def publish(db: Session, _attempt: object) -> tuple[UUID | None, str]:
        from nexus.services.media_source_ingest import lock_identity

        lock_identity(db, provider_id)
        if discovered:
            winner_id = discovered[0]
            library_entries.assign_libraries_for_media_in_current_transaction(
                db,
                viewer_id,
                winner_id,
                library_entries.admin_non_default_library_ids_for_media(
                    db, viewer_id=viewer_id, media_id=media_id
                ),
            )
            winner = db.get(Media, winner_id)
            if winner is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return winner_id, winner.processing_status.value
        media = db.get(Media, media_id)
        if media is None:
            raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        _replace_post_artifacts(
            db, viewer_id=viewer_id, media=media, snapshot=snapshot, now=datetime.now(UTC)
        )
        return None, ProcessingStatus.ready_for_reading.value

    winner_id, processing_status = run_source_publication_phase(
        session_factory=session_factory,
        label="publish_x_post_artifacts",
        fence=publication_fence,
        media_ids=(media_id,),
        mutate=publish,
        discover=discover,
    )
    result: dict[str, object] = {
        "processing_status": processing_status,
        "ingest_enqueued": False,
        "idempotency_outcome": "reused" if winner_id else "refreshed",
        "metadata_enrichment": True,
    }
    author = snapshot.users.get(snapshot.post.author_id)
    if winner_id is not None:
        result["superseded_by_media_id"] = str(winner_id)
    elif author is not None:
        attach_author_observation(
            result,
            media_id=media_id,
            observation=_author_observation(author.name, author.id),
            source="x_api_post",
        )
    return result


def _fetch[T](call: Callable[[], T], viewer_id: UUID, request_id: str | None) -> T:
    """Run one provider call, mapping its error taxonomy to the ingest vocabulary."""
    try:
        return call()
    except XProviderError as exc:
        code, message = _PROVIDER_ERRORS[exc.code]
        api_error = ApiError(code, message)
        api_error.retry_after_seconds = exc.retry_after_seconds
        logger.warning(
            "x_provider_failure",
            request_id=request_id,
            user_id=str(viewer_id),
            operation=exc.operation,
            provider_status_code=exc.provider_status_code,
            provider_error_title=exc.provider_error_title,
            api_error_code=code.value,
        )
        raise api_error from exc


def _other_media_with_provider_id(
    db: Session, provider_id: str, exclude_media_id: UUID | None
) -> UUID | None:
    row = db.scalar(
        text(
            """
            SELECT id FROM media
            WHERE provider = 'x'
              AND provider_id = :provider_id
              AND (:exclude_media_id::uuid IS NULL OR id != :exclude_media_id)
            ORDER BY id
            LIMIT 1
            """
        ),
        {"provider_id": provider_id, "exclude_media_id": exclude_media_id},
    )
    return UUID(str(row)) if row is not None else None


def _author_observation(display_name: str, x_user_id: str) -> ContributorObservationBatch:
    """The snapshot display name keyed on the numeric ``x_user`` id, never the handle."""
    batch, truncated = build_observation(
        {
            "author": [
                RawCreditEntry(
                    credited_name=display_name,
                    identity_claims=(RawIdentityClaim("x_user", x_user_id),),
                )
            ]
        }
    )
    if truncated:
        logger.info("x_author_truncated", truncated=truncated)
    return batch


def _replace_post_artifacts(
    db: Session,
    *,
    viewer_id: UUID,
    media: Media,
    snapshot: XSinglePostSnapshot,
    now: datetime,
) -> None:
    replace_reader_publication(
        db,
        media_id=media.id,
        expected_kind="web_article",
        replace_projection=lambda locked_media: _replace_post_projection(
            db, viewer_id=viewer_id, media=locked_media, snapshot=snapshot, now=now
        ),
    )


def _replace_thread_projection(
    db: Session,
    *,
    viewer_id: UUID,
    media: Media,
    snapshot: XAuthorThreadSnapshot,
    now: datetime,
    provider_id: str,
    source_attempt_id: UUID,
    request_id: str | None,
    quote_media_ids: dict[str, UUID],
    locked_quote_ids: set[UUID],
) -> None:
    prepared_fragments = [
        _build_fragment(
            media_id=media.id,
            idx=idx,
            html=rendered.html,
            base_url=rendered.post.permalink,
            created_at=now,
            quote_occurrences=rendered.quote_occurrences,
        )
        for idx, rendered in enumerate(render_author_thread_fragment_html(snapshot))
    ]
    fragments = [prepared.fragment for prepared in prepared_fragments]
    if not "\n\n".join(fragment.canonical_text for fragment in fragments).strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X thread has no readable text")
    delete_web_article_artifacts(db, media_id=media.id, include_content_index=False)
    media.title = thread_title(snapshot)[:255]
    media.canonical_url = None
    media.canonical_source_url = snapshot.canonical_url
    media.provider = "x"
    media.provider_id = provider_id
    media.publisher = "X"
    media.description = thread_description(snapshot)
    for prepared in prepared_fragments:
        db.add(prepared.fragment)
    db.flush()
    for prepared in prepared_fragments:
        insert_fragment_blocks(db, prepared.fragment.id, prepared.fragment_blocks)
    replace_document_embed_artifact(
        db,
        owner_user_id=media.created_by_user_id or viewer_id,
        media_id=media.id,
        source_attempt_id=source_attempt_id,
        occurrences=[
            _embed_occurrence(occurrence, prepared.fragment.id, quote_media_ids)
            for prepared in prepared_fragments
            for occurrence in prepared.quote_occurrences
        ],
        extraction_failed=False,
        request_id=request_id,
        locked_existing_target_media_ids=frozenset(locked_quote_ids),
    )
    replace_media_apparatus(
        db,
        media_id=media.id,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint(
            "x_thread",
            snapshot.canonical_url,
            "\n\n".join(fragment.html_sanitized for fragment in fragments),
            "\n\n".join(fragment.canonical_text for fragment in fragments),
        ),
        items=[
            item
            for prepared in prepared_fragments
            for item in attach_fragment_locators(
                media_id=media.id,
                fragment_id=prepared.fragment.id,
                media_kind="web_article",
                canonical_text=prepared.fragment.canonical_text,
                items=prepared.apparatus_items,
            )
        ],
        edges=[edge for prepared in prepared_fragments for edge in prepared.apparatus_edges],
    )


def _replace_post_projection(
    db: Session,
    *,
    viewer_id: UUID,
    media: Media,
    snapshot: XSinglePostSnapshot,
    now: datetime,
) -> None:
    prepared = _build_fragment(
        media_id=media.id,
        idx=0,
        html=render_single_post_html(snapshot.post, users=snapshot.users, media=snapshot.media),
        base_url=snapshot.canonical_url,
        created_at=now,
    )
    delete_document_embed_artifacts(
        db, owner_user_id=media.created_by_user_id or viewer_id, media_id=media.id
    )
    delete_web_article_artifacts(db, media_id=media.id, include_content_index=False)
    media.title = post_title(snapshot.post, snapshot.users)[:255]
    media.canonical_url = snapshot.canonical_url
    media.canonical_source_url = snapshot.canonical_url
    media.provider = "x"
    media.provider_id = x_post_provider_id(snapshot.post.id)
    media.publisher = "X"
    media.description = post_description(snapshot.post)
    db.add(prepared.fragment)
    db.flush()
    insert_fragment_blocks(db, prepared.fragment.id, prepared.fragment_blocks)
    replace_media_apparatus(
        db,
        media_id=media.id,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint(
            "x_post",
            snapshot.canonical_url,
            prepared.fragment.html_sanitized,
            prepared.fragment.canonical_text,
        ),
        items=attach_fragment_locators(
            media_id=media.id,
            fragment_id=prepared.fragment.id,
            media_kind="web_article",
            canonical_text=prepared.fragment.canonical_text,
            items=prepared.apparatus_items,
        ),
        edges=prepared.apparatus_edges,
    )
    bump_all_collection_families(
        db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
    )


def _build_fragment(
    *,
    media_id: UUID,
    idx: int,
    html: str,
    base_url: str,
    created_at: datetime,
    quote_occurrences: tuple[RenderedXQuoteOccurrence, ...] = (),
) -> _PreparedXFragment:
    if len(html.encode("utf-8")) > WEB_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "X thread HTML is too large")
    try:
        prepared = prepare_web_article_fragment(
            html=html,
            base_url=base_url,
            fragment_idx=idx,
            extract_embeds=bool(quote_occurrences),
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "X thread could not be sanitized"
        ) from exc
    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X post has no readable text")
    located: list[tuple[RenderedXQuoteOccurrence, int, int]] = []
    cursor = 0
    for occurrence in quote_occurrences:
        start = canonical_text.find(occurrence.placeholder_text, cursor)
        if start < 0:
            raise ApiError(
                ApiErrorCode.E_SANITIZATION_FAILED,
                "X quote placeholder is missing from the sanitized fragment",
            )
        cursor = start + len(occurrence.placeholder_text)
        located.append((occurrence, start, cursor))
    return _PreparedXFragment(
        fragment=Fragment(
            media_id=media_id,
            idx=idx,
            html_sanitized=prepared.html_sanitized,
            canonical_text=canonical_text,
            created_at=created_at,
        ),
        fragment_blocks=prepared.fragment_blocks,
        apparatus_items=prepared.apparatus_items,
        apparatus_edges=prepared.apparatus_edges,
        quote_occurrences=tuple(located),
    )


def _embed_occurrence(
    located: tuple[RenderedXQuoteOccurrence, int, int],
    fragment_id: UUID,
    quote_media_ids: dict[str, UUID],
) -> DocumentEmbedArtifactOccurrence:
    occurrence, start, end = located
    target_media_id = quote_media_ids.get(occurrence.post_id)
    target = (
        DocumentEmbedTargetMaterialized(media_id=target_media_id)
        if target_media_id is not None
        else DocumentEmbedTargetTerminal(
            status="failed",
            error_code=ApiErrorCode.E_X_POST_UNAVAILABLE.value,
            error_message="Quoted X post is unavailable.",
        )
    )
    return DocumentEmbedArtifactOccurrence(
        fragment_id=fragment_id,
        ordinal=occurrence.ordinal,
        occurrence_key=occurrence.occurrence_key,
        provider="x",
        embed_kind="post",
        source_shape="provider_json",
        source_url=canonical_x_post_url(occurrence.post_id),
        canonical_source_url=canonical_x_post_url(occurrence.post_id),
        provider_target_ref=x_post_provider_id(occurrence.post_id),
        title=None,
        authored_text=None,
        placeholder_text=occurrence.placeholder_text,
        canonical_start_offset=start,
        canonical_end_offset=end,
        target=target,
    )
