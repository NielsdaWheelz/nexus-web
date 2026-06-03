"""X URL ingest ownership."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.models import Fragment, Media, MediaKind, ProcessingStatus
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.media import FromUrlResponse
from nexus.services import libraries as libraries_service
from nexus.services.content_indexing import delete_media_content_index
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.fragment_blocks import FragmentBlockSpec, insert_fragment_blocks
from nexus.services.media_processing_state import mark_ready_for_reading, reset_for_reingest
from nexus.services.url_normalize import validate_requested_url
from nexus.services.web_article_indexing import rebuild_web_article_index_or_mark_failed
from nexus.services.web_article_structure import (
    WEB_ARTICLE_HTML_MAX_BYTES,
    prepare_web_article_fragment,
)
from nexus.services.x_api import (
    XAuthorThreadSnapshot,
    XPostSnapshot,
    canonical_x_post_url,
    fetch_author_thread_snapshot,
    post_description,
    post_title,
    render_author_thread_fragment_html,
    render_single_post_html,
    thread_description,
    thread_title,
    x_author_thread_provider_id,
)
from nexus.services.x_identity import classify_x_url

logger = get_logger(__name__)


@dataclass(frozen=True)
class _PreparedXFragment:
    fragment: Fragment
    fragment_blocks: list[FragmentBlockSpec]


@dataclass(frozen=True)
class _WebArticleIndexTarget:
    media_id: UUID
    fragment_id: UUID
    fragments: list[Fragment]
    reason: str
    language: str | None


def create_or_reuse_x_author_thread_article(
    db: Session,
    viewer_id: UUID,
    url: str,
    *,
    library_ids: list[UUID],
) -> FromUrlResponse:
    """Create or reuse an archival same-author X thread snapshot."""
    validate_requested_url(url)
    identity = classify_x_url(url)
    if identity is None:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL is not a supported X post URL",
        )

    provider_id = x_author_thread_provider_id(identity.provider_id)
    media = (
        db.query(Media)
        .filter(Media.provider == identity.provider, Media.provider_id == provider_id)
        .limit(1)
        .one_or_none()
    )
    if media is not None:
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        db.commit()
        return FromUrlResponse(
            media_id=media.id,
            idempotency_outcome="reused",
            processing_status=_status_to_str(media.processing_status),
            ingest_enqueued=False,
        )

    snapshot = fetch_author_thread_snapshot(
        identity.provider_id,
        username_hint=identity.username,
    )
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")

    now = datetime.now(UTC)
    created_index_targets: list[_WebArticleIndexTarget] = []
    quoted_media_ids: dict[str, UUID] = {}
    for quoted_id, quoted_post in snapshot.quoted_posts.items():
        quote_media, quote_fragment, quote_created = _create_or_reuse_x_snapshot_post_media(
            db,
            viewer_id,
            post=quoted_post,
            snapshot=snapshot,
            library_ids=library_ids,
            now=now,
        )
        quoted_media_ids[quoted_id] = quote_media.id
        if quote_created and quote_fragment is not None:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=quote_media.id,
                    fragment_id=quote_fragment.fragment.id,
                    fragments=[quote_fragment.fragment],
                    reason="x_api_quoted_post",
                    language=quote_media.language,
                )
            )

    prepared_fragments: list[_PreparedXFragment] = []
    for idx, (post, fragment_html) in enumerate(
        render_author_thread_fragment_html(
            snapshot,
            quoted_media_ids=quoted_media_ids,
            app_public_url=get_settings().app_public_url,
        )
    ):
        prepared_fragments.append(
            _build_x_fragment(
                media_id=None,
                idx=idx,
                html=fragment_html,
                base_url=post.permalink,
                created_at=now,
            )
        )

    fragments = [prepared.fragment for prepared in prepared_fragments]
    if not "\n\n".join(fragment.canonical_text for fragment in fragments).strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X thread has no readable text")

    media = Media(
        kind=MediaKind.web_article.value,
        title=thread_title(snapshot)[:255],
        requested_url=url,
        canonical_url=None,
        canonical_source_url=identity.canonical_url,
        provider=identity.provider,
        provider_id=provider_id,
        processing_status=ProcessingStatus.ready_for_reading,
        processing_completed_at=now,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        publisher="X",
        description=thread_description(snapshot),
    )

    created = False
    try:
        db.add(media)
        db.flush()
        created = True
        for prepared_fragment in prepared_fragments:
            prepared_fragment.fragment.media_id = media.id
            db.add(prepared_fragment.fragment)
        db.flush()
        for prepared_fragment in prepared_fragments:
            insert_fragment_blocks(
                db,
                prepared_fragment.fragment.id,
                prepared_fragment.fragment_blocks,
            )
        replace_media_contributor_credits(
            db,
            media_id=media.id,
            credits=[
                {
                    "name": snapshot.author.name[:255],
                    "handle": snapshot.author.username[:255],
                    "role": "author",
                    "source": "x_api_author_thread",
                    "source_ref": {"media_id": str(media.id), "x_user_id": snapshot.author.id},
                }
            ],
        )
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        db.commit()
    except IntegrityError as exc:
        if not _is_media_provider_conflict(exc):
            db.rollback()
            raise
        db.rollback()
        created = False
        media = (
            db.query(Media)
            .filter(Media.provider == identity.provider, Media.provider_id == provider_id)
            .limit(1)
            .one_or_none()
        )
        if media is None:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Unable to resolve canonical X thread") from exc
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        db.commit()
    except Exception:
        db.rollback()
        raise

    if created:
        fragment_ids = [fragment.id for fragment in fragments]
        if fragment_ids:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=media.id,
                    fragment_id=fragment_ids[0],
                    fragments=fragments,
                    reason="x_api_author_thread",
                    language=media.language,
                )
            )
        for target in created_index_targets:
            rebuild_web_article_index_or_mark_failed(
                db,
                media_id=target.media_id,
                fragment_id=target.fragment_id,
                fragments=target.fragments,
                reason=target.reason,
                language=target.language,
                log_event=f"{target.reason}_content_index_failed",
            )
            _try_enrich_dispatch(db, str(target.media_id), None)

    return FromUrlResponse(
        media_id=media.id,
        idempotency_outcome="created" if created else "reused",
        processing_status=ProcessingStatus.ready_for_reading.value,
        ingest_enqueued=False,
    )


def maybe_refresh_x_author_thread_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media: Media,
    request_id: str | None,
) -> dict[str, object] | None:
    identity = _x_refresh_identity(media)
    if identity is None:
        return None
    post_id, username_hint = identity
    return _refresh_x_author_thread_media_for_viewer(
        db,
        viewer_id,
        media=media,
        post_id=post_id,
        username_hint=username_hint,
        request_id=request_id,
    )


def _x_refresh_identity(media: Media) -> tuple[str, str | None] | None:
    username_hint = _x_username_hint(media)
    if media.provider == "x":
        provider_id = str(media.provider_id or "").strip()
        if provider_id.startswith("thread:"):
            post_id = provider_id.removeprefix("thread:")
            if post_id:
                return post_id, username_hint
        elif provider_id:
            return provider_id, username_hint

    for candidate_url in (media.requested_url, media.canonical_source_url, media.canonical_url):
        if not candidate_url:
            continue
        identity = classify_x_url(candidate_url)
        if identity is not None:
            return identity.provider_id, identity.username
    return None


def _x_username_hint(media: Media) -> str | None:
    for candidate_url in (media.requested_url, media.canonical_source_url, media.canonical_url):
        if not candidate_url:
            continue
        identity = classify_x_url(candidate_url)
        if identity is not None and identity.username:
            return identity.username
    return None


def _refresh_x_author_thread_media_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media: Media,
    post_id: str,
    username_hint: str | None,
    request_id: str | None,
) -> dict[str, object]:
    provider_id = x_author_thread_provider_id(post_id)
    existing_thread_media = (
        db.query(Media)
        .filter(Media.provider == "x", Media.provider_id == provider_id, Media.id != media.id)
        .limit(1)
        .one_or_none()
    )
    source_library_ids = _attached_library_ids(db, media.id)
    if existing_thread_media is not None:
        libraries_service.assign_libraries_for_media(
            db,
            viewer_id,
            existing_thread_media.id,
            source_library_ids,
        )
        db.commit()
        return {
            "media_id": str(existing_thread_media.id),
            "processing_status": _status_to_str(existing_thread_media.processing_status),
            "refresh_enqueued": False,
            "idempotency_outcome": "reused",
        }

    snapshot = fetch_author_thread_snapshot(post_id, username_hint=username_hint)
    if not snapshot.posts:
        raise ApiError(ApiErrorCode.E_INGEST_FAILED, "X API returned no thread posts.")

    now = datetime.now(UTC)
    created_index_targets: list[_WebArticleIndexTarget] = []
    quoted_media_ids: dict[str, UUID] = {}
    for quoted_id, quoted_post in snapshot.quoted_posts.items():
        quote_media, quote_fragment, quote_created = _create_or_reuse_x_snapshot_post_media(
            db,
            viewer_id,
            post=quoted_post,
            snapshot=snapshot,
            library_ids=source_library_ids,
            now=now,
        )
        quoted_media_ids[quoted_id] = quote_media.id
        if quote_created and quote_fragment is not None:
            created_index_targets.append(
                _WebArticleIndexTarget(
                    media_id=quote_media.id,
                    fragment_id=quote_fragment.fragment.id,
                    fragments=[quote_fragment.fragment],
                    reason="x_api_quoted_post",
                    language=quote_media.language,
                )
            )

    prepared_fragments: list[_PreparedXFragment] = []
    for idx, (post, fragment_html) in enumerate(
        render_author_thread_fragment_html(
            snapshot,
            quoted_media_ids=quoted_media_ids,
            app_public_url=get_settings().app_public_url,
        )
    ):
        prepared_fragments.append(
            _build_x_fragment(
                media_id=media.id,
                idx=idx,
                html=fragment_html,
                base_url=post.permalink,
                created_at=now,
            )
        )

    fragments = [prepared.fragment for prepared in prepared_fragments]
    if not "\n\n".join(fragment.canonical_text for fragment in fragments).strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X thread has no readable text")

    _delete_web_article_refresh_artifacts(db, media.id)
    reset_for_reingest(db, media)
    media.title = thread_title(snapshot)[:255]
    media.canonical_url = None
    media.canonical_source_url = canonical_x_post_url(snapshot.root_post_id)
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
    replace_media_contributor_credits(
        db,
        media_id=media.id,
        credits=[
            {
                "name": snapshot.author.name[:255],
                "handle": snapshot.author.username[:255],
                "role": "author",
                "source": "x_api_author_thread",
                "source_ref": {"media_id": str(media.id), "x_user_id": snapshot.author.id},
            }
        ],
    )
    mark_ready_for_reading(db, media)
    db.commit()

    created_index_targets.append(
        _WebArticleIndexTarget(
            media_id=media.id,
            fragment_id=fragments[0].id,
            fragments=fragments,
            reason="x_api_author_thread_refresh",
            language=media.language,
        )
    )
    for target in created_index_targets:
        rebuild_web_article_index_or_mark_failed(
            db,
            media_id=target.media_id,
            fragment_id=target.fragment_id,
            fragments=target.fragments,
            reason=target.reason,
            language=target.language,
            log_event=f"{target.reason}_content_index_failed",
        )
        _try_enrich_dispatch(db, str(target.media_id), request_id)

    return {
        "media_id": str(media.id),
        "processing_status": ProcessingStatus.ready_for_reading.value,
        "refresh_enqueued": False,
        "idempotency_outcome": "refreshed",
    }


def _attached_library_ids(db: Session, media_id: UUID) -> list[UUID]:
    return [
        UUID(str(row[0]))
        for row in db.execute(
            text("SELECT library_id FROM library_entries WHERE media_id = :media_id"),
            {"media_id": media_id},
        ).fetchall()
    ]


def _delete_web_article_refresh_artifacts(db: Session, media_id: UUID) -> None:
    delete_media_content_index(db, media_id=media_id)
    db.execute(
        text(
            """
            DELETE FROM highlights AS h
            USING highlight_fragment_anchors AS hfa
            JOIN fragments AS f ON f.id = hfa.fragment_id
            WHERE h.id = hfa.highlight_id
              AND f.media_id = :media_id
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM fragment_blocks
            WHERE fragment_id IN (
                SELECT id
                FROM fragments
                WHERE media_id = :media_id
            )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(text("DELETE FROM fragments WHERE media_id = :media_id"), {"media_id": media_id})
    db.execute(
        text("DELETE FROM contributor_credits WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.flush()


def _create_or_reuse_x_snapshot_post_media(
    db: Session,
    viewer_id: UUID,
    *,
    post: XPostSnapshot,
    snapshot: XAuthorThreadSnapshot,
    library_ids: list[UUID],
    now: datetime,
) -> tuple[Media, _PreparedXFragment | None, bool]:
    media = (
        db.query(Media)
        .filter(Media.provider == "x", Media.provider_id == post.id)
        .limit(1)
        .one_or_none()
    )
    if media is not None:
        libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
        return media, None, False

    prepared_fragment = _build_x_fragment(
        media_id=None,
        idx=0,
        html=render_single_post_html(post, users=snapshot.users, media=snapshot.media),
        base_url=canonical_x_post_url(post.id),
        created_at=now,
    )
    media = Media(
        kind=MediaKind.web_article.value,
        title=post_title(post, snapshot.users)[:255],
        requested_url=canonical_x_post_url(post.id),
        canonical_url=canonical_x_post_url(post.id),
        canonical_source_url=canonical_x_post_url(post.id),
        provider="x",
        provider_id=post.id,
        processing_status=ProcessingStatus.ready_for_reading,
        processing_completed_at=now,
        created_by_user_id=viewer_id,
        created_at=now,
        updated_at=now,
        publisher="X",
        description=post_description(post),
    )
    db.add(media)
    db.flush()
    prepared_fragment.fragment.media_id = media.id
    db.add(prepared_fragment.fragment)
    db.flush()
    insert_fragment_blocks(
        db,
        prepared_fragment.fragment.id,
        prepared_fragment.fragment_blocks,
    )
    author = snapshot.users.get(post.author_id)
    if author is not None:
        replace_media_contributor_credits(
            db,
            media_id=media.id,
            credits=[
                {
                    "name": author.name[:255],
                    "handle": author.username[:255],
                    "role": "author",
                    "source": "x_api_quoted_post",
                    "source_ref": {"media_id": str(media.id), "x_user_id": author.id},
                }
            ],
        )
    libraries_service.assign_libraries_for_media(db, viewer_id, media.id, library_ids)
    return media, prepared_fragment, True


def _build_x_fragment(
    *,
    media_id: UUID | None,
    idx: int,
    html: str,
    base_url: str,
    created_at: datetime,
) -> _PreparedXFragment:
    if len(html.encode("utf-8")) > WEB_ARTICLE_HTML_MAX_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "X thread HTML is too large")
    try:
        prepared = prepare_web_article_fragment(
            html=html,
            base_url=base_url,
            fragment_idx=idx,
            media_title=None,
        )
    except ValueError as exc:
        raise ApiError(
            ApiErrorCode.E_SANITIZATION_FAILED, "X thread could not be sanitized"
        ) from exc
    canonical_text = prepared.canonical_text
    if not canonical_text.strip():
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "X post has no readable text")
    fragment = Fragment(
        media_id=media_id,
        idx=idx,
        html_sanitized=prepared.html_sanitized,
        canonical_text=canonical_text,
        created_at=created_at,
    )
    return _PreparedXFragment(fragment=fragment, fragment_blocks=prepared.fragment_blocks)


def _try_enrich_dispatch(
    db: Session,
    media_id: str,
    request_id: str | None,
) -> None:
    try:
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload={"media_id": media_id, "request_id": request_id},
            max_attempts=1,
        )
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.warning("enrich_metadata_dispatch_failed", media_id=media_id)


def _status_to_str(value: object) -> str:
    if isinstance(value, str):
        return value
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, str):
        return enum_value
    return str(value)


def _is_media_provider_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uix_media_x_provider_id"
    return "uix_media_x_provider_id" in str(exc)
