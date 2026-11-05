"""Exact saved-source identity for extension acquisition and native article discovery.

Lookup reserves nothing. Admission repeats the same lookup under the source lock,
then locks the chosen media and checks the frozen latest attempt. Browser bytes
never choose a different media. Article identity includes verified captured copies;
native child admission must refuse incompatible copies rather than duplicate them.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import exists, or_, select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import (
    Media,
    MediaSourceAttempt,
    MediaTeardownIntent,
    MediaUploadSession,
    XArticleInspection,
)
from nexus.db.session import get_repeatable_read_db
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError
from nexus.schemas.acquisition import SourceTarget
from nexus.schemas.extension_capture import (
    BrowserSource,
    SaveSource,
    SaveTargetOut,
    XStatusSource,
)
from nexus.schemas.x_source import XPriorSource
from nexus.services import media_locks
from nexus.services import source_attempts as sa
from nexus.services import source_types as st
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.services.x_identity import (
    classify_x_article_carrier_url,
    classify_x_article_url,
    classify_x_url,
    is_x_url,
    native_x_article_id,
    x_article_provider_id,
)
from nexus.services.x_source import x_thread_matches


def article_candidates(db: Session, article_id: str) -> list[Media]:
    """All live holders of a verified article identity, independent of visibility."""
    captured = select(MediaSourceAttempt.media_id).where(
        MediaSourceAttempt.source_type == st.BROWSER_ARTICLE_CAPTURE,
        MediaSourceAttempt.source_payload["source_binding"]["x_article_id"].astext == article_id,
    )
    captured_sessions = select(MediaUploadSession.published_media_id).where(
        MediaUploadSession.input_origin["source_binding"]["x_article_id"].astext == article_id,
    )
    return list(
        db.scalars(
            select(Media).where(
                Media.kind == "web_article",
                or_(
                    (Media.provider == "x")
                    & (Media.provider_id == x_article_provider_id(article_id)),
                    Media.id.in_(captured),
                    Media.id.in_(captured_sessions),
                ),
                ~exists().where(MediaTeardownIntent.media_id == Media.id),
            )
        )
    )


def carrier_article_id(db: Session, *, viewer_id: UUID, carrier_id: str) -> str | None:
    ids = {
        article_id
        for thread_id, article_id in db.execute(
            select(XArticleInspection.thread_media_id, XArticleInspection.article_id).where(
                XArticleInspection.carrier_post_id == carrier_id,
                XArticleInspection.article_id.is_not(None),
            )
        ).tuples()
        if can_read_media(db, viewer_id, thread_id)
    }
    for media, _attempt in db.execute(
        select(Media, MediaSourceAttempt)
        .join(MediaSourceAttempt, MediaSourceAttempt.media_id == Media.id)
        .where(
            MediaSourceAttempt.source_type.in_((st.X_ARTICLE, st.BROWSER_ARTICLE_CAPTURE)),
            MediaSourceAttempt.provider_target_ref == carrier_id,
        )
    ).tuples():
        if can_read_media(db, viewer_id, media.id):
            article_id = native_x_article_id(
                kind=media.kind, provider=media.provider, provider_id=media.provider_id
            )
            if article_id is not None:
                ids.add(article_id)
    if len(ids) > 1:
        raise changed_target()
    return next(iter(ids), None)


def source_for_url(source_url: str, *, x_article_id: str | None = None) -> SaveSource:
    validate_requested_url(source_url)
    if (post := classify_x_url(source_url)) is not None:
        if x_article_id is not None:
            raise changed_target()
        return XStatusSource(revision_id=post.provider_id)
    article_id = classify_x_article_url(source_url)
    carrier_id = classify_x_article_carrier_url(source_url)
    if article_id is not None:
        if x_article_id not in (None, article_id):
            raise changed_target()
        return BrowserSource(x_article_id=article_id)
    if carrier_id is not None:
        if x_article_id is None:
            raise changed_target()
        return BrowserSource(x_article_id=x_article_id)
    if x_article_id is not None or is_x_url(source_url):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Open an X post or article.")
    return BrowserSource(x_article_id=None)


def matching_media(
    db: Session, *, viewer_id: UUID, source_url: str, source: SaveSource
) -> Media | None:
    visible_ids = set(db.scalars(text(visible_media_ids_cte_sql()), {"viewer_id": viewer_id}))
    if isinstance(source, XStatusSource):
        matches = x_thread_matches(db, viewer_id=viewer_id, revision_ids=(source.revision_id,))[
            source.revision_id
        ]
        ids = matches.primary_holders + matches.unpublished_attempts
        candidates = list(db.scalars(select(Media).where(Media.id.in_(ids))))
    elif source.x_article_id is not None:
        candidates = article_candidates(db, source.x_article_id)
    else:
        url = normalize_url_for_display(source_url)
        media_by_id = {
            media.id: media
            for media in db.scalars(
                select(Media).where(
                    Media.kind.in_(("web_article", "pdf", "epub")),
                    Media.id.in_(visible_ids),
                    ~exists().where(MediaTeardownIntent.media_id == Media.id),
                )
            )
        }
        provenance = {
            media.id: [media.requested_url, media.canonical_source_url, media.canonical_url]
            for media in media_by_id.values()
        }
        for media_id, requested, canonical in db.execute(
            select(
                MediaSourceAttempt.media_id,
                MediaSourceAttempt.requested_url,
                MediaSourceAttempt.canonical_source_url,
            ).where(MediaSourceAttempt.media_id.in_(media_by_id))
        ).tuples():
            provenance[media_id].extend((requested, canonical))
        for media_id, captured_url in db.execute(
            select(
                MediaUploadSession.published_media_id,
                MediaUploadSession.input_origin["source_url"].astext,
            ).where(MediaUploadSession.published_media_id.in_(media_by_id))
        ).tuples():
            assert media_id is not None  # the membership predicate excludes null
            provenance[media_id].append(captured_url)
        candidates = [
            media_by_id[media_id]
            for media_id, urls in provenance.items()
            if any(value and normalize_url_for_display(value) == url for value in urls)
        ]
    visible = [media for media in candidates if media.id in visible_ids]
    if len(visible) > 1:
        raise ConflictError(
            ApiErrorCode.E_SOURCE_TARGET_AMBIGUOUS, "Several saved items have this source."
        )
    return visible[0] if visible else None


def changed_target() -> ConflictError:
    return ConflictError(ApiErrorCode.E_CAPTURE_TARGET_CHANGED, "The saved source changed.")


def lock_target(
    db: Session,
    *,
    viewer_id: UUID,
    source_url: str,
    source: SaveSource,
    target: SourceTarget | None,
    kind: str,
) -> Media | None:
    """Source identity before media; the caller already owns the viewer lock."""
    if isinstance(source, XStatusSource):
        sa.lock_identity(db, f"x-post:{source.revision_id}")
    elif source.x_article_id is not None:
        if kind != "web_article":
            raise changed_target()
        carrier = classify_x_article_carrier_url(source_url)
        if carrier is not None:
            sa.lock_identity(db, f"x-article-carrier:{carrier}")
        sa.lock_identity(db, f"x-article:{x_article_provider_id(source.x_article_id)}")
        if carrier is not None:
            observed = carrier_article_id(db, viewer_id=viewer_id, carrier_id=carrier)
            if observed is not None and observed != source.x_article_id:
                raise changed_target()
        if target is None and article_candidates(db, source.x_article_id):
            raise changed_target()
    else:
        sa.lock_identity(db, f"web:{normalize_url_for_display(source_url)}")
    media = matching_media(db, viewer_id=viewer_id, source_url=source_url, source=source)
    if target is None:
        if media is not None:
            raise changed_target()
        return None
    if media is None or media.id != target.media_id or media.kind != kind:
        raise changed_target()
    media_locks.lock_media_rows_in_order(db, [media.id])
    db.refresh(media)
    latest = sa.latest_attempt(db, media.id, lock=False)
    if (
        latest is None
        or latest.id != target.expected_source_attempt_id
        or media.created_by_user_id != viewer_id
        or not can_read_media(db, viewer_id, media.id)
    ):
        raise changed_target()
    from nexus.services.media_parts import require_unpinned_source
    from nexus.services.media_source_ingest import require_unpublished_document

    require_unpinned_source(db, media_id=media.id)
    require_unpublished_document(db, media)
    return media


def save_target(db: Session, *, viewer_id: UUID, source_url: str) -> SaveTargetOut:
    """Resolve before extraction; only an unknown article carrier requires provider I/O."""
    from nexus.services.media import get_extension_item

    db.commit()
    get_repeatable_read_db(db)
    article_id = classify_x_article_url(source_url)
    carrier_id = classify_x_article_carrier_url(source_url)
    if carrier_id is not None:
        article_id = carrier_article_id(db, viewer_id=viewer_id, carrier_id=carrier_id)
        if article_id is None:
            db.rollback()
            from nexus.services.x_client import lookup_x_carrier

            carrier = lookup_x_carrier(requested_revision_id=carrier_id, prior=XPriorSource())
            if carrier.source_revision_id != carrier_id or carrier.article_id is None:
                raise changed_target()
            article_id = carrier.article_id
            get_repeatable_read_db(db)
            observed = carrier_article_id(db, viewer_id=viewer_id, carrier_id=carrier_id)
            if observed is not None and observed != article_id:
                raise changed_target()
    source = source_for_url(source_url, x_article_id=article_id)
    media = matching_media(db, viewer_id=viewer_id, source_url=source_url, source=source)
    item = get_extension_item(db, viewer_id=viewer_id, media_id=media.id) if media else None
    if item is not None and not item.has_readable_copy and item.source_attempt is None:
        raise InvalidRequestError(ApiErrorCode.E_SOURCE_INTEGRITY, "Saved source has no attempt.")
    target = (
        SourceTarget(
            media_id=media.id,
            expected_source_attempt_id=item.source_attempt.id if item.source_attempt else None,
        )
        if media is not None and item is not None
        else None
    )
    revision = db.execute(
        text("SELECT removal_revision FROM users WHERE id=:id"), {"id": viewer_id}
    ).scalar_one()
    return SaveTargetOut(
        source=source, target=target, item=item, expected_removal_revision=str(revision)
    )
