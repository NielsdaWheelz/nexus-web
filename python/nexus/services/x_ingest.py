"""Detached X evidence and atomic canonical-post/thread publication.

Retry rule: revision aliases select posts; proved primary membership selects threads.
Reuse publishes the acquired delta, retains saved members and never downgrades a
proved revision. The coordinator locks aliases, then sources and every containing
media; bodies, cursors, generations and correctly owned attempts commit together.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    DocumentEmbed,
    Fragment,
    Media,
    MediaSourceAttempt,
    MediaTeardownIntent,
    XPostAlias,
    XPostSource,
    XThreadPost,
    XThreadSource,
)
from nexus.errors import ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.schemas.x_source import XAcquiredSource, XPriorSource, XSourceAuthor, XSourcePost
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services import document_embeds as embeds
from nexus.services import library_entries
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.consumption.reader_cursor import capture_x_cursor_remap, remap_x_cursors
from nexus.services.media_deletion import claim_document_teardown_if_unreferenced_locked
from nexus.services.media_processing_state import mark_ready_for_reading
from nexus.services.media_source_ingest import complete_x_post_capture_attempt
from nexus.services.reader_publication import (
    advance_reader_publications,
    ensure_reader_publication,
    read_publication_generation,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search import projection
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.web_article import prepare_article, replace_article_fragments
from nexus.services.web_article_structure import WebArticlePreparedFragment
from nexus.services.x_identity import (
    canonical_x_article_url,
    canonical_x_post_url,
    x_article_provider_id,
)
from nexus.services.x_rendering import render_post
from nexus.services.x_source import (
    post_from_row,
    post_label,
    reconcile_x_article_inspections,
    x_article_child_media_ids,
    x_article_link,
)


@dataclass(frozen=True, slots=True)
class PreparedXPost:
    source: XSourcePost
    html: str
    fragment: WebArticlePreparedFragment


@dataclass(frozen=True, slots=True)
class PreparedXSource:
    evidence: XAcquiredSource
    prior: XPriorSource
    posts: tuple[PreparedXPost, ...]
    baseline_attempt_ids: Mapping[UUID, UUID | None]


def prepare_x_source(
    *,
    acquired: XAcquiredSource,
    prior: XPriorSource,
    baseline_attempt_ids: Mapping[UUID, UUID | None],
) -> PreparedXSource:
    """Render detached canonical evidence without provider or database work."""
    posts = []
    for post in acquired.posts:
        html = render_post(post)
        url = canonical_x_post_url(post.source_revision_id)
        posts.append(
            PreparedXPost(
                post,
                html,
                prepare_article(html, base_url=url, document_url=url, extract_embeds=False),
            )
        )
    return PreparedXSource(acquired, prior, tuple(posts), baseline_attempt_ids)


def _revision_ids(post: XSourcePost) -> tuple[str, ...]:
    return post.edit_history_ids or (post.source_revision_id,)


def _capture_revision_ids(prepared: PreparedXSource) -> set[str]:
    revisions = {prepared.evidence.requested_revision_id, *prepared.evidence.primary_revision_ids}
    if prepared.evidence.root_revision_id is not None:
        revisions.add(prepared.evidence.root_revision_id)
    for post in prepared.posts:
        revisions.update(_revision_ids(post.source))
        revisions.update(ref.target_revision_id for ref in post.source.content.references)
    for prior in prepared.prior.posts:
        revisions.update(prior.revision_ids)
    revisions.update(item.checked_revision_id for item in prepared.evidence.unavailable)
    return revisions


def lock_x_publication_identities(db: Session, *, prepared: PreparedXSource) -> None:
    """The coordinator invokes this before discovering or locking any media."""
    for revision in sorted(prepared.evidence.article_ids):
        sa.lock_identity(db, f"x-article-carrier:{revision}")
    for revision in sorted(_capture_revision_ids(prepared)):
        sa.lock_identity(db, f"x-post:{revision}")


def containing_x_publication_media_ids(db: Session, *, media_ids: Sequence[UUID]) -> set[UUID]:
    """Canonical sources and their complete retained rendering-parent closure."""
    if not media_ids:
        return set()
    return set(
        db.scalars(
            text("""
        WITH RECURSIVE parents(id) AS (
            SELECT unnest(CAST(:ids AS uuid[]))
            UNION
            SELECT edge.parent_id FROM parents JOIN (
                SELECT thread_media_id AS parent_id, post_media_id AS child_id FROM x_thread_posts
                UNION
                SELECT media_id, target_media_id FROM document_embeds
                WHERE target_media_id IS NOT NULL AND canonical_end_offset IS NOT NULL
            ) edge ON edge.child_id = parents.id
        ) SELECT id FROM parents
    """),
            {"ids": list(media_ids)},
        )
    )


def x_publication_media_ids(
    db: Session, *, media_id: UUID, prepared: PreparedXSource
) -> list[UUID]:
    """Discover holders and old/new containment in the transaction's serializable view."""
    revisions = _capture_revision_ids(prepared)
    ids = {media_id, *(post.media_id for post in prepared.prior.posts)}
    ids.update(
        db.scalars(select(XPostAlias.post_media_id).where(XPostAlias.revision_id.in_(revisions)))
    )
    ids.update(
        db.scalars(
            select(DocumentEmbed.media_id).where(
                DocumentEmbed.provider == "x",
                DocumentEmbed.provider_target_ref.in_(revisions),
                DocumentEmbed.canonical_end_offset.is_not(None),
            )
        )
    )
    ids = containing_x_publication_media_ids(db, media_ids=tuple(ids))
    ids.update(
        db.scalars(select(XThreadPost.post_media_id).where(XThreadPost.thread_media_id.in_(ids)))
    )
    ids.update(
        target_id
        for target_id in db.scalars(
            select(DocumentEmbed.target_media_id).where(
                DocumentEmbed.media_id.in_(ids),
                DocumentEmbed.target_media_id.is_not(None),
            )
        )
        if target_id is not None
    )
    ids = containing_x_publication_media_ids(db, media_ids=tuple(ids))
    ids.update(x_article_child_media_ids(db, thread_media_ids=tuple(ids)))
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
    """Flush-only; the coordinator fences the driver and commits all effects."""
    del request_id
    evidence = prepared.evidence
    locked_ids = x_publication_media_ids(db, media_id=media_id, prepared=prepared)
    if (
        db.scalar(select(MediaTeardownIntent.id).where(MediaTeardownIntent.media_id == media_id))
        is not None
    ):
        raise ConflictError(
            ApiErrorCode.E_X_SOURCE_CONFLICT, "saved x content is being removed; retry the import."
        )
    aliases = dict(
        db.execute(select(XPostAlias.revision_id, XPostAlias.post_media_id)).tuples().all()
    )
    proved_aliases = dict(aliases)
    for post in prepared.posts:
        owners = {
            aliases[revision] for revision in _revision_ids(post.source) if revision in aliases
        }
        if len(owners) > 1:
            raise _identity_conflict()
        if owners:
            owner_id = next(iter(owners))
            proved_aliases.update((revision, owner_id) for revision in _revision_ids(post.source))
    primary_ids = {
        proved_aliases[revision]
        for revision in evidence.primary_revision_ids
        if revision in proved_aliases
    }
    root_id = proved_aliases.get(evidence.root_revision_id) if evidence.root_revision_id else None
    holders = set(
        db.scalars(
            select(XThreadPost.thread_media_id).where(XThreadPost.post_media_id.in_(primary_ids))
        )
    )
    if root_id is not None:
        holders.update(
            db.scalars(
                select(XThreadSource.media_id).where(XThreadSource.root_post_media_id == root_id)
            )
        )
    if evidence.scope == "author_thread" and len(holders) > 1:
        raise _identity_conflict()
    winner_id = (
        (next(iter(holders)) if holders else media_id)
        if evidence.scope == "author_thread"
        else aliases.get(evidence.requested_revision_id, media_id)
    )
    if winner_id != media_id and read_publication_generation(db, media_id=media_id) is not None:
        raise _identity_conflict()
    if evidence.scope == "author_thread":
        reconcile_x_article_inspections(
            db, loser_id=media_id, winner_id=winner_id, observations=evidence.article_ids
        )
    cursor_plan = capture_x_cursor_remap(db, media_ids=locked_ids)
    old_targets = {
        target_id
        for target_id in db.scalars(
            select(DocumentEmbed.target_media_id).where(
                DocumentEmbed.media_id.in_(locked_ids),
                DocumentEmbed.provider == "x",
                DocumentEmbed.target_media_id.in_(locked_ids),
            )
        )
        if target_id is not None
    }
    changed: set[UUID] = set()
    body_changed: set[UUID] = set()
    composition_changed = False
    observations = ()
    for post in prepared.posts:
        owners = {
            aliases[revision] for revision in _revision_ids(post.source) if revision in aliases
        }
        if len(owners) > 1:
            raise _identity_conflict()
        if owners:
            owner_id = next(iter(owners))
        elif evidence.scope == "post" and evidence.requested_revision_id in _revision_ids(
            post.source
        ):
            owner_id = media_id
        else:
            owner_id = _new_post_media(db, viewer_id=viewer_id, post=post.source).id
        media = db.get(Media, owner_id)
        assert media is not None
        row = db.scalar(select(XPostSource).where(XPostSource.media_id == owner_id))
        saved = post_from_row(row) if row is not None else None
        source = _winning_post(saved, post.source)
        for revision in _revision_ids(source):
            existing = aliases.get(revision)
            if existing is not None and existing != owner_id:
                raise _identity_conflict()
            if existing is None:
                db.add(XPostAlias(id=new_uuid7(), revision_id=revision, post_media_id=owner_id))
                aliases[revision] = owner_id
        if source == saved:
            continue
        attempt = _captured_attempt(
            db,
            media=media,
            driver_media_id=media_id,
            driver_attempt_id=source_attempt_id,
            viewer_id=viewer_id,
            revision_id=source.source_revision_id,
            source_type=st.X_POST,
            baseline_attempt_id=prepared.baseline_attempt_ids.get(owner_id),
        )
        fragment = db.scalar(select(Fragment).where(Fragment.media_id == owner_id))
        if saved is None or (
            source.source_revision_id == post.source.source_revision_id
            and source.content == post.source.content
            and (
                fragment is None
                or fragment.html_sanitized != post.fragment.html_sanitized
                or fragment.canonical_text != post.fragment.canonical_text
            )
        ):
            replace_article_fragments(db, media_id=owner_id, fragments=[(post.fragment, post.html)])
            body_changed.add(owner_id)
        if row is None:
            row = XPostSource(id=new_uuid7(), media_id=owner_id)
            db.add(row)
        row.source_attempt_id = attempt.id
        row.source_revision_id, row.logical_post_id = (
            source.source_revision_id,
            source.logical_post_id,
        )
        row.edit_history_ids = (
            list(source.edit_history_ids) if source.edit_history_ids is not None else None
        )
        row.payload = source.content.model_dump(mode="json")
        row.availability, row.body_captured_at, row.checked_at = (
            source.availability,
            source.body_captured_at,
            source.checked_at,
        )
        if owner_id in body_changed:
            media.title = post_label(source)
        media.description = source.content.text[:2000]
        media.canonical_url = media.canonical_source_url = canonical_x_post_url(
            source.source_revision_id
        )
        media.provider, media.provider_id, media.publisher = "x", None, "X"
        mark_ready_for_reading(db, media)
        changed.add(owner_id)
        observations += source_contributor_observations(
            media_id=owner_id, observation=_author(source.content.author), source="x_api_post"
        )
    db.flush()
    for observation in evidence.unavailable:
        owner_id = aliases.get(observation.checked_revision_id)
        if owner_id is None:
            continue
        row = db.scalar(select(XPostSource).where(XPostSource.media_id == owner_id))
        if (
            row is None
            or row.source_revision_id != observation.checked_revision_id
            or (row.checked_at is not None and row.checked_at >= observation.checked_at)
        ):
            continue
        media = db.get(Media, owner_id)
        assert media is not None
        attempt = _captured_attempt(
            db,
            media=media,
            driver_media_id=media_id,
            driver_attempt_id=source_attempt_id,
            viewer_id=viewer_id,
            revision_id=row.source_revision_id,
            source_type=st.X_POST,
            baseline_attempt_id=prepared.baseline_attempt_ids.get(owner_id),
        )
        row.source_attempt_id, row.availability, row.checked_at = (
            attempt.id,
            "unavailable",
            observation.checked_at,
        )
        changed.add(owner_id)
    db.flush()
    unavailable = {item.checked_revision_id for item in evidence.unavailable}
    changed.update(
        embeds.resolve_x_document_embed_aliases(
            db,
            aliases={
                revision: aliases[revision]
                for revision in _capture_revision_ids(prepared)
                if revision in aliases
            },
            unavailable_revision_ids=unavailable,
        )
    )
    if evidence.requested_revision_id not in aliases:
        raise ConflictError(
            ApiErrorCode.E_X_SOURCE_CONFLICT,
            "the requested post has no saved source; retry the import.",
        )
    if evidence.scope == "post":
        winner_id = aliases[evidence.requested_revision_id]
        library_entries.lock_media_for_reference(db, winner_id)
    else:
        primary_ids.update(aliases[revision] for revision in evidence.primary_revision_ids)
        primary_ids.add(aliases[evidence.requested_revision_id])
        composition_changed = _publish_thread(
            db,
            media_id=winner_id,
            driver_media_id=media_id,
            driver_attempt_id=source_attempt_id,
            viewer_id=viewer_id,
            prepared=prepared,
            primary_ids=primary_ids,
            aliases=aliases,
            body_changed=body_changed,
        )
        changed.add(winner_id)
        observations += source_contributor_observations(
            media_id=winner_id, observation=_author(evidence.author), source="x_api_author_thread"
        )
    db.flush()
    changed.update(
        aliases[revision]
        for revision in evidence.article_ids
        if revision in aliases and revision in evidence.primary_revision_ids
    )
    for owner_id in sorted(changed):
        row = db.scalar(select(XPostSource).where(XPostSource.media_id == owner_id))
        if row is None:
            continue
        replace_x_post_references(
            db,
            row=row,
            article=x_article_link(db, post=row),
            aliases=aliases,
            unavailable=unavailable,
            viewer_id=viewer_id,
            locked_ids=frozenset(locked_ids),
        )
    db.flush()
    for target_id in sorted(old_targets):
        claim_document_teardown_if_unreferenced_locked(db, target_id)
    affected = containing_x_publication_media_ids(db, media_ids=tuple(changed))
    driver_attempt = db.get(MediaSourceAttempt, source_attempt_id)
    assert driver_attempt is not None
    # Cursor reconciliation reads the staged source projection. Its own attempt's
    # publication time exists now; the runner settles status/history before commit.
    driver_attempt.finished_at = db.scalar(text("SELECT now()"))
    db.flush()
    # New canonical bodies must be present in the assembled replacement used for
    # cursor correspondence. Their first generation is already the new one.
    created_publications = {
        identity
        for identity in sorted(affected)
        if ensure_reader_publication(db, media_id=identity)
    }
    remap_x_cursors(db, snapshots=cursor_plan)
    advance_reader_publications(db, media_ids=sorted(affected - created_publications))
    db.flush()
    projected_media = sorted(changed | affected | {winner_id})
    projection.refresh(db, "media", projected_media)
    projection.refresh_subject_dossiers(
        db, [ResourceRef("media", identity) for identity in projected_media]
    )
    return SourceRunOutcome(
        diagnostics={
            "processing_status": "ready_for_reading",
            "ingest_enqueued": False,
            "idempotency_outcome": "refreshed",
        },
        observations=observations,
        superseded_by_media_id=winner_id if winner_id != media_id else None,
        reindex_media=winner_id in body_changed,
        additional_reindex_media_ids=tuple(sorted(body_changed - {winner_id})),
        metadata_enrichment=(
            composition_changed or bool(primary_ids & body_changed)
            if evidence.scope == "author_thread"
            else winner_id in body_changed
        ),
    )


def _identity_conflict() -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_X_IDENTITY_CONFLICT,
        "these saved threads overlap. both were kept; repair is required.",
    )


def _winning_post(saved: XSourcePost | None, captured: XSourcePost) -> XSourcePost:
    if saved is None:
        return captured
    previous, observed = saved.content, captured.content
    if saved.source_revision_id == captured.source_revision_id and (
        previous.author.id != observed.author.id
        or previous.text != observed.text
        or {(ref.kind, ref.target_revision_id) for ref in previous.references}
        != {(ref.kind, ref.target_revision_id) for ref in observed.references}
        or {item.media_key for item in previous.attachments}
        != {item.media_key for item in observed.attachments}
    ):
        raise ConflictError(
            ApiErrorCode.E_X_SOURCE_CONFLICT,
            "x returned conflicting content for a saved post revision; saved copy kept.",
        )
    if saved.content.author.id != captured.content.author.id:
        raise _identity_conflict()
    history = captured.edit_history_ids or saved.edit_history_ids
    if saved.edit_history_ids is not None and captured.edit_history_ids is not None:
        short, long = sorted((saved.edit_history_ids, captured.edit_history_ids), key=len)
        if tuple(long[: len(short)]) != tuple(short):
            raise _identity_conflict()
        history = long
    if history is None:
        if captured.source_revision_id != saved.source_revision_id:
            raise _identity_conflict()
        newer = True
    else:
        if saved.source_revision_id not in history or captured.source_revision_id not in history:
            raise _identity_conflict()
        newer = history.index(captured.source_revision_id) >= history.index(
            saved.source_revision_id
        )
    if (
        captured.source_revision_id == saved.source_revision_id
        and saved.checked_at is not None
        and (captured.checked_at is None or captured.checked_at <= saved.checked_at)
    ):
        newer = False
    return (captured if newer else saved).model_copy(
        update={"logical_post_id": history[0] if history else None, "edit_history_ids": history}
    )


def _new_post_media(db: Session, *, viewer_id: UUID, post: XSourcePost) -> Media:
    media = Media(
        id=new_uuid7(),
        kind="web_article",
        title=post_label(post),
        provider="x",
        created_by_user_id=viewer_id,
        requested_url=canonical_x_post_url(post.source_revision_id),
    )
    db.add(media)
    db.flush()
    return media


def _captured_attempt(
    db: Session,
    *,
    media: Media,
    driver_media_id: UUID,
    driver_attempt_id: UUID,
    viewer_id: UUID,
    revision_id: str,
    source_type: str,
    baseline_attempt_id: UUID | None,
) -> MediaSourceAttempt:
    """Settled captures commute by proved revision order and observation time.

    A competing running attempt is never adopted. An unstarted post attempt can
    consume this capture only when it is the exact detached baseline attempt.
    """
    library_entries.lock_media_for_reference(db, media.id)
    if media.id == driver_media_id:
        attempt = db.get(MediaSourceAttempt, driver_attempt_id)
        assert attempt is not None and attempt.media_id == media.id
        return attempt
    latest = sa.latest_attempt(db, media.id, lock=True)
    url = canonical_x_post_url(revision_id)
    if latest is not None and latest.status in st.IN_FLIGHT:
        if baseline_attempt_id != latest.id or latest.status == st.RUNNING:
            raise ConflictError(
                ApiErrorCode.E_X_SOURCE_CONFLICT,
                "another x capture is in progress; retry this import.",
            )
        if source_type != st.X_POST:
            raise ConflictError(
                ApiErrorCode.E_X_SOURCE_CONFLICT,
                "another thread capture is in progress; retry this import.",
            )
        return complete_x_post_capture_attempt(
            db,
            media=media,
            source_attempt_id=latest.id,
            parent_source_attempt_id=driver_attempt_id,
        )
    return sa.create_attempt(
        db,
        id=sa.successor_id(latest.id) if latest else new_uuid7(),
        media=media,
        actor_id=viewer_id,
        source_type=source_type,
        requested_url=url,
        canonical_source_url=url,
        provider="x",
        provider_target_ref=revision_id,
        payload={"parent_source_attempt_id": str(driver_attempt_id)},
        status="succeeded",
    )


def replace_x_post_references(
    db: Session,
    *,
    row: XPostSource,
    article: tuple[str, UUID | None] | None,
    aliases: Mapping[str, UUID],
    unavailable: set[str],
    viewer_id: UUID,
    locked_ids: frozenset[UUID],
) -> None:
    """Project one canonical post's direct references after its body/aliases exist.

    Flush-only. The live publisher owns ordered locks; the stopped-writer cutover
    uses this same projection for converted source evidence.
    """
    post = post_from_row(row)
    fragment = db.scalar(select(Fragment).where(Fragment.media_id == row.media_id))
    assert fragment is not None
    occurrences = []
    prior_unavailable = set(
        db.scalars(
            select(DocumentEmbed.provider_target_ref).where(
                DocumentEmbed.media_id == row.media_id,
                DocumentEmbed.error_code == ApiErrorCode.E_X_POST_UNAVAILABLE.value,
            )
        )
    )
    for ordinal, reference in enumerate(post.content.references):
        target_id = aliases.get(reference.target_revision_id)
        target_source = (
            db.scalar(select(XPostSource).where(XPostSource.media_id == target_id))
            if target_id is not None
            else None
        )
        url = canonical_x_post_url(reference.target_revision_id)
        occurrences.append(
            embeds.DocumentEmbedArtifactOccurrence(
                fragment_id=fragment.id,
                ordinal=ordinal,
                occurrence_key=f"x:{row.media_id}:{reference.kind}:{target_id or reference.target_revision_id}",
                provider="x",
                embed_kind="post",
                source_shape="provider_json",
                source_url=url,
                canonical_source_url=url,
                provider_target_ref=reference.target_revision_id,
                title=None,
                authored_text=None,
                placeholder_text="",
                canonical_start_offset=len(fragment.canonical_text),
                canonical_end_offset=len(fragment.canonical_text),
                target=embeds.DocumentEmbedTargetMaterialized(media_id=target_id)
                if target_id is not None and target_source is not None
                else embeds.DocumentEmbedTargetTerminal(
                    status="failed",
                    error_code=ApiErrorCode.E_X_POST_UNAVAILABLE.value
                    if reference.target_revision_id in unavailable | prior_unavailable
                    else None,
                    error_message="post unavailable on x"
                    if reference.target_revision_id in unavailable | prior_unavailable
                    else "post not captured",
                ),
            )
        )
    if article is not None:
        article_id, target_id = article
        url = canonical_x_article_url(article_id)
        occurrences.append(
            embeds.DocumentEmbedArtifactOccurrence(
                fragment_id=fragment.id,
                ordinal=len(occurrences),
                occurrence_key=f"x-article:{row.media_id}:{row.source_revision_id}:{article_id}",
                provider="x",
                embed_kind="link_preview",
                source_shape="provider_json",
                source_url=url,
                canonical_source_url=url,
                provider_target_ref=x_article_provider_id(article_id),
                title=None,
                authored_text=None,
                placeholder_text="x article",
                canonical_start_offset=len(fragment.canonical_text),
                canonical_end_offset=None,
                target=embeds.DocumentEmbedTargetMaterialized(media_id=target_id)
                if target_id is not None
                else embeds.DocumentEmbedTargetTerminal(
                    status="failed", error_code=None, error_message="article not saved"
                ),
            )
        )
    embeds.replace_document_embed_artifact(
        db,
        owner_user_id=viewer_id,
        media_id=row.media_id,
        source_attempt_id=row.source_attempt_id,
        occurrences=occurrences,
        extraction_failed=False,
        locked_existing_target_media_ids=locked_ids,
    )


def _publish_thread(
    db: Session,
    *,
    media_id: UUID,
    driver_media_id: UUID,
    driver_attempt_id: UUID,
    viewer_id: UUID,
    prepared: PreparedXSource,
    primary_ids: set[UUID],
    aliases: Mapping[str, UUID],
    body_changed: set[UUID],
) -> bool:
    evidence = prepared.evidence
    media = db.get(Media, media_id)
    assert media is not None
    source = db.scalar(select(XThreadSource).where(XThreadSource.media_id == media_id))
    if source is not None and source.author_id != evidence.author.id:
        raise _identity_conflict()
    previous_order = list(
        db.scalars(
            select(XThreadPost.post_media_id)
            .where(XThreadPost.thread_media_id == media_id)
            .order_by(XThreadPost.ordinal)
        )
    )
    primary_ids.update(previous_order)
    rows = {
        row.media_id: row
        for row in db.scalars(select(XPostSource).where(XPostSource.media_id.in_(primary_ids)))
    }
    if rows.keys() != primary_ids or any(
        post_from_row(row).content.author.id != evidence.author.id for row in rows.values()
    ):
        raise _identity_conflict()
    order = _ordered_primary_posts(rows, aliases, retained_ids=previous_order)
    composition_changed = previous_order != order
    for post_id in sorted(primary_ids):
        library_entries.lock_media_for_reference(db, post_id)
    attempt = _captured_attempt(
        db,
        media=media,
        driver_media_id=driver_media_id,
        driver_attempt_id=driver_attempt_id,
        viewer_id=viewer_id,
        revision_id=evidence.requested_revision_id,
        source_type=st.X_AUTHOR_THREAD,
        baseline_attempt_id=prepared.baseline_attempt_ids.get(media_id),
    )
    checked = {
        aliases[post.source_revision_id]
        for post in evidence.posts
        if post.source_revision_id in aliases
        and aliases[post.source_revision_id] in rows
        and rows[aliases[post.source_revision_id]].source_revision_id == post.source_revision_id
    }
    checked.update(
        aliases[item.checked_revision_id]
        for item in evidence.unavailable
        if item.checked_revision_id in aliases
        and aliases[item.checked_revision_id] in rows
        and rows[aliases[item.checked_revision_id]].source_revision_id == item.checked_revision_id
    )
    coverage = evidence.coverage.model_copy(
        update={"unchecked_primary_post_media_ids": tuple(sorted(primary_ids - checked))}
    )
    now = db.scalar(text("SELECT now()"))
    assert isinstance(now, datetime)
    if source is None:
        source = XThreadSource(id=new_uuid7(), media_id=media_id)
        db.add(source)
    source.source_attempt_id, source.author_id, source.published_at = (
        attempt.id,
        evidence.author.id,
        now,
    )
    if evidence.coverage.search_exhausted is not None:
        source.membership_checked_at = now
    if evidence.root_revision_id is not None:
        source.root_post_media_id = aliases[evidence.root_revision_id]
    source.coverage = coverage.model_dump(mode="json")
    if composition_changed:
        db.execute(delete(XThreadPost).where(XThreadPost.thread_media_id == media_id))
        db.flush()
        db.add_all(
            XThreadPost(
                id=new_uuid7(), thread_media_id=media_id, post_media_id=post_id, ordinal=index
            )
            for index, post_id in enumerate(order)
        )
    if composition_changed or primary_ids & body_changed:
        media.title = post_label(post_from_row(rows[order[0]]))
    media.description = "\n\n".join(post_from_row(rows[post_id]).content.text for post_id in order)[
        :2000
    ]
    media.provider, media.provider_id, media.publisher, media.canonical_url = "x", None, "X", None
    media.canonical_source_url = canonical_x_post_url(rows[order[0]].source_revision_id)
    mark_ready_for_reading(db, media)
    return composition_changed


def _ordered_primary_posts(
    rows: Mapping[UUID, XPostSource], aliases: Mapping[str, UUID], *, retained_ids: Sequence[UUID]
) -> list[UUID]:
    neighbors = {identity: set() for identity in rows}
    for identity, row in rows.items():
        for ref in post_from_row(row).content.references:
            parent = aliases.get(ref.target_revision_id)
            if ref.kind == "replied_to" and parent is not None and parent in rows:
                neighbors[identity].add(parent)
                neighbors[parent].add(identity)
    reached: set[UUID] = set()
    # Saved membership remains evidence even when an intermediate reply is no
    # longer available. Only newly admitted members need a current connecting path.
    pending = list(retained_ids) or [next(iter(rows))]
    while pending:
        identity = pending.pop()
        if identity not in reached:
            reached.add(identity)
            pending.extend(neighbors[identity] - reached)
    if reached != rows.keys():
        raise _identity_conflict()
    remaining = set(rows)
    order: list[UUID] = []
    while remaining:
        eligible = [
            identity
            for identity in remaining
            if not any(
                ref.kind == "replied_to" and aliases.get(ref.target_revision_id) in remaining
                for ref in post_from_row(rows[identity]).content.references
            )
        ]
        if not eligible:
            raise _identity_conflict()
        identity = min(
            eligible,
            key=lambda item: int(rows[item].logical_post_id or rows[item].source_revision_id),
        )
        order.append(identity)
        remaining.remove(identity)
    return order


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
