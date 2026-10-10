"""X author threads and single posts, published as web-article media.

A thread is one fragment per post. Each resolved quote becomes its own x-post media,
published from the same snapshot (no second provider call) and linked as a
materialized embed. Re-adding supersedes onto the media holding the provider identity.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.presence import absent, present
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services import document_embeds as embeds
from nexus.services import library_entries
from nexus.services import x_rendering as render
from nexus.services.collection_revisions import CollectionFamily, bump_all_collection_families
from nexus.services.media_processing_state import mark_ready_for_reading
from nexus.services.media_source_ingest import (
    accept_embedded_source,
    complete_x_post_snapshot_attempt,
    lock_identity,
)
from nexus.services.reader_publication import ReplaceSourceIssues, replace_reader_publication
from nexus.services.source_outcome import (
    SourceContributorObservation,
    SourceRunOutcome,
    source_contributor_observations,
)
from nexus.services.source_publication import SourcePublicationFence, run_source_publication_phase
from nexus.services.web_article import prepare_article, replace_article_fragments
from nexus.services.web_article_structure import WebArticlePreparedFragment
from nexus.services.x_client import XMedia, XPost, XUser, fetch_author_thread, fetch_single_post
from nexus.services.x_identity import (
    canonical_x_post_url,
    x_author_thread_provider_id,
    x_post_provider_id,
)


@dataclass(frozen=True, slots=True)
class _Post:
    """One post, rendered and prepared outside any transaction."""

    post: XPost
    author: XUser | None
    title: str
    description: str
    html: str
    prepared: WebArticlePreparedFragment


@dataclass(frozen=True, slots=True)
class _Published:
    holder_id: UUID | None  # the media that already held the identity, when superseding
    status: str
    quote_media_ids: dict[str, UUID]
    reindex_media_ids: list[UUID]


def materialize_x_author_thread_media(
    session_factory: sessionmaker[Session],
    *,
    viewer_id: UUID,
    media_id: UUID,
    post_id: str,
    source_attempt_id: UUID,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> SourceRunOutcome:
    """Publish the author's thread and its quotes, or supersede onto the thread's media."""
    thread = fetch_author_thread(post_id)
    provider_id = x_author_thread_provider_id(thread.author.id, thread.conversation_id)
    posts = [
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
        for index, item in enumerate(render.render_thread(thread))
    ]
    quotes = {
        quote_id: _render_post(quoted, thread.users, thread.media)
        for quote_id, quoted in thread.quotes.items()
        if quoted is not None
    }

    def project(db: Session, media: Media, quote_media_ids: Mapping[str, UUID]) -> None:
        media.title = render.thread_title(thread)[:255]
        media.description = render.thread_description(thread)
        media.canonical_url = None
        media.canonical_source_url = canonical_x_post_url(thread.posts[0].id)
        media.provider, media.provider_id, media.publisher = "x", provider_id, "X"
        fragment_ids = replace_article_fragments(
            db, media_id=media.id, fragments=[(prepared, item.html) for item, prepared in posts]
        )
        embeds.replace_document_embed_artifact(
            db,
            owner_user_id=media.created_by_user_id or viewer_id,
            media_id=media.id,
            source_attempt_id=source_attempt_id,
            occurrences=[
                occurrence
                for fragment_id, (item, prepared) in zip(fragment_ids, posts, strict=True)
                for occurrence in _quote_occurrences(
                    fragment_id, prepared.canonical_text, item.quotes, quote_media_ids
                )
            ],
            extraction_failed=False,
            locked_existing_target_media_ids=frozenset(),
        )

    published = _publish(
        session_factory,
        viewer_id=viewer_id,
        media_id=media_id,
        fence=publication_fence,
        label="publish_x_thread_artifacts",
        provider_id=provider_id,
        quotes=quotes,
        project=project,
    )
    observations = source_contributor_observations(
        media_id=published.holder_id or media_id,
        observation=_author(thread.author),
        source="x_api_author_thread",
    )
    for quote_id, quote_media_id in published.quote_media_ids.items():
        if (author := quotes[quote_id].author) is not None:
            observations += source_contributor_observations(
                media_id=quote_media_id, observation=_author(author), source="x_api_quoted_post"
            )
    return _outcome(published, observations)


def materialize_x_post_media(
    session_factory: sessionmaker[Session],
    *,
    viewer_id: UUID,
    media_id: UUID,
    post_id: str,
    request_id: str | None,
    publication_fence: SourcePublicationFence,
) -> SourceRunOutcome:
    """Publish one post, or supersede onto the media that already holds it."""
    snapshot = fetch_single_post(post_id)
    post = _render_post(snapshot.post, snapshot.users, snapshot.media)
    published = _publish(
        session_factory,
        viewer_id=viewer_id,
        media_id=media_id,
        fence=publication_fence,
        label="publish_x_post_artifacts",
        provider_id=x_post_provider_id(post.post.id),
        quotes={},
        project=lambda db, media, _quotes: _project_post(db, media, viewer_id, post),
    )
    observations = (
        source_contributor_observations(
            media_id=media_id, observation=_author(post.author), source="x_api_post"
        )
        if published.holder_id is None and post.author is not None
        else ()
    )
    return _outcome(published, observations)


def _publish(
    session_factory: sessionmaker[Session],
    *,
    viewer_id: UUID,
    media_id: UUID,
    fence: SourcePublicationFence,
    label: str,
    provider_id: str,
    quotes: Mapping[str, _Post],
    project: Callable[[Session, Media, Mapping[str, UUID]], object],
) -> _Published:
    """One fenced phase: lock the identities, then supersede onto a holder or publish.

    A holder of ``provider_id`` and its embedded targets gain the viewer's libraries.
    Otherwise each quote is accepted as a child and published from the snapshot unless
    it already is, and ``project`` installs this media's own reader projection.
    """
    found: dict[str, UUID] = {}

    def discover(db: Session) -> list[UUID]:
        found.clear()
        for key, identity in [("", provider_id), *((q, x_post_provider_id(q)) for q in quotes)]:
            query = select(Media.id).where(Media.provider == "x", Media.provider_id == identity)
            if key == "":
                query = query.where(Media.id != media_id)
            if (holder := db.scalar(query.order_by(Media.id).limit(1))) is not None:
                found[key] = holder
        return list(found.values())

    def mutate(db: Session, _attempt: object) -> _Published:
        for identity in sorted({provider_id, *map(x_post_provider_id, quotes)}):
            lock_identity(db, identity)
        library_ids = library_entries.admin_non_default_library_ids_for_media(
            db, viewer_id=viewer_id, media_id=media_id
        )
        if (holder_id := found.get("")) is not None:
            targets = embeds.resolved_document_embed_target_media_ids(db, media_id=holder_id)
            for target_id in (holder_id, *targets):
                library_entries.assign_libraries_for_media_in_current_transaction(
                    db, viewer_id, target_id, library_ids
                )
            embeds.reconcile_document_embed_edges_for_viewer(
                db, viewer_id=viewer_id, media_id=holder_id
            )
            holder = db.get(Media, holder_id)
            if holder is None:
                raise ApiError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            return _Published(holder_id, holder.processing_status.value, {}, list(targets))
        quote_media_ids: dict[str, UUID] = {}
        for quote_id, quote in quotes.items():
            accepted = accept_embedded_source(
                db=db,
                viewer_id=viewer_id,
                url=canonical_x_post_url(quote_id),
                parent_media_id=media_id,
                document_embed_key=f"x-quote-post:{quote_id}",
                library_ids=library_ids,
            )
            quote_media_ids[quote_id] = accepted.media_id
            if (accepted.processing_status, accepted.source_attempt_status) == (
                "ready_for_reading",
                "succeeded",
            ):
                continue
            quote_media = _replace(
                db,
                accepted.media_id,
                lambda media, quote=quote: _project_post(db, media, viewer_id, quote),
            )
            mark_ready_for_reading(db, quote_media)
            complete_x_post_snapshot_attempt(
                db,
                media=quote_media,
                source_attempt_id=accepted.source_attempt_id,
                viewer_id=viewer_id,
                post_id=quote_id,
                canonical_url=canonical_x_post_url(quote_id),
            )
        _replace(db, media_id, lambda media: project(db, media, quote_media_ids))
        bump_all_collection_families(
            db, families=(CollectionFamily.AuthorWorks, CollectionFamily.LibraryEntries)
        )
        return _Published(
            None, "ready_for_reading", quote_media_ids, sorted(set(quote_media_ids.values()))
        )

    return run_source_publication_phase(
        session_factory=session_factory,
        label=label,
        fence=fence,
        media_ids=(media_id,),
        mutate=mutate,
        discover=discover,
    )


def _render_post(post: XPost, users: Mapping[str, XUser], media: Mapping[str, XMedia]) -> _Post:
    html = render.render_post(post, users, media)
    url = canonical_x_post_url(post.id)
    return _Post(
        post=post,
        author=users.get(post.author_id),
        title=render.post_title(post, users)[:255],
        description=render.post_description(post),
        html=html,
        prepared=prepare_article(html, base_url=url, document_url=url, extract_embeds=False),
    )


def _project_post(db: Session, media: Media, viewer_id: UUID, post: _Post) -> Media:
    owner = media.created_by_user_id or viewer_id
    embeds.delete_document_embed_artifacts(db, owner_user_id=owner, media_id=media.id)
    media.title, media.description = post.title, post.description
    media.canonical_url = media.canonical_source_url = canonical_x_post_url(post.post.id)
    media.provider, media.provider_id = "x", x_post_provider_id(post.post.id)
    media.publisher = "X"
    replace_article_fragments(db, media_id=media.id, fragments=[(post.prepared, post.html)])
    return media


def _replace[T](db: Session, media_id: UUID, project: Callable[[Media], T]) -> T:
    return replace_reader_publication(
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
    """Each quote's placeholder, found in order in the fragment's canonical text."""
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


def _author(user: XUser) -> taxonomy.ContributorObservationBatch:
    """The snapshot display name keyed on the numeric ``x_user`` id, never the handle."""
    claim = (taxonomy.RawIdentityClaim("x_user", user.id),)
    batch, _truncated = taxonomy.build_observation(
        {"author": [taxonomy.RawCreditEntry(credited_name=user.name, identity_claims=claim)]}
    )
    return batch


def _outcome(
    published: _Published, observations: tuple[SourceContributorObservation, ...]
) -> SourceRunOutcome:
    return SourceRunOutcome(
        diagnostics={
            "processing_status": published.status,
            "ingest_enqueued": False,
            "idempotency_outcome": "refreshed" if published.holder_id is None else "reused",
        },
        observations=observations,
        superseded_by_media_id=absent()
        if published.holder_id is None
        else present(published.holder_id),
        additional_reindex_media_ids=tuple(published.reindex_media_ids),
        metadata_enrichment=present(True),
    )
