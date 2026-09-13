"""X URL ingest ownership."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from time import perf_counter
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Fragment, Media, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services import library_entries
from nexus.services import media_source_types as source_types
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_families,
)
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
from nexus.services.provider_events import record_external_provider_event
from nexus.services.reader_apparatus import (
    attach_fragment_locators,
    replace_media_apparatus,
    source_fingerprint,
)
from nexus.services.source_publication import (
    SourcePublicationFence,
    run_source_publication_phase,
)
from nexus.services.web_article_artifacts import delete_web_article_artifacts
from nexus.services.web_article_structure import (
    WEB_ARTICLE_HTML_MAX_BYTES,
    prepare_web_article_fragment,
)
from nexus.services.x_client import fetch_author_thread_snapshot, fetch_single_post_snapshot
from nexus.services.x_identity import canonical_x_post_url
from nexus.services.x_provider_lock import lock_x_provider_identity
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
    XUnavailableQuoteReference,
    x_author_thread_provider_id,
    x_post_provider_id,
)

logger = get_logger(__name__)


class _XMediaLockSetChanged(Exception):
    def __init__(self, media_id: UUID) -> None:
        super().__init__(str(media_id))
        self.media_id = media_id


@dataclass(frozen=True)
class _PreparedXFragment:
    fragment: Fragment
    fragment_blocks: list[FragmentBlockSpec]
    apparatus_items: list[dict[str, object]]
    apparatus_edges: list[dict[str, object]]
    quote_occurrences: tuple[_PreparedXQuoteOccurrence, ...]


@dataclass(frozen=True)
class _PreparedXQuoteOccurrence:
    rendered: RenderedXQuoteOccurrence
    canonical_start_offset: int
    canonical_end_offset: int


def _build_x_author_observation(display_name: str, x_user_id: str) -> ContributorObservationBatch:
    """Snapshot display name + ``x_user`` numeric-id key -> one ``{author}`` batch.

    The numeric user id already captured on the snapshot is promoted to the exact
    identity key (D-24); the X username/handle is never an identity key. An
    invalid id is omitted by ``build_observation`` and the name still stands.
    """
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
    """Materialize a previously accepted provisional X media row."""
    return _refresh_x_author_thread_media_for_viewer(
        session_factory,
        viewer_id,
        media_id=media_id,
        post_id=post_id,
        source_attempt_id=source_attempt_id,
        request_id=request_id,
        publication_fence=publication_fence,
    )


def materialize_x_post_media(
    session_factory: sessionmaker[Session],
    *,
    viewer_id: UUID,
    media_id: UUID,
    post_id: str,
    source_attempt_id: UUID,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> dict[str, object]:
    """Materialize a previously accepted provisional single X post media row."""
    return _refresh_x_post_media_for_viewer(
        session_factory,
        viewer_id,
        media_id=media_id,
        post_id=post_id,
        source_attempt_id=source_attempt_id,
        request_id=request_id,
        publication_fence=publication_fence,
    )


def _refresh_x_author_thread_media_for_viewer(
    session_factory: sessionmaker[Session],
    viewer_id: UUID,
    *,
    media_id: UUID,
    post_id: str,
    source_attempt_id: UUID,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> dict[str, object]:
    started_at = perf_counter()
    try:
        snapshot = fetch_author_thread_snapshot(post_id)
    except XProviderError as exc:
        provider_failure = exc

        def publish_provider_failure(db: Session, _attempt: object) -> None:
            _record_x_provider_failure(
                db,
                error=provider_failure,
                request_id=request_id,
                source_attempt_id=source_attempt_id,
                viewer_id=viewer_id,
                target_ref=post_id,
                duration_ms=_duration_ms(started_at),
            )

        run_source_publication_phase(
            session_factory=session_factory,
            label="publish_x_thread_provider_failure",
            fence=publication_fence,
            media_ids=(media_id,),
            mutate=publish_provider_failure,
        )
        raise _api_error_from_x_provider_error(exc) from exc
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")

    provider_id = x_author_thread_provider_id(snapshot.author.id, snapshot.conversation_id)
    resolved_quote_posts = {
        post_id: reference.post
        for post_id, reference in snapshot.quote_references.items()
        if isinstance(reference, XResolvedQuoteReference)
    }
    planned_thread_winner_id: UUID | None = None
    locked_existing_quote_ids: set[UUID] = set()

    for _lock_set_attempt in range(3):
        discovery = session_factory()
        try:
            discovered_thread_id = discovery.scalar(
                text(
                    """
                    SELECT id FROM media
                    WHERE provider = 'x'
                      AND provider_id = :provider_id
                      AND id != :media_id
                    ORDER BY id
                    LIMIT 1
                    """
                ),
                {"provider_id": provider_id, "media_id": media_id},
            )
            if discovered_thread_id is not None:
                planned_thread_winner_id = UUID(str(discovered_thread_id))
            for quoted_post in resolved_quote_posts.values():
                quote_provider_id = x_post_provider_id(quoted_post.id)
                discovered_quote_id = discovery.scalar(
                    text(
                        """
                        SELECT id FROM media
                        WHERE provider = 'x' AND provider_id = :provider_id
                        ORDER BY id
                        LIMIT 1
                        """
                    ),
                    {"provider_id": quote_provider_id},
                )
                if discovered_quote_id is not None:
                    quote_uuid = UUID(str(discovered_quote_id))
                    locked_existing_quote_ids.add(quote_uuid)
            discovery.rollback()
        finally:
            discovery.close()

        def publish_x_thread(
            db: Session,
            _attempt: object,
            planned_winner_id: UUID | None = planned_thread_winner_id,
        ) -> tuple[UUID | None, str, dict[str, UUID], list[UUID]]:
            for lock_provider_id in sorted(
                {
                    provider_id,
                    *(x_post_provider_id(post.id) for post in resolved_quote_posts.values()),
                }
            ):
                lock_x_provider_identity(db, lock_provider_id)

            durable_thread_id = db.scalar(
                text(
                    """
                    SELECT id FROM media
                    WHERE provider = 'x'
                      AND provider_id = :provider_id
                      AND id != :media_id
                    ORDER BY id
                    LIMIT 1
                    """
                ),
                {"provider_id": provider_id, "media_id": media_id},
            )
            if durable_thread_id is not None:
                winner_id = UUID(str(durable_thread_id))
                if winner_id != planned_winner_id:
                    raise _XMediaLockSetChanged(winner_id)
                source_library_ids = library_entries.admin_non_default_library_ids_for_media(
                    db,
                    viewer_id=viewer_id,
                    media_id=media_id,
                )
                library_entries.assign_libraries_for_media_in_current_transaction(
                    db,
                    viewer_id,
                    winner_id,
                    source_library_ids,
                )
                resolved_target_ids = resolved_document_embed_target_media_ids(
                    db, media_id=winner_id
                )
                for target_media_id in resolved_target_ids:
                    library_entries.assign_libraries_for_media_in_current_transaction(
                        db,
                        viewer_id,
                        target_media_id,
                        source_library_ids,
                    )
                reconcile_document_embed_edges_for_viewer(
                    db,
                    viewer_id=viewer_id,
                    media_id=winner_id,
                )
                winner = db.get(Media, winner_id)
                if winner is None:
                    raise AssertionError("planned X thread media disappeared while locked")
                _record_x_provider_success(
                    db,
                    request_id=request_id,
                    source_attempt_id=source_attempt_id,
                    viewer_id=viewer_id,
                    media_id=winner_id,
                    target_ref=provider_id,
                    duration_ms=_duration_ms(started_at),
                    snapshot=snapshot,
                )
                return (
                    winner_id,
                    _status_to_str(winner.processing_status),
                    {},
                    resolved_target_ids,
                )

            media = db.get(Media, media_id)
            if media is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            source_library_ids = library_entries.admin_non_default_library_ids_for_media(
                db,
                viewer_id=viewer_id,
                media_id=media.id,
            )
            now = datetime.now(UTC)
            durable_quote_ids: dict[str, UUID] = {}
            for quoted_id, quoted_post in resolved_quote_posts.items():
                from nexus.services.media_source_ingest import accept_embedded_source

                accepted = accept_embedded_source(
                    db=db,
                    viewer_id=viewer_id,
                    url=canonical_x_post_url(quoted_id),
                    parent_media_id=media.id,
                    document_embed_key=f"x-quote-post:{quoted_id}",
                    library_ids=source_library_ids,
                    request_id=request_id,
                )
                _require_x_quote_source_identity(
                    source_type=accepted.source_type,
                    provider_target_ref=accepted.provider_target_ref,
                    post_id=quoted_id,
                )
                if (
                    not accepted.needs_enqueue
                    and accepted.media_id not in locked_existing_quote_ids
                ):
                    raise _XMediaLockSetChanged(accepted.media_id)
                quote_media = db.get(Media, accepted.media_id)
                if quote_media is None:
                    # justify-defect: embedded-source acceptance published this
                    # child identity in the current transaction.
                    raise AssertionError("accepted X quote media disappeared")
                if not (
                    quote_media.processing_status == ProcessingStatus.ready_for_reading
                    and accepted.source_attempt_status == "succeeded"
                ):
                    _replace_x_post_snapshot_artifacts(
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
                    from nexus.services.media_source_ingest import (
                        complete_x_post_snapshot_attempt,
                    )

                    complete_x_post_snapshot_attempt(
                        db,
                        media=quote_media,
                        source_attempt_id=accepted.source_attempt_id,
                        viewer_id=viewer_id,
                        post_id=quoted_post.id,
                        canonical_url=canonical_x_post_url(quoted_post.id),
                        request_id=request_id,
                    )
                durable_quote_ids[quoted_id] = quote_media.id

            rendered_fragments = render_author_thread_fragment_html(snapshot)
            prepared_fragments = [
                _build_x_fragment(
                    media_id=media.id,
                    idx=idx,
                    html=rendered.html,
                    base_url=rendered.post.permalink,
                    created_at=now,
                    quote_occurrences=rendered.quote_occurrences,
                )
                for idx, rendered in enumerate(rendered_fragments)
            ]
            fragments = [prepared.fragment for prepared in prepared_fragments]
            if not "\n\n".join(fragment.canonical_text for fragment in fragments).strip():
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "X thread has no readable text",
                )
            delete_web_article_artifacts(
                db,
                media_id=media.id,
                include_content_index=False,
            )
            media.title = thread_title(snapshot)[:255]
            media.canonical_url = None
            media.canonical_source_url = snapshot.canonical_url
            media.provider = "x"
            media.provider_id = provider_id
            media.publisher = "X"
            media.description = thread_description(snapshot)
            for prepared_fragment in prepared_fragments:
                db.add(prepared_fragment.fragment)
            db.flush()
            for prepared_fragment in prepared_fragments:
                insert_fragment_blocks(
                    db,
                    prepared_fragment.fragment.id,
                    prepared_fragment.fragment_blocks,
                )
            replace_document_embed_artifact(
                db,
                owner_user_id=media.created_by_user_id or viewer_id,
                media_id=media.id,
                source_attempt_id=source_attempt_id,
                occurrences=[
                    _document_embed_occurrence(
                        prepared=occurrence,
                        fragment_id=prepared.fragment.id,
                        target_media_ids=durable_quote_ids,
                    )
                    for prepared in prepared_fragments
                    for occurrence in prepared.quote_occurrences
                ],
                extraction_error_code=None,
                extraction_error_message=None,
                request_id=request_id,
                locked_existing_target_media_ids=frozenset(locked_existing_quote_ids),
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
                edges=[
                    edge for prepared in prepared_fragments for edge in prepared.apparatus_edges
                ],
            )
            _record_x_provider_success(
                db,
                request_id=request_id,
                source_attempt_id=source_attempt_id,
                viewer_id=viewer_id,
                media_id=media.id,
                target_ref=provider_id,
                duration_ms=_duration_ms(started_at),
                snapshot=snapshot,
            )
            bump_all_collection_families(
                db,
                families=(
                    CollectionFamily.AuthorWorks,
                    CollectionFamily.LibraryEntries,
                ),
            )
            return (
                None,
                ProcessingStatus.ready_for_reading.value,
                durable_quote_ids,
                sorted(set(durable_quote_ids.values()), key=str),
            )

        try:
            affected_existing_ids = {
                media_id,
                *locked_existing_quote_ids,
            }
            if planned_thread_winner_id is not None:
                affected_existing_ids.add(planned_thread_winner_id)
            winner_id, processing_status, quoted_media_ids, reindex_quote_ids = (
                run_source_publication_phase(
                    session_factory=session_factory,
                    label="publish_x_thread_artifacts",
                    fence=publication_fence,
                    media_ids=tuple(affected_existing_ids),
                    mutate=publish_x_thread,
                )
            )
            result: dict[str, object] = {
                "processing_status": processing_status,
                "ingest_enqueued": False,
                "idempotency_outcome": "reused" if winner_id else "refreshed",
                "metadata_enrichment": True,
                "additional_reindex_media_ids": [str(value) for value in reindex_quote_ids],
            }
            if winner_id is not None:
                result["superseded_by_media_id"] = str(winner_id)
                attach_author_observation(
                    result,
                    media_id=winner_id,
                    observation=_build_x_author_observation(
                        snapshot.author.name,
                        snapshot.author.id,
                    ),
                    source="x_api_author_thread",
                )
            else:
                attach_author_observation(
                    result,
                    media_id=media_id,
                    observation=_build_x_author_observation(
                        snapshot.author.name,
                        snapshot.author.id,
                    ),
                    source="x_api_author_thread",
                )
                for quoted_id, quoted_post in resolved_quote_posts.items():
                    quoted_author = snapshot.users.get(quoted_post.author_id)
                    if quoted_author is not None:
                        attach_author_observation(
                            result,
                            media_id=quoted_media_ids[quoted_id],
                            observation=_build_x_author_observation(
                                quoted_author.name,
                                quoted_author.id,
                            ),
                            source="x_api_quoted_post",
                        )
            return result
        except _XMediaLockSetChanged as exc:
            locked_existing_quote_ids.add(exc.media_id)
    raise AssertionError("X thread media lock set did not stabilize")


def _refresh_x_post_media_for_viewer(
    session_factory: sessionmaker[Session],
    viewer_id: UUID,
    *,
    media_id: UUID,
    post_id: str,
    source_attempt_id: UUID,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> dict[str, object]:
    started_at = perf_counter()
    try:
        snapshot = fetch_single_post_snapshot(post_id)
    except XProviderError as exc:
        provider_failure = exc

        def publish_provider_failure(db: Session, _attempt: object) -> None:
            _record_x_provider_failure(
                db,
                error=provider_failure,
                request_id=request_id,
                source_attempt_id=source_attempt_id,
                viewer_id=viewer_id,
                target_ref=post_id,
                duration_ms=_duration_ms(started_at),
                capability="post",
            )

        run_source_publication_phase(
            session_factory=session_factory,
            label="publish_x_post_provider_failure",
            fence=publication_fence,
            media_ids=(media_id,),
            mutate=publish_provider_failure,
        )
        raise _api_error_from_x_provider_error(exc) from exc

    provider_id = x_post_provider_id(snapshot.post.id)
    author = snapshot.users.get(snapshot.post.author_id)
    planned_existing_id: UUID | None = None
    for _lock_set_attempt in range(3):
        discovery = session_factory()
        try:
            existing_id = discovery.scalar(
                text(
                    """
                    SELECT id
                    FROM media
                    WHERE provider = 'x'
                      AND provider_id = :provider_id
                      AND id != :media_id
                    ORDER BY id
                    LIMIT 1
                    """
                ),
                {"provider_id": provider_id, "media_id": media_id},
            )
            if existing_id is not None:
                planned_existing_id = UUID(str(existing_id))
            discovery.rollback()
        finally:
            discovery.close()

        def publish_x_post(
            db: Session,
            _attempt: object,
            planned_winner_id: UUID | None = planned_existing_id,
        ) -> tuple[UUID | None, str]:
            lock_x_provider_identity(db, provider_id)
            durable_existing_id = db.scalar(
                text(
                    """
                    SELECT id
                    FROM media
                    WHERE provider = 'x'
                      AND provider_id = :provider_id
                      AND id != :media_id
                    ORDER BY id
                    LIMIT 1
                    """
                ),
                {"provider_id": provider_id, "media_id": media_id},
            )
            if durable_existing_id is not None:
                durable_existing_uuid = UUID(str(durable_existing_id))
                if durable_existing_uuid != planned_winner_id:
                    raise _XMediaLockSetChanged(durable_existing_uuid)
                source_library_ids = library_entries.admin_non_default_library_ids_for_media(
                    db,
                    viewer_id=viewer_id,
                    media_id=media_id,
                )
                library_entries.assign_libraries_for_media_in_current_transaction(
                    db,
                    viewer_id,
                    durable_existing_uuid,
                    source_library_ids,
                )
                existing_media = db.get(Media, durable_existing_uuid)
                if existing_media is None:
                    raise AssertionError("planned X post media disappeared while locked")
                _record_x_post_provider_success(
                    db,
                    request_id=request_id,
                    source_attempt_id=source_attempt_id,
                    viewer_id=viewer_id,
                    media_id=durable_existing_uuid,
                    target_ref=provider_id,
                    duration_ms=_duration_ms(started_at),
                    snapshot=snapshot,
                )
                return durable_existing_uuid, _status_to_str(existing_media.processing_status)

            media = db.get(Media, media_id)
            if media is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            _replace_x_post_snapshot_artifacts(
                db,
                viewer_id=viewer_id,
                media=media,
                snapshot=snapshot,
                now=datetime.now(UTC),
            )
            _record_x_post_provider_success(
                db,
                request_id=request_id,
                source_attempt_id=source_attempt_id,
                viewer_id=viewer_id,
                media_id=media.id,
                target_ref=provider_id,
                duration_ms=_duration_ms(started_at),
                snapshot=snapshot,
            )
            return None, ProcessingStatus.ready_for_reading.value

        try:
            winner_id, processing_status = run_source_publication_phase(
                session_factory=session_factory,
                label="publish_x_post_artifacts",
                fence=publication_fence,
                media_ids=tuple(
                    {media_id} if planned_existing_id is None else {media_id, planned_existing_id}
                ),
                mutate=publish_x_post,
            )
            result: dict[str, object] = {
                "processing_status": processing_status,
                "ingest_enqueued": False,
                "idempotency_outcome": "reused" if winner_id else "refreshed",
                "metadata_enrichment": True,
            }
            if winner_id is not None:
                result["superseded_by_media_id"] = str(winner_id)
            elif author is not None:
                attach_author_observation(
                    result,
                    media_id=media_id,
                    observation=_build_x_author_observation(author.name, author.id),
                    source="x_api_post",
                )
            return result
        except _XMediaLockSetChanged as exc:
            planned_existing_id = exc.media_id
    raise AssertionError("X post media lock set did not stabilize")


def _require_x_quote_source_identity(
    *,
    source_type: str,
    provider_target_ref: str | None,
    post_id: str,
) -> None:
    if source_type != source_types.X_POST or provider_target_ref != post_id:
        # justify-defect: embedded X quote acceptance must return the exact
        # canonical X-post source identity requested by this provider snapshot.
        raise AssertionError("accepted X quote source identity changed")


def _replace_x_post_snapshot_artifacts(
    db: Session,
    *,
    viewer_id: UUID,
    media: Media,
    snapshot: XSinglePostSnapshot,
    now: datetime,
) -> None:
    prepared_fragment = _build_x_fragment(
        media_id=media.id,
        idx=0,
        html=render_single_post_html(
            snapshot.post,
            users=snapshot.users,
            media=snapshot.media,
        ),
        base_url=snapshot.canonical_url,
        created_at=now,
    )
    delete_document_embed_artifacts(
        db,
        owner_user_id=media.created_by_user_id or viewer_id,
        media_id=media.id,
    )
    delete_web_article_artifacts(
        db,
        media_id=media.id,
        include_content_index=False,
    )
    media.title = post_title(snapshot.post, snapshot.users)[:255]
    media.canonical_url = snapshot.canonical_url
    media.canonical_source_url = snapshot.canonical_url
    media.provider = "x"
    media.provider_id = x_post_provider_id(snapshot.post.id)
    media.publisher = "X"
    media.description = post_description(snapshot.post)
    db.add(prepared_fragment.fragment)
    db.flush()
    insert_fragment_blocks(
        db,
        prepared_fragment.fragment.id,
        prepared_fragment.fragment_blocks,
    )
    replace_media_apparatus(
        db,
        media_id=media.id,
        media_kind="web_article",
        source_fingerprint_value=source_fingerprint(
            "x_post",
            snapshot.canonical_url,
            prepared_fragment.fragment.html_sanitized,
            prepared_fragment.fragment.canonical_text,
        ),
        items=attach_fragment_locators(
            media_id=media.id,
            fragment_id=prepared_fragment.fragment.id,
            media_kind="web_article",
            canonical_text=prepared_fragment.fragment.canonical_text,
            items=prepared_fragment.apparatus_items,
        ),
        edges=prepared_fragment.apparatus_edges,
    )
    bump_all_collection_families(
        db,
        families=(
            CollectionFamily.AuthorWorks,
            CollectionFamily.LibraryEntries,
        ),
    )


def _build_x_fragment(
    *,
    media_id: UUID | None,
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
            media_title=None,
            extract_embeds=bool(quote_occurrences),
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "X thread could not be sanitized"
        ) from exc
    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X post has no readable text")
    if len(quote_occurrences) > 1:
        # justify-defect: the X provider contract permits one direct quoted
        # post per containing post and therefore one marker per fragment.
        raise AssertionError("X fragment returned multiple quote occurrences")
    prepared_quote_occurrences: list[_PreparedXQuoteOccurrence] = []
    for occurrence in quote_occurrences:
        start = canonical_text.rfind(occurrence.placeholder_text)
        if start < 0:
            # justify-defect: the X renderer emitted this exact placeholder in
            # the sanitized fragment whose canonical text is bound here.
            raise AssertionError("X quote placeholder is missing from canonical text")
        end = start + len(occurrence.placeholder_text)
        prepared_quote_occurrences.append(
            _PreparedXQuoteOccurrence(
                rendered=occurrence,
                canonical_start_offset=start,
                canonical_end_offset=end,
            )
        )
    fragment = Fragment(
        media_id=media_id,
        idx=idx,
        html_sanitized=prepared.html_sanitized,
        canonical_text=canonical_text,
        created_at=created_at,
    )
    return _PreparedXFragment(
        fragment=fragment,
        fragment_blocks=prepared.fragment_blocks,
        apparatus_items=prepared.apparatus_items,
        apparatus_edges=prepared.apparatus_edges,
        quote_occurrences=tuple(prepared_quote_occurrences),
    )


def _document_embed_occurrence(
    *,
    prepared: _PreparedXQuoteOccurrence,
    fragment_id: UUID,
    target_media_ids: dict[str, UUID],
) -> DocumentEmbedArtifactOccurrence:
    rendered = prepared.rendered
    reference = rendered.reference
    if isinstance(reference, XResolvedQuoteReference):
        target_media_id = target_media_ids.get(rendered.post_id)
        if target_media_id is None:
            # justify-defect: every resolved quote is synchronously published
            # before the complete parent artifact is replaced.
            raise AssertionError("resolved X quote has no materialized media")
        target = DocumentEmbedTargetMaterialized(media_id=target_media_id)
    elif isinstance(reference, XUnavailableQuoteReference):
        target = DocumentEmbedTargetTerminal(
            status="failed",
            error_code=ApiErrorCode.E_X_POST_UNAVAILABLE.value,
            error_message="Quoted X post is unavailable.",
        )
    else:
        # justify-defect: X quote references are a closed owned union.
        raise AssertionError("unknown X quote reference variant")
    return DocumentEmbedArtifactOccurrence(
        fragment_id=fragment_id,
        ordinal=rendered.ordinal,
        occurrence_key=rendered.occurrence_key,
        provider="x",
        embed_kind="post",
        source_shape="provider_json",
        source_url=canonical_x_post_url(rendered.post_id),
        canonical_source_url=canonical_x_post_url(rendered.post_id),
        provider_target_ref=x_post_provider_id(rendered.post_id),
        title=None,
        authored_text=None,
        placeholder_text=rendered.placeholder_text,
        canonical_start_offset=prepared.canonical_start_offset,
        canonical_end_offset=prepared.canonical_end_offset,
        target=target,
    )


def _status_to_str(value: object) -> str:
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)


def _api_error_from_x_provider_error(error: XProviderError) -> ApiError:
    if error.code == XProviderErrorCode.CREDITS_DEPLETED:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_CREDITS_DEPLETED,
            "X imports are temporarily unavailable.",
        )
    elif error.code == XProviderErrorCode.AUTH_REJECTED:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_AUTH_REJECTED,
            "X imports are temporarily unavailable.",
        )
    elif error.code == XProviderErrorCode.RATE_LIMITED:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_RATE_LIMITED,
            "X is rate limiting imports.",
        )
    elif error.code == XProviderErrorCode.TIMEOUT:
        api_error = ApiError(ApiErrorCode.E_X_PROVIDER_TIMEOUT, "X import timed out.")
    elif error.code == XProviderErrorCode.POST_UNAVAILABLE:
        api_error = ApiError(ApiErrorCode.E_X_POST_UNAVAILABLE, "That X post is not available.")
    else:
        api_error = ApiError(
            ApiErrorCode.E_X_PROVIDER_UNAVAILABLE,
            "X imports are temporarily unavailable.",
        )
    api_error.retry_after_seconds = error.retry_after_seconds
    return api_error


def _record_x_provider_failure(
    db: Session,
    *,
    error: XProviderError,
    request_id: str | None,
    source_attempt_id: UUID | None = None,
    viewer_id: UUID,
    target_ref: str,
    duration_ms: int,
    capability: str = "author-thread",
) -> None:
    api_error = _api_error_from_x_provider_error(error)
    record_external_provider_event(
        db,
        request_id=request_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        provider="x",
        capability=capability,
        operation=error.operation,
        target_ref=target_ref,
        status="failure",
        api_error_code=api_error.code.value,
        provider_status_code=error.provider_status_code,
        provider_error_type=error.provider_error_type,
        provider_error_title=error.provider_error_title,
        duration_ms=duration_ms,
        retry_after_seconds=error.retry_after_seconds,
    )
    logger.warning(
        "x_provider_failure",
        request_id=request_id,
        user_id=str(viewer_id),
        operation=error.operation,
        provider_status_code=error.provider_status_code,
        provider_error_title=error.provider_error_title,
        api_error_code=api_error.code.value,
    )


def _record_x_provider_success(
    db: Session,
    *,
    request_id: str | None,
    source_attempt_id: UUID | None = None,
    viewer_id: UUID,
    media_id: UUID,
    target_ref: str,
    duration_ms: int,
    snapshot: XAuthorThreadSnapshot,
) -> None:
    record_external_provider_event(
        db,
        request_id=request_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        media_id=media_id,
        provider="x",
        capability="author-thread",
        operation="ingest_author_thread",
        target_ref=target_ref,
        status="success",
        duration_ms=duration_ms,
        metadata={
            "requested_post_id": snapshot.requested_post_id,
            "conversation_id": snapshot.conversation_id,
            "canonical_anchor_post_id": snapshot.canonical_anchor_post_id,
            "post_count": len(snapshot.posts),
            "quote_post_count": len(snapshot.quote_references),
        },
    )


def _record_x_post_provider_success(
    db: Session,
    *,
    request_id: str | None,
    source_attempt_id: UUID | None = None,
    viewer_id: UUID,
    media_id: UUID,
    target_ref: str,
    duration_ms: int,
    snapshot: XSinglePostSnapshot,
) -> None:
    record_external_provider_event(
        db,
        request_id=request_id,
        source_attempt_id=source_attempt_id,
        viewer_id=viewer_id,
        media_id=media_id,
        provider="x",
        capability="post",
        operation="ingest_x_post",
        target_ref=target_ref,
        status="success",
        duration_ms=duration_ms,
        metadata={
            "requested_post_id": snapshot.requested_post_id,
            "canonical_post_id": snapshot.post.id,
        },
    )


def _duration_ms(started_at: float) -> int:
    return max(0, int((perf_counter() - started_at) * 1000))
