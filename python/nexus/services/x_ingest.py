"""Immutable exact-revision capture publication and optional media composition.

Provider work is detached. The caller owns the serializable transaction and the
ordered revision/media locks. Captures own fragments; media only select captures.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import parse_qs, urlparse
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    Fragment,
    Media,
    MediaSourceAttempt,
    XPostAlias,
    XPostCapture,
    XPostCaptureContext,
    XPostMedia,
    XPostSource,
    XThreadPost,
    XThreadSource,
)
from nexus.errors import ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.jobs.queue import enqueue_job
from nexus.schemas.x_source import (
    XAcquiredSource,
    XArticleExcerptCapture,
    XCompletePostCapture,
    XPriorSource,
    XSourceCoverage,
    XSourcePost,
)
from nexus.services import contributor_taxonomy as taxonomy
from nexus.services import source_attempts as sa
from nexus.services.fragment_blocks import insert_fragment_blocks
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.services.media_processing_state import mark_ready_for_reading
from nexus.services.reader_publication import advance_reader_publications, ensure_reader_publication
from nexus.services.search import projection
from nexus.services.source_outcome import SourceRunOutcome, source_contributor_observations
from nexus.services.web_article import prepare_article
from nexus.services.web_article_structure import WebArticlePreparedFragment
from nexus.services.x_identity import canonical_x_post_url
from nexus.services.x_rendering import capture_image_urls, normalized_capture_html, render_post
from nexus.services.x_source import (
    admit_x_captures_for_accounts,
    post_label,
    readable_x_capture_ids_sql,
    reconcile_x_article_inspections,
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


@dataclass(frozen=True, slots=True)
class CaptureContext:
    relation: Literal["quoted", "replied_to", "retweeted"]
    referenced_revision_id: str
    target_capture_id: UUID | None
    outcome: Literal["captured", "unavailable", "not_captured"]
    error_code: str | None


def prepare_x_source(
    *,
    acquired: XAcquiredSource,
    prior: XPriorSource,
) -> PreparedXSource:
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
    return PreparedXSource(acquired, prior, tuple(posts))


def _revision_ids(post: XSourcePost) -> tuple[str, ...]:
    return post.edit_history_ids or (post.source_revision_id,)


def lock_x_publication_identities(db: Session, *, prepared: PreparedXSource) -> None:
    for revision in sorted(prepared.evidence.article_ids):
        sa.lock_identity(db, f"x-article-carrier:{revision}")
    revisions = {prepared.evidence.requested_revision_id, *prepared.evidence.primary_revision_ids}
    for post in prepared.posts:
        revisions.update(_revision_ids(post.source))
        revisions.update(ref.target_revision_id for ref in post.source.content.references)
    for prior in prepared.prior.posts:
        revisions.update(prior.revision_ids)
    lock_x_capture_revisions(db, revisions=revisions)


def lock_x_capture_revisions(db: Session, *, revisions: set[str]) -> None:
    source_ids = set(
        db.scalars(select(XPostAlias.post_id).where(XPostAlias.revision_id.in_(revisions)))
    )
    revisions = revisions | set(
        db.scalars(select(XPostAlias.revision_id).where(XPostAlias.post_id.in_(source_ids)))
    )
    for revision in sorted(revisions):
        sa.lock_identity(db, f"x-post:{revision}")
    for post_id in sorted(source_ids):
        sa.lock_identity(db, f"x-post-source:{post_id}")
    # A changed alias/source row after advisory admission restarts SERIALIZABLE
    # callers before they take any media locks or write a stale foreign key.
    list(
        db.scalars(
            select(XPostAlias.id)
            .where(XPostAlias.post_id.in_(source_ids))
            .order_by(XPostAlias.revision_id)
            .with_for_update()
        )
    )
    list(
        db.scalars(
            select(XPostSource.id)
            .where(XPostSource.id.in_(source_ids))
            .order_by(XPostSource.id)
            .with_for_update()
        )
    )


def containing_x_publication_media_ids(db: Session, *, media_ids: Sequence[UUID]) -> set[UUID]:
    # Captures are immutable: refreshing one publication cannot repin a parent.
    return set(media_ids)


def x_publication_media_ids(
    db: Session, *, media_id: UUID, prepared: PreparedXSource
) -> list[UUID]:
    revisions = {revision for item in prepared.posts for revision in _revision_ids(item.source)}
    post_ids = select(XPostAlias.post_id).where(XPostAlias.revision_id.in_(revisions))
    ids = {media_id}
    ids.update(db.scalars(select(XPostMedia.media_id).where(XPostMedia.post_id.in_(post_ids))))
    ids.update(
        db.scalars(
            select(XThreadPost.thread_media_id)
            .join(XPostCapture, XPostCapture.id == XThreadPost.capture_id)
            .where(XPostCapture.post_id.in_(post_ids))
        )
    )
    return sorted(ids)


def _identity_conflict() -> ConflictError:
    return ConflictError(
        ApiErrorCode.E_X_IDENTITY_CONFLICT,
        "saved x identities conflict; explicit repair is required.",
    )


def _post_identity(db: Session, *, revision_id: str, post: XSourcePost | None) -> XPostSource:
    revisions = _revision_ids(post) if post is not None else (revision_id,)
    aliases = list(db.scalars(select(XPostAlias).where(XPostAlias.revision_id.in_(revisions))))
    owner_ids = {alias.post_id for alias in aliases}
    aliases = list(db.scalars(select(XPostAlias).where(XPostAlias.post_id.in_(owner_ids))))
    sources = list(
        db.scalars(
            select(XPostSource)
            .where(XPostSource.id.in_(owner_ids))
            .order_by(XPostSource.id)
            .with_for_update()
        )
    )
    authors = set(
        db.scalars(
            select(XPostCapture.payload["content"]["author"]["id"].astext).where(
                XPostCapture.post_id.in_(owner_ids),
                XPostCapture.payload["kind"].astext == "complete_post",
            )
        )
    )
    if post is not None:
        authors.add(post.content.author.id)
    if len(authors) > 1:
        raise _identity_conflict()
    if (
        len(sources) > 1
        and db.execute(
            select(XThreadPost.thread_media_id)
            .join(XPostCapture, XPostCapture.id == XThreadPost.capture_id)
            .where(XPostCapture.post_id.in_(owner_ids))
            .group_by(XThreadPost.thread_media_id)
            .having(func.count() > 1)
            .limit(1)
        ).first()
        is not None
    ):
        raise _identity_conflict()
    histories = [tuple(row.edit_history_ids) for row in sources if row.edit_history_ids is not None]
    if post is not None and post.edit_history_ids is not None:
        histories.append(post.edit_history_ids)
    history = max(histories, key=len) if histories else None
    if history is not None and any(history[: len(value)] != value for value in histories):
        raise _identity_conflict()
    if history is not None and any(alias.revision_id not in history for alias in aliases):
        raise _identity_conflict()
    bindings = list(db.scalars(select(XPostMedia).where(XPostMedia.post_id.in_(owner_ids))))
    if len(bindings) > 1:
        raise _identity_conflict()
    if sources:
        source = sources[0]
        # Only provider-proved lineage authorizes reconciliation of unresolved rows.
        if len(sources) > 1 and (history is None or not set(revisions) >= set(history)):
            raise _identity_conflict()
        for loser in sources[1:]:
            db.execute(
                update(XPostAlias).where(XPostAlias.post_id == loser.id).values(post_id=source.id)
            )
            db.execute(
                update(XPostCapture)
                .where(XPostCapture.post_id == loser.id)
                .values(post_id=source.id)
            )
            db.execute(
                update(XPostMedia).where(XPostMedia.post_id == loser.id).values(post_id=source.id)
            )
            affected_thread_ids = (
                select(XThreadPost.thread_media_id)
                .join(XPostCapture, XPostCapture.id == XThreadPost.capture_id)
                .where(XPostCapture.post_id == source.id)
            )
            for thread in db.scalars(
                select(XThreadSource).where(XThreadSource.media_id.in_(affected_thread_ids))
            ):
                coverage = XSourceCoverage.model_validate_json(json.dumps(thread.coverage))
                thread.coverage = coverage.model_copy(
                    update={
                        "unchecked_primary_post_ids": tuple(
                            dict.fromkeys(
                                source.id if value == loser.id else value
                                for value in coverage.unchecked_primary_post_ids
                            )
                        )
                    }
                ).model_dump(mode="json")
            db.flush()
            db.delete(loser)
    else:
        source = XPostSource(id=new_uuid7(), logical_post_id=None, edit_history_ids=None)
        db.add(source)
        db.flush()
    if history is not None:
        source.logical_post_id, source.edit_history_ids = history[0], list(history)
    existing = {alias.revision_id for alias in aliases}
    for revision in revisions:
        if revision not in existing:
            db.add(
                XPostAlias(
                    id=new_uuid7(),
                    revision_id=revision,
                    post_id=source.id,
                    availability=None,
                    checked_at=None,
                )
            )
    db.flush()
    if post is not None:
        alias = db.scalar(select(XPostAlias).where(XPostAlias.revision_id == revision_id))
        assert alias is not None
        if alias.checked_at is None or (
            post.checked_at is not None and post.checked_at > alias.checked_at
        ):
            alias.availability, alias.checked_at = post.availability, post.checked_at
    return source


def capture_manifest(db: Session, *, capture_ids: Sequence[UUID]) -> set[UUID]:
    """Roots and exactly their pinned direct context; never recursively expanded."""
    return {
        *capture_ids,
        *(
            identity
            for identity in db.scalars(
                select(XPostCaptureContext.target_capture_id).where(
                    XPostCaptureContext.capture_id.in_(capture_ids),
                    XPostCaptureContext.target_capture_id.is_not(None),
                )
            )
            if identity is not None
        ),
    }


def _publish_capture(
    db: Session,
    *,
    source: XPostSource,
    revision_id: str,
    payload: XCompletePostCapture | XArticleExcerptCapture,
    fragment: WebArticlePreparedFragment,
    captured_at: datetime,
    contexts: Sequence[CaptureContext],
) -> XPostCapture:
    if isinstance(payload, XCompletePostCapture):
        declared = [(ref.kind, ref.target_revision_id) for ref in payload.content.references]
        if declared != [(item.relation, item.referenced_revision_id) for item in contexts]:
            raise ValueError("capture contexts must exactly cover declared references in order")
    elif contexts:
        raise ValueError("article excerpts have no inferred context")
    for item in contexts:
        if (item.outcome == "captured") != (item.target_capture_id is not None):
            raise ValueError("only captured context has a target")
        if item.target_capture_id is not None:
            target = db.get(XPostCapture, item.target_capture_id)
            if (
                target is None
                or target.source_revision_id != item.referenced_revision_id
                or target.payload["kind"] != "complete_post"
            ):
                raise ValueError("context must pin the complete exact referenced revision")
    data = payload.model_dump(mode="json")
    desired = [
        (
            item.relation,
            item.referenced_revision_id,
            item.target_capture_id,
            item.outcome,
            item.error_code,
        )
        for item in contexts
    ]
    expected_html = normalized_capture_html(
        fragment.html_sanitized, payload=data, revision_id=revision_id, capture_id=None
    )
    for saved in db.scalars(
        select(XPostCapture)
        .where(XPostCapture.post_id == source.id, XPostCapture.source_revision_id == revision_id)
        .order_by(XPostCapture.id)
    ):
        if saved.payload != data:
            continue
        saved_context = [
            (
                item.relation,
                item.referenced_revision_id,
                item.target_capture_id,
                item.outcome,
                item.error_code,
            )
            for item in db.scalars(
                select(XPostCaptureContext)
                .where(XPostCaptureContext.capture_id == saved.id)
                .order_by(XPostCaptureContext.ordinal)
            )
        ]
        saved_fragment = db.scalar(select(Fragment).where(Fragment.x_post_capture_id == saved.id))
        if (
            saved_context == desired
            and saved_fragment is not None
            and saved_fragment.canonical_text == fragment.canonical_text
            and normalized_capture_html(
                saved_fragment.html_sanitized,
                payload=data,
                revision_id=revision_id,
                capture_id=saved.id,
            )
            == expected_html
        ):
            return saved
    capture = XPostCapture(
        id=new_uuid7(),
        post_id=source.id,
        source_revision_id=revision_id,
        payload=data,
        captured_at=captured_at,
        asset_job_id=None,
    )
    db.add(capture)
    db.flush()
    images = capture_image_urls(capture.payload)
    urls = {url: f"/api/x/captures/{capture.id}/assets/{key}" for key, url in images.items()}
    document = parse_html_document(fragment.html_sanitized)
    for image in document.iter("img"):
        src = image.get("src") or ""
        upstream = parse_qs(urlparse(src).query).get("url")
        if upstream:
            image.set("src", upstream[0])
    url = canonical_x_post_url(revision_id)
    fragment = prepare_article(
        serialize_html(document),
        base_url=url,
        document_url=url,
        extract_embeds=False,
        capture_assets=urls,
    )
    row = Fragment(
        id=new_uuid7(),
        media_id=None,
        x_post_capture_id=capture.id,
        idx=0,
        html_sanitized=fragment.html_sanitized,
        canonical_text=fragment.canonical_text,
    )
    db.add(row)
    db.flush()
    insert_fragment_blocks(db, row.id, fragment.fragment_blocks)
    db.add_all(
        XPostCaptureContext(
            id=new_uuid7(),
            capture_id=capture.id,
            ordinal=ordinal,
            relation=item.relation,
            referenced_revision_id=item.referenced_revision_id,
            target_capture_id=item.target_capture_id,
            outcome=item.outcome,
            error_code=item.error_code,
        )
        for ordinal, item in enumerate(contexts)
    )
    if (
        isinstance(payload, XCompletePostCapture)
        and any(item.url or item.preview_image_url for item in payload.content.attachments)
    ) or (isinstance(payload, XArticleExcerptCapture) and payload.images):
        capture.asset_job_id = enqueue_job(
            db, kind="archive_x_capture_assets", payload={"capture_id": str(capture.id)}
        ).id
    enqueue_job(db, kind="x_capture_content_reindex", payload={"capture_id": str(capture.id)})
    db.flush()
    projection.refresh(db, "fragment", [row.id])
    return capture


def publish_excerpt_capture(
    db: Session,
    *,
    revision_id: str,
    payload: XArticleExcerptCapture,
    fragment: WebArticlePreparedFragment,
) -> XPostCapture:
    source = _post_identity(db, revision_id=revision_id, post=None)
    return _publish_capture(
        db,
        source=source,
        revision_id=revision_id,
        payload=payload,
        fragment=fragment,
        captured_at=datetime.now(UTC),
        contexts=(),
    )


def publish_acquired_captures(db: Session, *, prepared: PreparedXSource) -> dict[str, XPostCapture]:
    """Publish validated primary evidence and one hop of context, without any media."""
    by_revision = {item.source.source_revision_id: item for item in prepared.posts}
    identities = {
        revision: _post_identity(db, revision_id=revision, post=item.source)
        for revision, item in by_revision.items()
    }
    unavailable = {item.checked_revision_id: item for item in prepared.evidence.unavailable}
    captures: dict[str, XPostCapture] = {}
    pending = set(by_revision)
    while pending:
        eligible = [
            revision
            for revision in pending
            if not any(
                ref.target_revision_id in pending
                for ref in by_revision[revision].source.content.references
            )
        ]
        if not eligible:
            raise ConflictError(
                ApiErrorCode.E_X_SOURCE_CONFLICT, "provider post references form a cycle"
            )
        for revision in sorted(eligible, key=int):
            item = by_revision[revision]
            # XAcquiredSource requires timestamps for every new observation.
            assert item.source.body_captured_at is not None
            contexts = [
                CaptureContext(
                    ref.kind,
                    ref.target_revision_id,
                    captures[ref.target_revision_id].id
                    if ref.target_revision_id in captures
                    else None,
                    "captured"
                    if ref.target_revision_id in captures
                    else "unavailable"
                    if ref.target_revision_id in unavailable
                    else "not_captured",
                    ApiErrorCode.E_X_POST_UNAVAILABLE.value
                    if ref.target_revision_id in unavailable
                    else None,
                )
                for ref in item.source.content.references
            ]
            captures[revision] = _publish_capture(
                db,
                source=identities[revision],
                revision_id=revision,
                payload=XCompletePostCapture(kind="complete_post", content=item.source.content),
                fragment=item.fragment,
                captured_at=item.source.body_captured_at,
                contexts=contexts,
            )
            pending.remove(revision)
    for revision, observation in unavailable.items():
        alias = db.scalar(select(XPostAlias).where(XPostAlias.revision_id == revision))
        if alias is not None and (
            alias.checked_at is None or alias.checked_at < observation.checked_at
        ):
            alias.availability, alias.checked_at = "unavailable", observation.checked_at
    return captures


def publish_prepared_x_source(
    db: Session,
    *,
    media_id: UUID,
    source_attempt_id: UUID,
    viewer_id: UUID,
    request_id: str | None,
    prepared: PreparedXSource,
) -> SourceRunOutcome:
    del request_id
    evidence = prepared.evidence
    previously_readable = set(
        db.scalars(text(readable_x_capture_ids_sql()), {"viewer_id": viewer_id})
    )
    captures = publish_acquired_captures(db, prepared=prepared)
    driver_media_id = media_id
    if evidence.scope == "author_thread":
        primary_post_ids = {
            capture.post_id
            for revision, capture in captures.items()
            if revision in evidence.primary_revision_ids
        }
        holder_ids = set(
            db.scalars(
                select(XThreadPost.thread_media_id)
                .join(XPostCapture, XPostCapture.id == XThreadPost.capture_id)
                .where(XPostCapture.post_id.in_(primary_post_ids))
            )
        )
        holder_ids = {
            identity for identity in holder_ids if can_read_media(db, viewer_id, identity)
        }
        if len(holder_ids) > 1:
            raise _identity_conflict()
        if holder_ids:
            media_id = next(iter(holder_ids))
        if media_id != driver_media_id:
            driver = db.get(MediaSourceAttempt, source_attempt_id)
            assert driver is not None
            latest = sa.latest_attempt(db, media_id, lock=False)
            if latest is not None and latest.status in {"accepted", "queued", "running"}:
                raise ConflictError(
                    ApiErrorCode.E_SOURCE_IMPORT_ACTIVE, "another thread capture is in progress"
                )
            winner = db.get(Media, media_id)
            assert winner is not None
            source_attempt_id = sa.create_attempt(
                db,
                id=new_uuid7(),
                media=winner,
                actor_id=viewer_id,
                source_type="x_author_thread",
                requested_url=driver.requested_url,
                canonical_source_url=driver.canonical_source_url,
                provider="x",
                provider_target_ref=evidence.requested_revision_id,
                payload={"parent_source_attempt_id": str(driver.id)},
                status="succeeded",
            ).id
    media = db.get(Media, media_id)
    assert media is not None
    previous_selection = tuple(
        db.scalars(
            select(XThreadPost.capture_id)
            .where(XThreadPost.thread_media_id == media_id)
            .order_by(XThreadPost.ordinal)
            if evidence.scope == "author_thread"
            else select(XPostMedia.capture_id).where(XPostMedia.media_id == media_id)
        )
    )
    from nexus.services.consumption.reader_cursor import capture_x_cursor_remap, remap_x_cursors

    cursor_plan = capture_x_cursor_remap(db, media_ids=[media_id]) if previous_selection else ()
    if evidence.scope == "post":
        capture = captures[evidence.requested_revision_id]
        binding = db.scalar(select(XPostMedia).where(XPostMedia.post_id == capture.post_id))
        if binding is not None and binding.media_id != media_id:
            raise _identity_conflict()
        if binding is None:
            db.add(
                XPostMedia(
                    id=new_uuid7(),
                    media_id=media_id,
                    post_id=capture.post_id,
                    capture_id=capture.id,
                )
            )
        else:
            binding.capture_id = capture.id
        primary = [capture]
    else:
        selected = {
            capture.post_id: capture
            for revision, capture in captures.items()
            if revision in evidence.primary_revision_ids
        }
        old = list(
            db.scalars(
                select(XThreadPost)
                .where(XThreadPost.thread_media_id == media_id)
                .order_by(XThreadPost.ordinal)
            )
        )
        members = {}
        for member in old:
            capture = db.get(XPostCapture, member.capture_id)
            assert capture is not None
            members[capture.post_id] = member
            selected.setdefault(capture.post_id, capture)
        # Discovery owns the exact primary set; retained primaries preserve earlier coverage.
        sources = {
            row.id: row
            for row in db.scalars(select(XPostSource).where(XPostSource.id.in_(selected)))
        }
        if set(sources) != set(selected):
            raise ValueError("thread primary must retain its logical source")
        primary = sorted(
            selected.values(),
            key=lambda item: int(sources[item.post_id].logical_post_id or item.source_revision_id),
        )
        if old and list(members) != [capture.post_id for capture in primary]:
            # Move occupied ordinals aside before inserting or reordering members.
            db.execute(
                update(XThreadPost)
                .where(XThreadPost.thread_media_id == media_id)
                .values(ordinal=XThreadPost.ordinal + len(primary) + len(old))
            )
            db.flush()
        for ordinal, capture in enumerate(primary):
            if capture.post_id in members:
                members[capture.post_id].capture_id, members[capture.post_id].ordinal = (
                    capture.id,
                    ordinal,
                )
            else:
                db.add(
                    XThreadPost(
                        id=new_uuid7(),
                        thread_media_id=media_id,
                        capture_id=capture.id,
                        ordinal=ordinal,
                    )
                )
        source = db.scalar(select(XThreadSource).where(XThreadSource.media_id == media_id))
        now = datetime.now(UTC)
        if source is None:
            source = XThreadSource(id=new_uuid7(), media_id=media_id)
            db.add(source)
        elif source.author_id != evidence.author.id:
            raise _identity_conflict()
        source.source_attempt_id, source.author_id, source.published_at = (
            source_attempt_id,
            evidence.author.id,
            now,
        )
        source.root_capture_id = (
            captures[evidence.root_revision_id].id
            if evidence.root_revision_id in captures
            else source.root_capture_id
        )
        source.membership_checked_at = (
            now if evidence.coverage.search_exhausted is not None else source.membership_checked_at
        )
        source.coverage = evidence.coverage.model_dump(mode="json")
        reconcile_x_article_inspections(
            db, loser_id=driver_media_id, winner_id=media_id, observations=evidence.article_ids
        )
    posts = {item.source.source_revision_id: item.source for item in prepared.posts}
    first = primary[0]
    if first.source_revision_id in posts:
        media.title = post_label(posts[first.source_revision_id])
    media.description = "\n\n".join(
        XCompletePostCapture.model_validate_json(json.dumps(item.payload)).content.text
        for item in primary
    )[:2000]
    media.provider, media.provider_id, media.publisher, media.canonical_url = "x", None, "X", None
    media.canonical_source_url = canonical_x_post_url(first.source_revision_id)
    mark_ready_for_reading(db, media)
    db.flush()
    attempt = db.get(MediaSourceAttempt, source_attempt_id)
    assert attempt is not None
    attempt.finished_at = datetime.now(UTC)
    created_publication = ensure_reader_publication(db, media_id=media_id)
    if not created_publication and previous_selection != tuple(item.id for item in primary):
        remap_x_cursors(db, snapshots=cursor_plan)
        advance_reader_publications(db, media_ids=[media_id])
    from nexus.services.resource_grants import (
        extend_public_media_capture_manifests,
        media_audience_account_ids,
    )

    selected_manifest = capture_manifest(db, capture_ids=[item.id for item in primary])
    fresh_manifest = capture_manifest(
        db,
        capture_ids=[
            capture.id
            for revision, capture in captures.items()
            if revision in evidence.primary_revision_ids
        ],
    )
    authorized_manifest = sorted(selected_manifest & (previously_readable | fresh_manifest))
    if not {item.id for item in primary} <= set(authorized_manifest):
        raise ValueError("thread publication cannot admit an unseen retained primary")
    accounts = media_audience_account_ids(db, media_ids=[media_id])
    admit_x_captures_for_accounts(
        db,
        account_ids=[viewer_id, *accounts],
        capture_ids=authorized_manifest,
    )
    extend_public_media_capture_manifests(db, media_id=media_id, capture_ids=authorized_manifest)
    projection.refresh(db, "media", [media_id])
    author = evidence.author
    credits, _truncated = taxonomy.build_observation(
        {
            "author": [
                taxonomy.RawCreditEntry(
                    credited_name=author.name,
                    identity_claims=(taxonomy.RawIdentityClaim("x_user", author.id),),
                )
            ]
        }
    )
    return SourceRunOutcome(
        diagnostics={
            "processing_status": "ready_for_reading",
            "ingest_enqueued": False,
            "idempotency_outcome": "refreshed",
        },
        reindex_media=False,
        observations=source_contributor_observations(
            media_id=media_id,
            observation=credits,
            source="x_api_author_thread" if evidence.scope == "author_thread" else "x_api_post",
        ),
        metadata_enrichment=True,
        superseded_by_media_id=media_id if media_id != driver_media_id else None,
    )
